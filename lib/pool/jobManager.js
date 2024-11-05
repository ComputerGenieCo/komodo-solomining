const events = require('events');
const crypto = require('crypto');
const bignum = require('bignum');
const util = require('@helpers/util.js');
const blockTemplate = require('@blockchain/blockTemplate.js');
const logging = require('@middlewares/logging.js');
const algos = require('@blockchain/algoProperties.js'); // Ensure algos is required

class ExtraNonceCounter {
    /**
     * Creates an instance of ExtraNonceCounter.
     * @param {number} [configInstanceId] - The configuration instance ID.
     */
    constructor(configInstanceId) {
        this.instanceId = configInstanceId || crypto.randomBytes(4).readUInt32LE(0);
        this.counter = this.instanceId << 27;
        this.size = 4; // bytes
    }

    /**
     * Generates the next extra nonce.
     * @return {string} The next extra nonce in hexadecimal format.
     */
    next() {
        const extraNonce = util.packUInt32BE(Math.abs(this.counter++));
        return extraNonce.toString('hex');
    }
}

class JobCounter {
    /**
     * Creates an instance of JobCounter.
     */
    constructor() {
        this.counter = 0x0000cccc;
    }

    /**
     * Generates the next job ID.
     * @return {string} The next job ID in hexadecimal format.
     */
    next() {
        this.counter++;
        if (this.counter % 0xffffffffff === 0) {
            this.counter = 1;
        }
        return this.cur();
    }

    /**
     * Gets the current job ID.
     * @return {string} The current job ID in hexadecimal format.
     */
    cur() {
        return this.counter.toString(16);
    }
}

class JobManager extends events.EventEmitter {
    /**
     * Creates an instance of JobManager.
     * @param {Object} options - The options for the JobManager.
     */
    constructor(options) {
        super();
        this.options = options;
        this.jobCounter = new JobCounter();
        this.config = JSON.parse(process.env.config);
        this.forkId = process.env.forkId;
        this.extraNonceCounter = new ExtraNonceCounter(options.instanceId);
        this.currentJob = null;
        this.validJobs = {};

        // Logging functions
        this.doLog = (severity, text, forkId = "0") => {
            logging("JobManager", severity, text, forkId);
        };
        this.emitGrayLog = (text) => {
            this.doLog('gray', text);
        };
        this.emitWarningLog = (text) => {
            this.doLog('warning', text);
        };
    }

    /**
     * Updates the current job with new RPC data.
     * @param {Object} rpcData - The RPC data for the new job.
     */
    async updateCurrentJob(rpcData) {
        const tmpBlockTemplate = new blockTemplate(
            this.jobCounter.next(),
            rpcData,
            this.extraNoncePlaceholder,
            this.options.coin.reward,
            this.options.address,
            this.options.coin,
            this.options.pubkey
        );
        this.currentJob = tmpBlockTemplate;
        this.emit('updatedBlock', tmpBlockTemplate, true);
        this.validJobs[tmpBlockTemplate.jobId] = tmpBlockTemplate;
    }

    /**
     * Processes a new block template.
     * @param {Object} rpcData - The RPC data for the new block template.
     * @return {boolean} Returns true if a new block was processed.
     */
    async processTemplate(rpcData) {
        const tmpBlockTemplate = new blockTemplate(
            this.jobCounter.next(),
            rpcData,
            this.extraNoncePlaceholder,
            this.options.coin.reward,
            this.options.address,
            this.options.coin,
            this.options.pubkey
        );

        // Determine if the difficulty or block is new
        const isNewDiff = typeof this.currentJob === 'undefined';
        const newDiff = !this.currentJob || (rpcData.target !== this.currentJob.rpcData.target);
        const isNewBlock = typeof this.currentJob === 'undefined';
        const newBlock = !this.currentJob || (rpcData.height !== this.currentJob.rpcData.height);

        // Handle new difficulty
        if (!newBlock && newDiff) {
            if (this.currentJob) {
                const targeta = bignum(this.currentJob.rpcData.target, 16);
                const targetb = bignum(rpcData.target, 16);
                const diffa = parseFloat((algos.komodo.diff1 / targeta.toNumber()).toFixed(9));
                const diffb = parseFloat((algos.komodo.diff1 / targetb.toNumber()).toFixed(9));
                if ((this.forkId && this.forkId == '0') || (!this.forkId)) {
                    if (this.config.printNewWork === true) {
                        this.emitGrayLog(`The diff for block ${rpcData.height} has changed from: ${diffa} to ${diffb}`);
                    }
                }
            }
            this.updateCurrentJob(rpcData);
            return false;
        }

        // Handle new block
        if (!newBlock && this.currentJob.rpcData.previousblockhash !== rpcData.previousblockhash) {
            if (rpcData.height < this.currentJob.rpcData.height) {
                return false;
            }
        }

        if (!newBlock) {
            this.updateCurrentJob(rpcData);
            return false;
        }

        this.currentJob = tmpBlockTemplate;
        this.validJobs = {};
        this.emit('newBlock', tmpBlockTemplate);
        this.validJobs[tmpBlockTemplate.jobId] = tmpBlockTemplate;

        // Update target and difficulty
        this.target = bignum(rpcData.target, 16);
        this.difficulty = parseFloat((algos.komodo.diff1 / this.target.toNumber()).toFixed(9)); // Use komodo.diff1 for internal calculations
        const nethash = (givenDiff) => (((((givenDiff * Math.pow(2, 32)) / 60) / Math.pow(10, 9))).toFixed(2));
        const diffCalc = (hashrate) => util.getReadableHashRateString(hashrate);
        const vnethash = (givenDiff) => (nethash(givenDiff) * 8.192).toFixed(2);

        // Log current difficulty and nethash if configured
        if (!this.forkId || this.forkId === '0') {
            if (this.config.printCurrentDiff === true) {
                this.emitGrayLog(`The diff for block ${rpcData.height}: ${this.difficulty}`);
            }
            if (this.config.printNethash === true && newBlock) {
                this.emitWarningLog(`Base nethash for ${rpcData.height} is: ${diffCalc(vnethash(this.difficulty))}`);
                this.emitWarningLog(`Effective nethash for ${rpcData.height} is: ${diffCalc(nethash(this.difficulty))}`);
            }
        }
        return true;
    }

    /**
     * Processes a share submitted by a worker.
     * @param {string} jobId - The job ID.
     * @param {number} previousDifficulty - The previous difficulty.
     * @param {number} difficulty - The current difficulty.
     * @param {string} extraNonce1 - The first part of the extranonce.
     * @param {string} extraNonce2 - The second part of the extranonce.
     * @param {string} nTime - The nTime value.
     * @param {string} nonce - The nonce value.
     * @param {string} ipAddress - The IP address of the worker.
     * @param {number} port - The port number.
     * @param {string} workerName - The name of the worker.
     * @param {string} soln - The solution.
     * @return {Object} The result of the share processing.
     */
    processShare(jobId, previousDifficulty, difficulty, extraNonce1, extraNonce2, nTime, nonce, ipAddress, port, workerName, soln) {
        const shareError = (error) => {
            this.emit('share', {
                job: jobId,
                ip: ipAddress,
                worker: workerName,
                difficulty: difficulty,
                error: error[1]
            });
            return { error: error, result: null };
        };

        const submitTime = Date.now() / 1000 | 0;
        const job = this.validJobs[jobId];
        if (!job || job.jobId !== jobId) {
            return shareError([21, 'job not found']);
        }
        if (nTime.length !== 8) {
            return shareError([20, 'incorrect size of ntime']);
        }
        const nTimeInt = parseInt(util.reverseBuffer(Buffer.from(nTime, 'hex')).toString('hex'), 16);
        if (Number.isNaN(nTimeInt)) {
            return shareError([20, 'invalid ntime']);
        }
        if (nTimeInt < job.rpcData.curtime || nTimeInt > submitTime + 7200) {
            return shareError([20, 'ntime out of range']);
        }
        if (nonce.length !== 64) {
            return shareError([20, 'incorrect size of nonce']);
        }
        if (soln.length !== 2694) {
            return shareError([20, 'incorrect size of solution']);
        }
        if (!job.registerSubmit(extraNonce1.toLowerCase(), extraNonce2.toLowerCase(), nTime, nonce)) {
            return shareError([22, 'duplicate share']);
        }

        const extraNonce1Buffer = Buffer.from(extraNonce1, 'hex');
        const extraNonce2Buffer = Buffer.from(extraNonce2, 'hex');
        const headerBuffer = job.serializeHeader(nTime, nonce);
        const headerSolnBuffer = Buffer.concat([headerBuffer, Buffer.from(soln, 'hex')]);
        const headerHash = util.sha256d(headerSolnBuffer);
        const headerBigNum = bignum.fromBuffer(headerHash, { endian: 'little', size: 32 });

        let blockHashInvalid;
        let blockHash;
        let blockHex;

        const shareDiff = (algos.komodo.diff1 / headerBigNum.toNumber());
        const blockDiffAdjusted = job.difficulty;

        // Check if the share is a valid block candidate
        if (headerBigNum.le(job.target)) {
            blockHex = job.serializeBlock(headerBuffer, Buffer.from(soln, 'hex')).toString('hex');
            blockHash = util.reverseBuffer(headerHash).toString('hex');
        } else {
            if (this.options.emitInvalidBlockHashes) {
                blockHashInvalid = util.reverseBuffer(util.sha256d(headerSolnBuffer)).toString('hex');
            }
            if (shareDiff / difficulty < 0.99) {
                if (previousDifficulty && shareDiff >= previousDifficulty) {
                    difficulty = previousDifficulty;
                } else {
                    return shareError([23, 'low difficulty share of ' + shareDiff]);
                }
            }
        }

        // Emit the share event with relevant data
        this.emit('share', {
            job: jobId,
            ip: ipAddress,
            port: port,
            worker: workerName,
            height: job.rpcData.height,
            blockReward: job.rpcData.miner,
            difficulty: difficulty,
            shareDiff: shareDiff.toFixed(8),
            blockDiff: blockDiffAdjusted,
            blockDiffActual: job.difficulty,
            blockHash: blockHash,
            blockHashInvalid: blockHashInvalid
        }, blockHex);

        return { result: true, error: null, blockHash: blockHash };
    }
}

module.exports = JobManager;
