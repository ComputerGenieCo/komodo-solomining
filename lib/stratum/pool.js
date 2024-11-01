var async = require('async');
var events = require('events');
var util = require('./util.js');
var peer = require('./peer.js');
var daemonModule = require('./daemon.js'); // Renamed to daemonModule to avoid confusion
var stratum = require('./stratum.js');
var varDiff = require('./varDiff.js');
var jobManager = require('./jobManager.js');
var logging = require('../modules/logging.js');
const doLog = (severity, text, forkId="0") => { logging(" Pool ", severity  , text, forkId); };
const emitLog = (text) => { doLog('debug'  , text); };
const emitWarningLog = (text) => { doLog('warning', text); };
const emitErrorLog = (text) => { doLog('error'  , text); };
const emitSpecialLog = (text) => { doLog('special', text); };
var pool = module.exports = function pool(options, authorizeFn) {
    this.options = options;
    var config = JSON.parse(process.env.config);
    var _this = this;
    var blockPollingIntervalId;
    _this.daemon = new daemonModule.interface(options.daemons, function(severity, message) { _this.emit('log', severity, message); });
    var blockUtils = require('./blockUtils.js')(_this.daemon, emitErrorLog, emitWarningLog, emitLog);
    const { GetBlockTemplate, DetectCoinData } = require('./blockUtils.js')(_this.daemon, emitErrorLog, emitWarningLog, emitLog);
    this.start = () => {
        SetupVarDiff();
        SetupApi();
        SetupDaemonInterface(() => {
            DetectCoinData(options, () => {
                SetupJobManager();
                blockUtils.OnBlockchainSynced(() => {
                    GetFirstJob(() => {
                        blockUtils.SetupBlockPolling(options, (callback) => GetBlockTemplate(_this.jobManager, _this.varDiff, callback));
                        SetupPeer();
                        StartStratumServer(() => {
                            OutputPoolInfo();
                            _this.emit('started');
                        });
                    });
                });
            });
        });
    };
    function GetFirstJob(finishedCallback) {
        GetBlockTemplate(_this.jobManager, _this.varDiff, function(error, result) {
            if (error) {
                emitErrorLog('Error with getblocktemplate on creating first job, server cannot start');
                return;
            }
            var portWarnings = [];
            var networkDiffAdjusted = options.initStats.difficulty;
            Object.keys(options.ports).forEach(function(port) {
                var portDiff = options.ports[port].diff;
                if (networkDiffAdjusted < portDiff) { portWarnings.push('port ' + port + ' w/ diff ' + portDiff); }
            });
            if (portWarnings.length > 0 && (!process.env.forkId || process.env.forkId === '0')) {
                var warnMessage = 'Network diff of ' + networkDiffAdjusted + ' is lower than ' + portWarnings.join(' and ');
                emitWarningLog(warnMessage);
            }
            finishedCallback();
        });
    }
    function OutputPoolInfo() {
        var startMessage = 'Stratum Pool Server Started for ' + options.coin.name + ' [' + options.coin.symbol.toUpperCase() + ']';
        if (process.env.forkId && process.env.forkId !== '0') {
            doLog('debug', startMessage, process.env.forkId);
            return;
        }
        var infoLines = [startMessage,
                         'Network Connected:\t' + (options.testnet ? 'Testnet' : 'Mainnet'),
                         'Detected Reward Type:\t' + options.coin.reward,
                         'Current Block Height:\t' + _this.jobManager.currentJob.rpcData.height,
                         'Current Block Diff:\t' + _this.jobManager.currentJob.difficulty,
                         'Current Connect Peers:\t' + options.initStats.connections,
                         'Network Difficulty:\t' + options.initStats.difficulty,
                         'Network Hash Rate:\t' + util.getReadableHashRateString(options.initStats.networkHashRate),
                         'Stratum Port(s):\t' + _this.options.initStats.stratumPorts.join(', ')
                        ];
        if (typeof options.blockRefreshInterval === "number" && options.blockRefreshInterval > 0) { infoLines.push('Block polling every:\t' + options.blockRefreshInterval + ' seconds'); }
        emitSpecialLog(infoLines.join('\n\t\t\t\t\t\t'));
    }
    function SetupApi() {
        if (typeof(options.api) !== 'object' || typeof(options.api.start) !== 'function') {
        } else {
            options.api.start(_this);
        }
    }
    function SetupPeer() {
        if (!options.p2p || !options.p2p.enabled) { return; }
        if (options.testnet && !options.coin.peerMagicTestnet) {
            emitErrorLog('p2p cannot be enabled in testnet without peerMagicTestnet set in coin configuration');
            return;
        } else if (!options.coin.peerMagic) {
            emitErrorLog('p2p cannot be enabled without peerMagic set in coin configuration');
            return;
        }
        _this.peer = new peer(options);
        _this.peer.on('connected', () => {
            doLog('debug', 'p2p connection successful\t\t', process.env.forkId);
        }).on('connectionRejected', () => {
            emitErrorLog('p2p connection failed - likely incorrect p2p magic value');
        }).on('disconnected', () => {
            emitWarningLog('p2p peer node disconnected - attempting reconnection...');
        }).on('connectionFailed', function(e) {
            emitErrorLog('p2p connection failed - likely incorrect host or port');
        }).on('socketError', function(e) {
            emitErrorLog('p2p had a socket error ' + JSON.stringify(e));
        }).on('error', function(msg) {
            emitWarningLog('p2p had an error ' + msg);
        }).on('blockFound', function(hash) {
            _this.processBlockNotify(hash, 'p2p');
        });
    }
    function SetupVarDiff() {
        Object.keys(options.ports).forEach(function (port) {
            if (options.ports[port].varDiff)
                _this.setVarDiff(port, options.ports[port].varDiff);
        });
    }
    const SubmitBlock = blockUtils.SubmitBlock;
    const CheckBlockAccepted = blockUtils.CheckBlockAccepted;
    function SetupJobManager() {
        _this.jobManager = new jobManager(options);
        _this.jobManager.on('newBlock', function(blockTemplate) {
            if (_this.stratumServer) {
                _this.stratumServer.broadcastMiningJobs(blockTemplate.getJobParams());
            }
        }).on('updatedBlock', function(blockTemplate) {
            if (_this.stratumServer) {
                var job = blockTemplate.getJobParams();
                job[7] = false;
                _this.stratumServer.broadcastMiningJobs(job);
            }
        }).on('share', function(shareData, blockHex) {
            var isValidShare = !shareData.error;
            var isValidBlock = !!blockHex;
            var emitShare = () => {
                _this.emit('share', isValidShare, isValidBlock, shareData);
            };
            if (!isValidBlock) {
                emitShare();
            } else {
                SubmitBlock(blockHex, () => {
                    CheckBlockAccepted(shareData.blockHash, function(isAccepted, tx) {
                        isValidBlock = isAccepted;
                        shareData.txHash = tx;
                        emitShare();
                        GetBlockTemplate(_this.jobManager, _this.varDiff, function(error, result, foundNewBlock) {
                            if (foundNewBlock) { emitLog('Block notification via RPC after block submission'); }
                        });
                    });
                });
            }
        });
    }
    function SetupDaemonInterface(finishedCallback) {
        if (!Array.isArray(options.daemons) || options.daemons.length < 1) {
            emitErrorLog('No daemons have been configured - pool cannot start');
            return;
        }
        _this.daemon = new daemonModule.interface(options.daemons, function(severity, message) { _this.emit('log', severity, message); });
        _this.daemon.once('online', () => {
            finishedCallback();
        }).on('connectionFailed', function(error) {
            emitErrorLog('Failed to connect daemon(s): ' + JSON.stringify(error));
        }).on('error', function(message) {
            emitErrorLog(message);
        });
        _this.daemon.init();
    }

    const StartStratumServer = (finishedCallback) => {
        _this.stratumServer = new stratum.Server(options, authorizeFn);
        _this.stratumServer.on('started', () => {
            options.initStats.stratumPorts = Object.keys(options.ports);
            _this.stratumServer.broadcastMiningJobs(_this.jobManager.currentJob.getJobParams());
            finishedCallback();
        }).on('broadcastTimeout', () => {
            if ((process.env.forkId && process.env.forkId == '0') || (!process.env.forkId)) {
                if (config.printNewWork === true) {
                    emitLog('No new blocks for ' + options.jobRebroadcastTimeout + ' seconds - updating transactions & rebroadcasting work');
                }
            }
            GetBlockTemplate(_this.jobManager, _this.varDiff, (error, rpcData, processedBlock) => {
                if (error || processedBlock) { return; }
                _this.jobManager.updateCurrentJob(rpcData);
            });
        }).on('client.connected', (client) => {
            if (typeof(_this.varDiff) !== 'undefined') {
                if (typeof(_this.varDiff[client.socket.localPort]) !== 'undefined') {
                    _this.varDiff[client.socket.localPort].manageClient(client);
                }
            }
            client.on('difficultyChanged', (diff) => {
                _this.emit('difficultyUpdate', client.workerName, diff);
            }).on('subscription', function (params, resultCallback) {
                var extraNonce = _this.jobManager.extraNonceCounter.next();
                resultCallback(null,
                               extraNonce,
                               extraNonce
                              );
                const sendDiff = (sDdiff) => { this.sendDifficulty(sDdiff); };
                let cJobDiff = _this.jobManager.currentJob.difficulty;
                if (typeof(options.ports[client.socket.localPort]) !== 'undefined') {
                    if (typeof(options.minDiffAdjust) !== 'undefined' && options.minDiffAdjust.toString() == 'true') {
                        sendDiff(options.ports[client.socket.localPort].diff);
                    } else {
                        sendDiff(cJobDiff);
                    };
                } else {
                    sendDiff(cJobDiff);
                };
                this.sendMiningJob(_this.jobManager.currentJob.getJobParams());
            }).on('submit', (params, resultCallback) => {
                var result = _this.jobManager.processShare(
                                 params.jobId,
                                 client.previousDifficulty,
                                 client.difficulty,
                                 client.extraNonce1,
                                 params.extraNonce2,
                                 params.nTime,
                                 params.nonce,
                                 client.remoteAddress,
                                 client.socket.localPort,
                                 params.name,
                                 params.soln
                             );
                resultCallback(result.error, result.result ? true : null);
            }).on('malformedMessage', (message) => {
                emitWarningLog(`Malformed message from ${client.getLabel()}: ${message}`);
            }).on('socketError', (err) => {
                emitWarningLog(`Socket error from ${client.getLabel()}: ${JSON.stringify(err)}`);
            }).on('socketTimeout', (reason) => {
                emitWarningLog(`Connected timed out for ${client.getLabel()}: ${reason}`)
            }).on('socketDisconnect', () => {
                emitWarningLog(`Socket disconnected from ${client.getLabel()}`);
            }).on('unknownStratumMethod', (fullMessage) => {
                emitLog(`Unknown stratum method from ${client.getLabel()}: ${fullMessage.method}`);
            }).on('socketFlooded', () => {
                emitWarningLog(`Detected socket flooding from ${client.getLabel()}`);
            });
        });
    }
    this.processBlockNotify = (blockHash, sourceTrigger) => {
        let isDefined = (jMthing) => (typeof(jMthing) !== 'undefined');
        if (isDefined(_this.jobManager) &&
         isDefined(_this.jobManager.currentJob) &&
         isDefined(_this.jobManager.currentJob.rpcData.previousblockhash) &&
         blockHash !== _this.jobManager.currentJob.rpcData.previousblockhash) {
            if (!process.env.forkId || process.env.forkId === '0') {
                setTimeout(() => {
                blockHash = util.reverseHex(blockHash)
                    _this.daemon.cmd('getblock', [blockHash],
                        async (results) => {
                            var validResults = results.filter((result) => (result.response, (result.response.hash === blockHash)));
                            if (validResults.length >= 1) {
                                emitLog(`Notification via ${sourceTrigger}: ${options.coin.name} blockchain has advanced to ${validResults[0].response.height};${''
                                } we're now working on ${validResults[0].response.height+1}`);
                            } else {
                                emitErrorLog(`Notification via ${sourceTrigger} of ${blockHash}; however, the daemon disagrees with it being a block`);
                                return;
                            }
                        }
                    );
                }, 500);
            };
            GetBlockTemplate(_this.jobManager, _this.varDiff, (error, result) => {
                if (error) { emitErrorLog(`Block notify error getting block template for ${options.coin.name}`); };
            });
        };
    };
    this.relinquishMiners = (filterFn, resultCback) => {
        var origStratumClients = this.stratumServer.getStratumClients();
        var stratumClients = [];
        Object.keys(origStratumClients).forEach((subId) => {
            stratumClients.push({
                subId: subId,
                client: origStratumClients[subId]
            });
        });
        async.filter(stratumClients, filterFn, (err, clientsToRelinquish) => {
            clientsToRelinquish.forEach((cObj) => {
                cObj.client.removeAllListeners();
                _this.stratumServer.removeStratumClientBySubId(cObj.subId);
            });
            process.nextTick(() => {
                resultCback(clientsToRelinquish.map((item) => item.client));
            });
        })
    };
    this.attachMiners = (miners) => {
        miners.forEach((clientObj) => { _this.stratumServer.manuallyAddStratumClient(clientObj); });
        _this.stratumServer.broadcastMiningJobs(_this.jobManager.currentJob.getJobParams());
    };
    this.getStratumServer = () => _this.stratumServer;
    this.setVarDiff = (port, varDiffConfig) => {
        if (typeof(_this.varDiff) === 'undefined') { _this.varDiff = {}; }
        if (typeof(_this.varDiff[port]) != 'undefined' ) { _this.varDiff[port].removeAllListeners(); }
        _this.varDiff[port] = new varDiff(port, varDiffConfig);;
        _this.varDiff[port].on('newDifficulty', (client, newDiff) => {
            client.enqueueNextDifficulty(newDiff);
        });
    };
};
pool.prototype.__proto__ = events.EventEmitter.prototype;
