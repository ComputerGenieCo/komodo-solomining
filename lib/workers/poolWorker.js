const Stratum = require('@pool/index.js');
const logging = require('@middlewares//logging.js');
const api = require('@middlewares//api.js');

const LOG_LEVELS = {
    GRAY: 'gray',
    ERROR: 'error',
    SPECIAL: 'special'
};

class PoolWorker {
    constructor() {
        this.config = this.loadConfig();
        this.shareCount = {};
        this.handlers = {
            share: () => {},
            diff: () => {}
        };
        this.pool = this.createPool();
        this.setupListeners();
    }

    // Load configuration from environment variables
    loadConfig() {
        let config;
        try {
            config = JSON.parse(process.env.config);
        } catch (error) {
            logging('PoolWorker', LOG_LEVELS.ERROR, `Failed to parse config: ${error.message}`);
            process.exit(1);
        }

        if (!config.coin || !config.coin.name) {
            logging('PoolWorker', LOG_LEVELS.ERROR, 'Coin configuration is missing');
            process.exit(1);
        }

        return config;
    }

    // Create the pool and start it
    createPool() {
        let pool;
        try {
            pool = Stratum.createPool(this.config, this.authorizeFN.bind(this));
            pool.start();
        } catch (error) {
            this.emitErrorLog(`Failed to start pool: ${error.message}`);
            process.exit(1);
        }
        return pool;
    }

    // Setup listeners for pool events and process messages
    setupListeners() {
        process.on('message', (message) => {
            if (message.type === 'blocknotify') {
                this.pool.processBlockNotify(message.hash, 'blocknotify script');
            }
        });

        this.pool.on('share', (isValidShare, isValidBlock, data) => {
            this.handleShare(isValidShare, isValidBlock, data);
        }).on('difficultyUpdate', (workerName, diff) => {
            if (this.config.printVarDiffAdjust) {
                this.emitSpecialLog(`Difficulty update workerName:${JSON.stringify(workerName)} to diff:${diff}`);
            }
            this.handlers.diff(workerName, diff);
        });
    }

    // Handle share events
    handleShare(isValidShare, isValidBlock, data) {
        if (isValidBlock) {
            this.emitSpecialLog(`Block found:${data.height} Hash:${data.blockHash} block Diff:${data.blockDiff} share Diff:${data.shareDiff} finder:${data.worker}`, "Blocks");
            api('block', {
                block: data.height,
                finder: data.worker,
                date: new Date().getTime()
            });
            this.shareCount[data.worker] = 0;
        } else if (data.blockHash && isValidBlock === undefined) {
            this.emitErrorLog('We thought a block was found but it was rejected by the daemon');
        }

        if (isValidShare) {
            this.shareCount[data.worker] = (this.shareCount[data.worker] + 1) || 1;
            let sillyPercent = 0;
            if (this.config.printHighShares) {
                const shareDiff = data.shareDiff;
                const blockDiffActual = data.blockDiffActual;
                sillyPercent = ((shareDiff * 100) / blockDiffActual);

                const HIGH_DIFF_THRESHOLD_100 = 100;
                const HIGH_DIFF_THRESHOLD_75 = 75;
                const HIGH_DIFF_THRESHOLD_50 = 50;

                if (sillyPercent > HIGH_DIFF_THRESHOLD_100) {
                    this.emitErrorLog(`Share was found with diff higher than 100%! ${shareDiff}: (${sillyPercent.toFixed(0)}%)`);
                } else if (sillyPercent > HIGH_DIFF_THRESHOLD_75) {
                    this.emitSpecialLog(`Share was found with diff higher than 75%! ${shareDiff}: (${sillyPercent.toFixed(0)}%)`);
                } else if (sillyPercent > HIGH_DIFF_THRESHOLD_50) {
                    this.emitSpecialLog(`Share was found with diff higher than 50%! ${shareDiff}: (${sillyPercent.toFixed(0)}%)`);
                }
            }
            if (this.config.printShares) {
                const shareMessage = `${data.height} Share accepted - Block diff:${data.blockDiffActual} Share Diff:${data.shareDiff} (${sillyPercent.toFixed(2)} %)\t${data.worker} ${this.shareCount[data.worker]} shares`;
                if (data.blockDiffActual > data.shareDiff) {
                    this.emitGrayLog(shareMessage);
                } else {
                    this.emitSpecialLog(shareMessage);
                }
            }
        }
    }

    // Authorization function
    authorizeFN(ip, port, workerName, password, callback) {
        this.emitSpecialLog(`Authorized ${workerName}:${password}@${ip}`);
        callback({
            error: null,
            authorized: true,
            disconnect: false
        });
    }

    // Logging functions
    emitGrayLog(text, owner = "PoolWorker") {
        logging(owner, LOG_LEVELS.GRAY, text);
    }

    emitErrorLog(text, owner = "PoolWorker") {
        logging(owner, LOG_LEVELS.ERROR, text);
    }

    emitSpecialLog(text, owner = "PoolWorker") {
        logging(owner, LOG_LEVELS.SPECIAL, text);
    }
}

module.exports = PoolWorker;
