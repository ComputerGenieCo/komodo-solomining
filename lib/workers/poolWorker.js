var Stratum = require('../stratum/index.js');
var logging = require('../modules/logging.js');

module.exports = function() {
    var config = JSON.parse(process.env.config);
    var coin = config.coin.name;
    var forkId = process.env.forkId;
    let shareCount = {};
    var handlers = {
        share: () => {},
        diff: () => {}
    };

    /**
     * Emit a gray log message.
     * @param {string} text - The log message.
     * @param {string} [owner="PoolWorker"] - The owner of the log message.
     */
    var emitGrayLog = (text, owner = "PoolWorker") => { logging(owner, 'gray', text); };

    /**
     * Emit an error log message.
     * @param {string} text - The log message.
     * @param {string} [owner="PoolWorker"] - The owner of the log message.
     */
    var emitErrorLog = (text, owner = "PoolWorker") => { logging(owner, 'error', text); };

    /**
     * Emit a special log message.
     * @param {string} text - The log message.
     * @param {string} [owner="PoolWorker"] - The owner of the log message.
     */
    var emitSpecialLog = (text, owner = "PoolWorker") => { logging(owner, 'special', text); };

    /**
     * Authorize a worker.
     * @param {string} ip - The IP address of the worker.
     * @param {number} port - The port number of the worker.
     * @param {string} workerName - The name of the worker.
     * @param {string} password - The password of the worker.
     * @param {function} callback - The callback function to execute after authorization.
     */
    function authorizeFN(ip, port, workerName, password, callback) {
        emitSpecialLog(`Authorized ${workerName}:${password}@${ip}`);
        callback({
            error: null,
            authorized: true,
            disconnect: false
        });
    }

    var pool = Stratum.createPool(config, authorizeFN);
    pool.start();

    // Listen for messages from the parent process
    process.on('message', (message) => {
        switch (message.type) {
            case 'blocknotify':
                pool.processBlockNotify(message.hash, 'blocknotify script');
                break;
        }
    });

    // Handle share events
    pool.on('share', (isValidShare, isValidBlock, data) => {
        if (isValidBlock) {
            emitSpecialLog(`Block found:${data.height} Hash:${data.blockHash} block Diff:${data.blockDiff} share Diff:${data.shareDiff} finder:${data.worker}`, "Blocks");
            var api = require('../modules/api.js');
            api('block', {
                block: data.height,
                finder: data.worker,
                date: new Date().getTime()
            });
            while (shareCount[data.worker] > 0) { shareCount[data.worker] = 0; }
        } else if (data.blockHash && isValidBlock === undefined) {
            emitErrorLog('We thought a block was found but it was rejected by the daemon');
        }

        if (isValidShare) {
            shareCount[data.worker] = (shareCount[data.worker] + 1) || 1;
            if (config.printHighShares) {
                var sdiff = data.shareDiff;
                var bdiff = data.blockDiffActual;
                var sillyPercent = ((sdiff * 100) / bdiff); // Percent is meaningless, but it makes us feel good to see on higher diff chains like KMD
                if (sillyPercent > 100) {
                    emitErrorLog(`Share was found with diff higher than 100%! ${sdiff}: (${sillyPercent.toFixed(0)}%)`);
                } else if (sillyPercent > 75) {
                    emitSpecialLog(`Share was found with diff higher than 75%! ${sdiff}: (${sillyPercent.toFixed(0)}%)`);
                } else if (sillyPercent > 50) {
                    emitSpecialLog(`Share was found with diff higher than 50%! ${sdiff}: (${sillyPercent.toFixed(0)}%)`);
                }
            }
            if (config.printShares) {
                if (data.blockDiffActual > data.shareDiff) {
                    emitGrayLog(`${data.height} Share accepted - Block diff:${data.blockDiffActual} Share Diff:${data.shareDiff} (${sillyPercent.toFixed(2)} %) | ${data.worker} ${shareCount[data.worker]} shares`);
                } else {
                    emitSpecialLog(`${data.height} Share accepted - Block diff:${data.blockDiffActual} Share Diff:${data.shareDiff} | ${shareCount[data.worker]} shares`);
                }
            }
        }
    }).on('difficultyUpdate', (workerName, diff) => {
        if (config.printVarDiffAdjust) {
            emitSpecialLog(`Difficulty update workerName:${JSON.stringify(workerName)} to diff:${diff}`);
        }
        handlers.diff(workerName, diff);
    });
}
