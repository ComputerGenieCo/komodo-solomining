var util = require('./util.js'); // Ensure util.js is required for reverseEndianness

module.exports = function(daemon, emitErrorLog, emitWarningLog, emitLog) {
    function DetectCoinData(options, finishedCallback) {
        var batchRpcCalls = [
            ['validateaddress', [options.address]],
            ['getdifficulty', []],
            ['getinfo', []],
            ['getmininginfo', []]
        ];
        daemon.batchCmd(batchRpcCalls, function(error, results) {
            if (error || !results) {
                emitErrorLog('Could not start pool, error with init batch RPC call: ' + JSON.stringify(error));
                return;
            }
            var rpcResults = {};
            for (var i = 0; i < results.length; i++) {
                var rpcCall = batchRpcCalls[i][0];
                var r = results[i];
                rpcResults[rpcCall] = r.result || r.error;
                if (r.error || !r.result) {
                    emitErrorLog('Could not start pool, error with init RPC ' + rpcCall + ' - ' + JSON.stringify(r.error));
                    return;
                }
            }
            if (!rpcResults.validateaddress.isvalid) {
                emitErrorLog('Daemon reports address is not valid');
                return;
            }
            if (rpcResults.getinfo.staked) {
                options.coin.reward = 'POS';
            } else {
                options.coin.reward = 'POW';
            }
            emitWarningLog(`This coin is ${options.coin.reward}\t\t\t`);
            options.poolAddressScript = (() => { return util.addressToScript(rpcResults.validateaddress.address); })();
            options.testnet = rpcResults.getinfo.testnet;
            options.protocolVersion = rpcResults.getinfo.protocolversion;
            options.initStats = {
                connections: rpcResults.getinfo.connections,
                difficulty: rpcResults.getinfo.difficulty,
                networkHashRate: rpcResults.getmininginfo.networkhashps
            };
            finishedCallback();
        });
    }

    const GetBlockTemplate = (jobManager, varDiff, callback) => {
        const getRawTransaction = (template) => {
            template.miner = parseFloat(template.coinbasetxn.coinbasevalue / Math.pow(10, 8)).toFixed(8);
            daemon.cmd('decoderawtransaction',
                [template.coinbasetxn.data],
                async (result) => {
                    if (result.error) {
                        emitErrorLog(`decoderawtransaction call failed for daemon instance ${result.instance.index} with error ${JSON.stringify(result.error)}`);
                        callback(result.error);
                    } else {
                        template.vouts = result.response.vout;
                        let processedNewBlock = await jobManager.processTemplate(template);
                        callback(null, template, processedNewBlock);
                        callback = () => {};
                        if (processedNewBlock && varDiff) {
                            Object.keys(varDiff).forEach((port) => { varDiff[port].setNetworkDifficulty(jobManager.currentJob.difficulty) });
                        }
                    };
                }, true);
        };

        const getBlockTemplateAndRawCoinbase = () => {
            let isRrDefined = (rRthing) => (typeof(rRthing) !== 'undefined' && typeof(rRthing) !== 'null');
            daemon.cmd('getblocktemplate',
                [{ "capabilities": ["coinbasetxn", "workid", "coinbase/append"] }],
                (result) => {
                    if (result.error) {
                        emitErrorLog(`getblocktemplate call failed for daemon instance ${result.instance.index} with error ${JSON.stringify(result.error)}`);
                        callback(result.error);
                    } else if (!isRrDefined(result[0].response) || !isRrDefined(result[0].response.coinbasetxn)) {
                        emitErrorLog(`getblocktemplate call failed for daemon with error: ${JSON.stringify(result)}`);
                        getBlockTemplateAndRawCoinbase();
                    } else {
                        getRawTransaction(result[0].response);
                    }
                });
        };
        getBlockTemplateAndRawCoinbase();
    };

    return {
        SubmitBlock: function(blockHex, callback) {
            daemon.cmd('submitblock', [blockHex], function(results) {
                for (var i = 0; i < results.length; i++) {
                    var result = results[i];
                    var nodeID = result.instance.index;
                    if (result.error) {
                        emitErrorLog('rpc error with daemon instance ' + nodeID + ' when submitting block: ' + JSON.stringify(result.error));
                        return;
                    } else if (result.response !== null) {
                        var msgReason;
                        switch(result.response) {
                            case 'duplicate':
                                msgReason = ' - node already has valid copy of block.';
                                break;
                            case 'duplicate-invalid':
                                msgReason = ' - node already has block, but it is invalid.';
                                break;
                            case 'duplicate-inconclusive':
                                msgReason = ' - node already has block but has not validated it (check time & daemon logs).';
                                break;
                            case 'inconclusive':
                                msgReason = ' - node has not validated the block, it may not be on the node\'s current best chain (likely lost a race).';
                                break;
                            case 'rejected':
                                msgReason = ' - block was rejected as invalid.';
                                break;
                            default:
                                msgReason = ' Daemon has responded with something it shouldn\'t: ' + result.response;
                                break;
                        }
                        emitErrorLog('rpc error with daemon instance ' + nodeID + ' when submitting block ' + msgReason );
                        return;
                    }
                }
                emitWarningLog('Successfully submitted block to daemon instance(s).');
                callback();
            });
        },

        CheckBlockAccepted: function(blockHash, callback) {
            const shouldReverseHex = (hexString) => {
                return hexString.endsWith('0000');
            };

            if (shouldReverseHex(blockHash)) {
                blockHash = util.reverseEndianness(blockHash);
            }

            setTimeout(() => {
                daemon.cmd('getblock', [blockHash], (results) => {
                    var validResults = results.filter((result) => result.response && result.response.hash === blockHash);
                    if (validResults.length >= 1) {
                        emitWarningLog(`CheckBlockAccepted: ${validResults[0].response.height} accepted as: ${validResults[0].response.hash}`);
                        callback(true, validResults[0].response.tx[0]);
                    } else {
                        var errorResult = results.find((result) => result.error);
                        if (errorResult) {
                            emitErrorLog(`CheckBlockAccepted: ${errorResult.error.message}`);
                        } else {
                            emitErrorLog(`CheckBlockAccepted: No valid results found. Something's feked; we shouldn't get here!!!`);
                        }
                        callback(false);
                    }
                });
            }, 500);
        },

        OnBlockchainSynced: function(syncedCallback) {
            const checkSynced = function(displayNotSynced) {
                daemon.cmd('getblocktemplate', [], function(results) {
                    var synced = results.every(function(r) { return !r.error || r.error.code !== -10; });
                    if (synced) {
                        emitWarningLog('Blockchain is synced with network - starting server');
                        syncedCallback();
                    } else {
                        if (displayNotSynced) { displayNotSynced(); }
                        setTimeout(checkSynced, 5000);
                        // Only let the first fork show synced status or the log will look flooded with it
                        if (!process.env.forkId || process.env.forkId === '0') { generateProgress(); }
                    }
                });
            };

            const generateProgress = () => {
                daemon.cmd('getinfo', [], function(results) {
                    var blockCount = results.sort(function(a, b) { return b.response.blocks - a.response.blocks; })[0].response.blocks;

                    // Get list of peers and their highest block height to compare to ours
                    daemon.cmd('getpeerinfo', [], function(results) {
                        var peers = results[0].response;
                        var totalBlocks = peers.sort(function(a, b) {
                            return b.startingheight - a.startingheight;
                        })[0].startingheight;

                        var percent = (blockCount / totalBlocks * 100).toFixed(2);
                        emitWarningLog('Downloaded ' + percent + '% of blockchain from ' + peers.length + ' peers');
                    });
                });
            };

            checkSynced(() => {
                // Only let the first fork show synced status or the log will look flooded with it
                if (!process.env.forkId || process.env.forkId === '0') {
                    emitErrorLog('Daemon is still syncing with network (download blockchain) - server will be started once synced');
                }
            });
        },

        SetupBlockPolling: function(options, GetBlockTemplate) {
            if (typeof options.blockRefreshInterval !== "number" || options.blockRefreshInterval <= 0) {
                emitLog('Block template polling has been disabled', process.env.forkId);
                return;
            }
            var pollingInterval = options.blockRefreshInterval;
            setInterval(() => {
                GetBlockTemplate((error, result, foundNewBlock) => {
                    if (foundNewBlock) {
                        if (!process.env.forkId || process.env.forkId === '0') {
                            emitLog(`Notification via RPC polling: ${options.coin.name} blockchain has advanced to ${(result.height) -1};${''
                            } we're now working on ${result.height}`); //we use -1 here since we're printing after the new process
                        }
                    } else {
                        //emitLog('No new block found', process.env.forkId);
                    }
                });
            }, pollingInterval * 1000);
        },

        GetBlockTemplate,
        DetectCoinData
    };
};
