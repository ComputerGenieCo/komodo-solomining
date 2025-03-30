const util = require('../helpers/util.js'); // Ensure helpers/util.js is required for reverseEndianness

module.exports = (daemon, emitErrorLog, emitWarningLog, emitLog) => {
    /**
     * Checks if a block has been accepted by the daemon.
     * @param {string} blockHash - The block hash string.
     * @param {Function} callback - The callback to execute when finished.
     */
    const CheckBlockAccepted = (blockHash, callback) => {
        const shouldReverseHex = (hexString) => hexString.endsWith('0000');

        if (shouldReverseHex(blockHash)) {
            blockHash = util.reverseEndianness(blockHash);
        }

        setTimeout(() => {
            daemon.cmd('getblock', [blockHash], (results) => {
                const validResults = results.filter((result) => result.response && result.response.hash === blockHash);
                if (validResults.length >= 1) {
                    emitWarningLog(`CheckBlockAccepted: ${validResults[0].response.height} accepted as: ${validResults[0].response.hash}`);
                    callback(true, validResults[0].response.tx[0]);
                } else {
                    const errorResult = results.find((result) => result.error);
                    if (errorResult) {
                        emitErrorLog(`CheckBlockAccepted: ${errorResult.error.message}`);
                    } else {
                        emitErrorLog(`CheckBlockAccepted: No valid results found. Something's feked; we shouldn't get here!!!`);
                    }
                    callback(false);
                }
            });
        }, 500);
    };

    /**
     * Checks if the blockchain is synced with the network.
     * @param {Function} syncedCallback - The callback to execute when the blockchain is synced.
     */
    const OnBlockchainSynced = (syncedCallback) => {
        /**
         * Checks if the blockchain is synced.
         * @param {Function} displayNotSynced - The callback to display if not synced.
         */
        const checkSynced = (displayNotSynced) => {
            daemon.cmd('getblocktemplate', [], (results) => {
                const synced = results.every((r) => !r.error || r.error.code !== -10);
                if (synced) {
                    emitWarningLog('Blockchain is synced with network - starting server');
                    syncedCallback();
                } else {
                    if (displayNotSynced) displayNotSynced();
                    setTimeout(checkSynced, 5000);
                    if (!process.env.forkId || process.env.forkId === '0') generateProgress();
                }
            });
        };

        /**
         * Generates progress of the blockchain sync.
         */
        const generateProgress = () => {
            daemon.cmd('getinfo', [], (results) => {
                const blockCount = results.sort((a, b) => b.response.blocks - a.response.blocks)[0].response.blocks;

                daemon.cmd('getpeerinfo', [], (results) => {
                    const peers = results[0].response;
                    const totalBlocks = peers.sort((a, b) => b.startingheight - a.startingheight)[0].startingheight;

                    const percent = ((blockCount / totalBlocks) * 100).toFixed(2);
                    emitWarningLog(`Downloaded ${percent}% of blockchain from ${peers.length} peers`);
                });
            });
        };

        checkSynced(() => {
            if (!process.env.forkId || process.env.forkId === '0') {
                emitErrorLog('Daemon is still syncing with network (download blockchain) - server will be started once synced');
            }
        });
    };

    /**
     * Sets up block polling with the specified options.
     * @param {Object} options - The options object.
     * @param {Function} GetBlockTemplate - The function to get the block template.
     */
    const SetupBlockPolling = (options, GetBlockTemplate) => {
        if (typeof options.blockRefreshInterval !== "number" || options.blockRefreshInterval <= 0) {
            emitLog('Block template polling has been disabled', process.env.forkId);
            return;
        }
        const pollingInterval = options.blockRefreshInterval;
        setInterval(() => {
            GetBlockTemplate((error, result, foundNewBlock) => {
                if (foundNewBlock) {
                    if (!process.env.forkId || process.env.forkId === '0') {
                        emitLog(`Notification via RPC polling: ${options.coin.name} blockchain has advanced to ${result.height - 1}; we're now working on ${result.height}`);
                    }
                }
            });
        }, pollingInterval * 1000);
    };

    /**
     * Submits a block to the daemon.
     * @param {string} blockHex - The block hex string.
     * @param {Function} callback - The callback to execute when finished.
     */
    const SubmitBlock = (blockHex, callback) => {
        daemon.cmd('submitblock', [blockHex], (results) => {
            for (const result of results) {
                const nodeID = result.instance.index;
                if (result.error) {
                    emitErrorLog(`rpc error with daemon instance ${nodeID} when submitting block: ${JSON.stringify(result.error)}`);
                    return;
                } else if (result.response !== null) {
                    let msgReason;
                    switch (result.response) {
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
                            msgReason = ` Daemon has responded with something it shouldn't: ${result.response}`;
                            break;
                    }
                    emitErrorLog(`rpc error with daemon instance ${nodeID} when submitting block ${msgReason}`);
                    return;
                }
            }
            emitWarningLog('Successfully submitted block to daemon instance(s).');
            callback();
        });
    };

    /**
     * Gets the block template and processes it.
     * @param {Object} jobManager - The job manager object.
     * @param {Object} varDiff - The variable difficulty object.
     * @param {Function} callback - The callback to execute when finished.
     */
    const GetBlockTemplate = (jobManager, varDiff, callback) => {
        /**
         * Decodes the raw transaction and processes the block template.
         * @param {Object} template - The block template.
         */
        const getRawTransaction = (template) => {
            template.miner = (template.coinbasetxn.coinbasevalue / Math.pow(10, 8)).toFixed(8);
            daemon.cmd('decoderawtransaction', [template.coinbasetxn.data], async (result) => {
                if (result.error) {
                    emitErrorLog(`decoderawtransaction call failed for daemon instance ${result.instance.index} with error ${JSON.stringify(result.error)}`);
                    callback(result.error);
                } else {
                    template.vouts = result.response.vout;
                    const processedNewBlock = await jobManager.processTemplate(template);
                    callback(null, template, processedNewBlock);
                    callback = () => { };
                    if (processedNewBlock && varDiff) {
                        Object.keys(varDiff).forEach((port) => {
                            varDiff[port].setNetworkDifficulty(jobManager.currentJob.difficulty);
                        });
                    }
                }
            }, true);
        };

        /**
         * Gets the block template and raw coinbase transaction.
         */
        const getBlockTemplateAndRawCoinbase = () => {
            const isRrDefined = (rRthing) => typeof rRthing !== 'undefined' && rRthing !== null;
            daemon.cmd('getblocktemplate', [{ "capabilities": ["coinbasetxn", "workid", "coinbase/append"] }], (result) => {
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

    /**
     * Detects coin data by making batch RPC calls to the daemon.
     * @param {Object} options - The options object.
     * @param {Function} finishedCallback - The callback to execute when finished.
     */
    const DetectCoinData = (options, finishedCallback) => {
        const batchRpcCalls = [
            ['validateaddress', [options.address]],
            ['getdifficulty', []],
            ['getinfo', []],
            ['getmininginfo', []]
        ];
        daemon.batchCmd(batchRpcCalls, (error, results) => {
            if (error || !results) {
                emitErrorLog(`Could not start pool, error with init batch RPC call: ${JSON.stringify(error)}`);
                return;
            }
            const rpcResults = {};
            for (let i = 0; i < results.length; i++) {
                const rpcCall = batchRpcCalls[i][0];
                const r = results[i];
                rpcResults[rpcCall] = r.result || r.error;
                if (r.error || !r.result) {
                    emitErrorLog(`Could not start pool, error with init RPC ${rpcCall} - ${JSON.stringify(r.error)}`);
                    return;
                }
            }
            if (!rpcResults.validateaddress.isvalid) {
                emitErrorLog('Daemon reports address is not valid');
                return;
            }
            options.coin.reward = rpcResults.getinfo.staked ? 'POS' : 'POW';
            emitWarningLog(`This coin is ${options.coin.reward}\t\t\t`);
            options.poolAddressScript = util.addressToScript(rpcResults.validateaddress.address);
            options.testnet = rpcResults.getinfo.testnet;
            options.protocolVersion = rpcResults.getinfo.protocolversion;
            options.initStats = {
                connections: rpcResults.getinfo.connections,
                difficulty: rpcResults.getinfo.difficulty,
                networkHashRate: rpcResults.getmininginfo.networkhashps
            };
            finishedCallback();
        });
    };

    return {
        SubmitBlock,
        CheckBlockAccepted,
        OnBlockchainSynced,
        SetupBlockPolling,
        GetBlockTemplate,
        DetectCoinData
    };
};
