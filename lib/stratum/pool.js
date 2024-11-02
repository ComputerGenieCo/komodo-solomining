const async = require('async');
const events = require('events');
const util = require('./util.js');
const peer = require('./peer.js');
const { interface: DaemonInterface } = require('./daemon.js'); // Renamed to DaemonInterface
const stratum = require('./stratum.js');
const varDiff = require('./varDiff.js');
const jobManager = require('./jobManager.js');
const logging = require('../modules/logging.js');

const doLog = (severity, text, forkId = "0") => logging(" Pool ", severity, text, forkId);
const emitLog = text => doLog('debug', text);
const emitWarningLog = text => doLog('warning', text);
const emitErrorLog = text => doLog('error', text);
const emitSpecialLog = text => doLog('special', text);

class Pool extends events.EventEmitter {
    /**
     * Initializes the pool with the given options and authorization function.
     * @param {Object} options - The configuration options for the pool.
     * @param {Function} authorizeFn - The function to authorize clients.
     */
    constructor(options, authorizeFn) {
        super();
        this.options = options;
        this.config = JSON.parse(process.env.config);
        this.authorizeFn = authorizeFn;
        this.blockPollingIntervalId = null;
        this.daemon = new DaemonInterface(options.daemons, (severity, message) => this.emit('log', severity, message));
        this.blockUtils = require('./blockUtils.js')(this.daemon, emitErrorLog, emitWarningLog, emitLog);
        const { GetBlockTemplate, DetectCoinData } = require('./blockUtils.js')(this.daemon, emitErrorLog, emitWarningLog, emitLog);
        this.GetBlockTemplate = GetBlockTemplate;
        this.DetectCoinData = DetectCoinData;
    }

    /**
     * Starts the pool.
     */
    start() {
        this.setupVarDiff();
        this.setupApi();
        this.setupDaemonInterface(() => {
            this.DetectCoinData(this.options, () => {
                this.setupJobManager();
                this.blockUtils.OnBlockchainSynced(() => {
                    this.getFirstJob(() => {
                        this.blockUtils.SetupBlockPolling(this.options, callback => this.GetBlockTemplate(this.jobManager, this.varDiff, callback));
                        this.setupPeer();
                        this.startStratumServer(() => {
                            this.outputPoolInfo();
                            this.emit('started');
                        });
                    });
                });
            });
        });
    }

    /**
     * Gets the first job from the block template.
     * @param {Function} finishedCallback - The callback to execute when the job is retrieved.
     */
    getFirstJob(finishedCallback) {
        this.GetBlockTemplate(this.jobManager, this.varDiff, (error, result) => {
            if (error) {
                emitErrorLog('Error with getblocktemplate on creating first job, server cannot start');
                return;
            }
            const portWarnings = [];
            const networkDiffAdjusted = this.options.initStats.difficulty;
            Object.keys(this.options.ports).forEach(port => {
                const portDiff = this.options.ports[port].diff;
                if (networkDiffAdjusted < portDiff) {
                    portWarnings.push(`port ${port} w/ diff ${portDiff}`);
                }
            });
            if (portWarnings.length > 0 && (!process.env.forkId || process.env.forkId === '0')) {
                const warnMessage = `Network diff of ${networkDiffAdjusted} is lower than ${portWarnings.join(' and ')}`;
                emitWarningLog(warnMessage);
            }
            finishedCallback();
        });
    }

    /**
     * Outputs pool information to the log.
     */
    outputPoolInfo() {
        const startMessage = `Stratum Pool Server Started for ${this.options.coin.name} [${this.options.coin.symbol.toUpperCase()}]`;
        if (process.env.forkId && process.env.forkId !== '0') {
            doLog('debug', startMessage, process.env.forkId);
            return;
        }
        const infoLines = [
            startMessage,
            `Network Connected:\t${this.options.testnet ? 'Testnet' : 'Mainnet'}`,
            `Detected Reward Type:\t${this.options.coin.reward}`,
            `Current Block Height:\t${this.jobManager.currentJob.rpcData.height}`,
            `Current Block Diff:\t${this.jobManager.currentJob.difficulty}`,
            `Current Connect Peers:\t${this.options.initStats.connections}`,
            `Network Difficulty:\t${this.options.initStats.difficulty}`,
            `Network Hash Rate:\t${util.getReadableHashRateString(this.options.initStats.networkHashRate)}`,
            `Stratum Port(s):\t${this.options.initStats.stratumPorts.join(', ')}`
        ];
        if (typeof this.options.blockRefreshInterval === "number" && this.options.blockRefreshInterval > 0) {
            infoLines.push(`Block polling every:\t${this.options.blockRefreshInterval} seconds`);
        }
        emitSpecialLog(infoLines.join('\n\t\t\t\t\t\t'));
    }

    /**
     * Sets up the API if it is configured.
     */
    setupApi() {
        if (typeof this.options.api === 'object' && typeof this.options.api.start === 'function') {
            this.options.api.start(this);
        }
    }

    /**
     * Sets up the peer-to-peer connection if it is enabled.
     */
    setupPeer() {
        if (!this.options.p2p || !this.options.p2p.enabled) return;
        if (this.options.testnet && !this.options.coin.peerMagicTestnet) {
            emitErrorLog('p2p cannot be enabled in testnet without peerMagicTestnet set in coin configuration');
            return;
        } else if (!this.options.coin.peerMagic) {
            emitErrorLog('p2p cannot be enabled without peerMagic set in coin configuration');
            return;
        }
        this.peer = new peer(this.options);
        this.peer.on('connected', () => {
            doLog('debug', 'p2p connection successful\t\t', process.env.forkId);
        }).on('connectionRejected', () => {
            emitErrorLog('p2p connection failed - likely incorrect p2p magic value');
        }).on('disconnected', () => {
            emitWarningLog('p2p peer node disconnected - attempting reconnection...');
        }).on('connectionFailed', e => {
            emitErrorLog(`p2p connection failed - likely incorrect host or port: ${e}`);
        }).on('socketError', e => {
            emitErrorLog(`p2p had a socket error ${JSON.stringify(e)}`);
        }).on('error', msg => {
            emitWarningLog(`p2p had an error ${msg}`);
        }).on('blockFound', hash => {
            this.processBlockNotify(hash, 'p2p');
        });
    }

    /**
     * Sets up variable difficulty for each port.
     */
    setupVarDiff() {
        Object.keys(this.options.ports).forEach(port => {
            if (this.options.ports[port].varDiff) {
                this.setVarDiff(port, this.options.ports[port].varDiff);
            }
        });
    }

    /**
     * Sets up the job manager and its event listeners.
     */
    setupJobManager() {
        this.jobManager = new jobManager(this.options);
        this.jobManager.on('newBlock', blockTemplate => {
            if (this.stratumServer) {
                this.stratumServer.broadcastMiningJobs(blockTemplate.getJobParams());
            }
        }).on('updatedBlock', blockTemplate => {
            if (this.stratumServer) {
                const job = blockTemplate.getJobParams();
                job[7] = false;
                this.stratumServer.broadcastMiningJobs(job);
            }
        }).on('share', (shareData, blockHex) => {
            const isValidShare = !shareData.error;
            let isValidBlock = !!blockHex;
            const emitShare = () => {
                this.emit('share', isValidShare, isValidBlock, shareData);
            };
            if (!isValidBlock) {
                emitShare();
            } else {
                this.blockUtils.SubmitBlock(blockHex, () => {
                    this.blockUtils.CheckBlockAccepted(shareData.blockHash, (isAccepted, tx) => {
                        isValidBlock = isAccepted;
                        shareData.txHash = tx;
                        emitShare();
                        this.GetBlockTemplate(this.jobManager, this.varDiff, (error, result, foundNewBlock) => {
                            if (foundNewBlock) {
                                emitLog('Block notification via RPC after block submission');
                            }
                        });
                    });
                });
            }
        });
    }

    /**
     * Sets up the daemon interface and initializes it.
     * @param {Function} finishedCallback - The callback to execute when the daemon is online.
     */
    setupDaemonInterface(finishedCallback) {
        if (!Array.isArray(this.options.daemons) || this.options.daemons.length < 1) {
            emitErrorLog('No daemons have been configured - pool cannot start');
            return;
        }
        this.daemon = new DaemonInterface(this.options.daemons, (severity, message) => this.emit('log', severity, message));
        this.daemon.once('online', () => {
            finishedCallback();
        }).on('connectionFailed', error => {
            emitErrorLog(`Failed to connect daemon(s): ${JSON.stringify(error)}`);
        }).on('error', message => {
            emitErrorLog(message);
        });
        this.daemon.init();
    }

    /**
     * Starts the Stratum server and sets up its event listeners.
     * @param {Function} finishedCallback - The callback to execute when the server is started.
     */
    startStratumServer(finishedCallback) {
        this.stratumServer = new stratum.Server(this.options, this.authorizeFn);
        this.stratumServer.on('started', () => {
            this.options.initStats.stratumPorts = Object.keys(this.options.ports);
            this.stratumServer.broadcastMiningJobs(this.jobManager.currentJob.getJobParams());
            finishedCallback();
        }).on('broadcastTimeout', () => {
            if ((process.env.forkId && process.env.forkId == '0') || (!process.env.forkId)) {
                if (this.config.printNewWork === true) {
                    emitLog(`No new blocks for ${this.options.jobRebroadcastTimeout} seconds - updating transactions & rebroadcasting work`);
                }
            }
            this.GetBlockTemplate(this.jobManager, this.varDiff, (error, rpcData, processedBlock) => {
                if (error || processedBlock) return;
                this.jobManager.updateCurrentJob(rpcData);
            });
        }).on('client.connected', client => {
            if (this.varDiff && this.varDiff[client.socket.localPort]) {
                this.varDiff[client.socket.localPort].manageClient(client);
            }
            client.on('difficultyChanged', diff => {
                this.emit('difficultyUpdate', client.workerName, diff);
            }).on('subscription', (params, resultCallback) => {
                const extraNonce = this.jobManager.extraNonceCounter.next();
                resultCallback(null, extraNonce, extraNonce);
                const sendDiff = sDdiff => client.sendDifficulty(sDdiff);
                const cJobDiff = this.jobManager.currentJob.difficulty;
                if (this.options.ports[client.socket.localPort]) {
                    if (this.options.minDiffAdjust && this.options.minDiffAdjust.toString() === 'true') {
                        sendDiff(this.options.ports[client.socket.localPort].diff);
                    } else {
                        sendDiff(cJobDiff);
                    }
                } else {
                    sendDiff(cJobDiff);
                }
                client.sendMiningJob(this.jobManager.currentJob.getJobParams());
            }).on('submit', (params, resultCallback) => {
                const result = this.jobManager.processShare(
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
            }).on('malformedMessage', message => {
                emitWarningLog(`Malformed message from ${client.getLabel()}: ${message}`);
            }).on('socketError', err => {
                emitWarningLog(`Socket error from ${client.getLabel()}: ${JSON.stringify(err)}`);
            }).on('socketTimeout', reason => {
                emitWarningLog(`Connected timed out for ${client.getLabel()}: ${reason}`);
            }).on('socketDisconnect', () => {
                emitWarningLog(`Socket disconnected from ${client.getLabel()}`);
            }).on('unknownStratumMethod', fullMessage => {
                emitLog(`Unknown stratum method from ${client.getLabel()}: ${fullMessage.method}`);
            }).on('socketFlooded', () => {
                emitWarningLog(`Detected socket flooding from ${client.getLabel()}`);
            });
        });
    }

    /**
     * Processes a block notification.
     * @param {string} blockHash - The hash of the block.
     * @param {string} sourceTrigger - The source that triggered the notification.
     */
    processBlockNotify(blockHash, sourceTrigger) {
        const isDefined = jMthing => typeof jMthing !== 'undefined';
        if (isDefined(this.jobManager) &&
            isDefined(this.jobManager.currentJob) &&
            isDefined(this.jobManager.currentJob.rpcData.previousblockhash) &&
            blockHash !== this.jobManager.currentJob.rpcData.previousblockhash) {
            if (!process.env.forkId || process.env.forkId === '0') {
                setTimeout(() => {
                    blockHash = util.reverseHex(blockHash);
                    this.daemon.cmd('getblock', [blockHash], async results => {
                        const validResults = results.filter(result => result.response && result.response.hash === blockHash);
                        if (validResults.length >= 1) {
                            emitLog(`Notification via ${sourceTrigger}: ${this.options.coin.name} blockchain has advanced to ${validResults[0].response.height}; we're now working on ${validResults[0].response.height + 1}`);
                        } else {
                            emitErrorLog(`Notification via ${sourceTrigger} of ${blockHash}; however, the daemon disagrees with it being a block`);
                        }
                    });
                }, 500);
            }
            this.GetBlockTemplate(this.jobManager, this.varDiff, error => {
                if (error) {
                    emitErrorLog(`Block notify error getting block template for ${this.options.coin.name}`);
                }
            });
        }
    }

    /**
     * Relinquishes miners that match the filter function.
     * @param {Function} filterFn - The function to filter miners.
     * @param {Function} resultCback - The callback to execute with the relinquished miners.
     */
    relinquishMiners(filterFn, resultCback) {
        const origStratumClients = this.stratumServer.getStratumClients();
        const stratumClients = Object.keys(origStratumClients).map(subId => ({
            subId,
            client: origStratumClients[subId]
        }));
        async.filter(stratumClients, filterFn, (err, clientsToRelinquish) => {
            clientsToRelinquish.forEach(cObj => {
                cObj.client.removeAllListeners();
                this.stratumServer.removeStratumClientBySubId(cObj.subId);
            });
            process.nextTick(() => {
                resultCback(clientsToRelinquish.map(item => item.client));
            });
        });
    }

    /**
     * Attaches miners to the Stratum server.
     * @param {Array} miners - The miners to attach.
     */
    attachMiners(miners) {
        miners.forEach(clientObj => {
            this.stratumServer.manuallyAddStratumClient(clientObj);
        });
        this.stratumServer.broadcastMiningJobs(this.jobManager.currentJob.getJobParams());
    }

    /**
     * Gets the Stratum server instance.
     * @return {Object} The Stratum server instance.
     */
    getStratumServer() {
        return this.stratumServer;
    }

    /**
     * Sets variable difficulty for a specific port.
     * @param {number} port - The port number.
     * @param {Object} varDiffConfig - The variable difficulty configuration.
     */
    setVarDiff(port, varDiffConfig) {
        if (!this.varDiff) {
            this.varDiff = {};
        }
        if (this.varDiff[port]) {
            this.varDiff[port].removeAllListeners();
        }
        this.varDiff[port] = new varDiff(port, varDiffConfig);
        this.varDiff[port].on('newDifficulty', (client, newDiff) => {
            client.enqueueNextDifficulty(newDiff);
        });
    }
}

module.exports = Pool;
