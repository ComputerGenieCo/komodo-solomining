const fs = require('fs');
const os = require('os');
const cluster = require('cluster');
const path = require('path');

const Website = require('./lib/workers/websiteListener.js');
const logging = require('./lib/middlewares/logging.js');
const PoolWorker = require('./lib/workers/poolWorker.js');
const CliListener = require('./lib/workers/cliListener.js');

const CONFIG_FILE_DEFAULT = './configs/config.json';
const CONSTANTS_DIR = 'configs/constants';
const LOG_DIR = './logs';
const LOG_FILE_SUFFIX = '_blocks.json';
const SPAWN_INTERVAL_MS = 250;
const RESTART_DELAY_MS = 2000;

/**
 * Loads the main configuration file.
 * If a command-line argument is provided, it uses that plus '_config.json' as the configuration file name.
 * Otherwise, it defaults to './config.json'.
 * @return {Object} The configuration object.
 */
function loadConfig() {
    const configFile = process.argv[3] ? `./configs/${process.argv[3]}_config.json` : CONFIG_FILE_DEFAULT;
    try {
        return require(configFile);
    } catch (error) {
        console.error(`Failed to load config file: ${configFile}`, error);
        process.exit(1);
    }
}

/**
 * Loads the coin-specific constants file.
 * @param {Object} config - The main configuration object.
 * @return {Object} The coin configuration object.
 */
function loadCoinConfig(config) {
    const coinFilePath = path.join(CONSTANTS_DIR, `${config.coin}_constants.json`);
    if (!fs.existsSync(coinFilePath)) {
        console.error(`Could not find coin file: ${coinFilePath}`);
        process.exit(1);
    }
    try {
        const coinConfig = JSON.parse(fs.readFileSync(coinFilePath, { encoding: 'utf8' }));
        coinConfig.explorer = coinConfig.nonDexstatsExplorer ? coinConfig.nonDexstatsExplorer : `https://${coinConfig.symbol}.explorer.dexstats.info`;
        return coinConfig;
    } catch (error) {
        console.error(`Failed to load coin config: ${coinFilePath}`, error);
        process.exit(1);
    }
}

/**
 * Initializes the configuration by loading both the main and coin-specific configurations.
 * @return {Object} The combined configuration object.
 */
function initializeConfig() {
    const config = loadConfig();
    config.coin = loadCoinConfig(config);
    return config;
}

const config = initializeConfig();

/**
 * Creates empty log files if they do not exist.
 */
function createEmptyLogs() {
    const logFilePath = path.join(LOG_DIR, `${config.coin.symbol}${LOG_FILE_SUFFIX}`);
    fs.readFile(logFilePath, (err, data) => {
        if (err && err.code === "ENOENT") {
            fs.writeFile(logFilePath, '[]', (err) => {
                if (err) throw err;
            });
        } else if (err) {
            throw err;
        }
    });
}

/**
 * Creates a pool cluster worker and handles its lifecycle.
 * @param {number} forkId - The ID of the fork.
 * @param {Object} poolWorkers - The pool cluster workers object.
 */
function createPoolWorker(forkId, poolWorkers) {
    const worker = cluster.fork({
        workerType: 'pool',
        forkId: forkId,
        config: JSON.stringify(config)
    });
    worker.forkId = forkId;
    worker.type = 'pool';
    poolWorkers[forkId] = worker;
    worker.on('exit', (code, signal) => {
        logging('Pool', 'error', `Fork ${forkId} died, spawning replacement worker...`, forkId);
        setTimeout(() => { createPoolWorker(forkId, poolWorkers); }, RESTART_DELAY_MS);
    });
}

/**
 * Spawns pool cluster workers based on the configuration.
 * Determines the number of forks to create based on the clustering configuration.
 * If clustering is disabled or not configured, defaults to a single fork.
 * If clustering is set to 'auto', uses the number of CPU cores.
 * Otherwise, uses the specified number of forks.
 * Spawns the workers at intervals to avoid overwhelming the system.
 */
function spawnPoolWorkers() {
    // Determine the number of forks to create
    const numForks = (() => {
        if (!config.clustering || !config.clustering.enabled) { return 1; }
        if (config.clustering.forks === 'auto') { return os.cpus().length; }
        if (!config.clustering.forks || isNaN(config.clustering.forks)) { return 1; }
        return config.clustering.forks;
    })();

    const poolWorkers = {};
    let i = 0;

    // Spawn workers at intervals
    const spawnInterval = setInterval(() => {
        createPoolWorker(i, poolWorkers);
        i++;
        if (i === numForks) {
            clearInterval(spawnInterval);
            logging(' Init ', 'debug', `Spawned pool on ${numForks} threads(s)`);
        }
    }, SPAWN_INTERVAL_MS);
}

/**
 * Starts the CLI and website listeners.
 * Initializes and starts the CLI listener on the configured port.
 * The CLI listener logs messages and handles commands, such as 'blocknotify', which notifies all cluster workers of a new block.
 * Initializes and starts the website listener if it is enabled in the configuration.
 * The website listener runs in a separate cluster worker process and is restarted if it exits unexpectedly.
 */
function startListeners() {
    /**
     * Starts the CLI listener.
     * Initializes the CLI listener on the configured port.
     * Logs messages and handles commands received via the CLI.
     * The 'blocknotify' command notifies all cluster workers of a new block.
     */
    function startCliListener() {
        const cliPort = config.cliPort;
        const listener = new CliListener(cliPort);
        listener.on('log', (text) => {
            console.log('CLI: ' + text);
        }).on('command', (command, params, options, reply) => {
            switch (command) {
                case 'blocknotify':
                    Object.keys(cluster.workers).forEach(id => {
                        cluster.workers[id].send({
                            type: 'blocknotify',
                            workid: cluster.workers[id],
                            coin: params[0],
                            hash: params[1]
                        });
                    });
                    reply('Pool notified');
                    break;
                default:
                    reply(`unrecognized command \"${command}\"`);
                    break;
            }
        }).start();
    }

    /**
     * Starts the website listener.
     * Initializes the website listener if it is enabled in the configuration.
     * Runs the website listener in a separate cluster worker process.
     * If the website listener exits unexpectedly, it is restarted after a delay.
     */
    function startWebsite() {
        if (!config.website.enabled) { return; }
        const worker = cluster.fork({
            workerType: 'website',
            config: JSON.stringify(config)
        });
        worker.on('exit', (code, signal) => {
            logging('Website', 'error', 'Website process died, spawning replacement...');
            setTimeout(() => {
                startWebsite(config);
            }, RESTART_DELAY_MS);
        });
    }

    startCliListener();
    startWebsite();
}

/**
 * Checks if the current process is a cluster worker and initializes the appropriate worker type.
 * If the process is a cluster worker, it initializes either a PoolWorker or a Website worker based on the environment variable `workerType`.
 * If the worker type is unknown, it logs an error and exits the process.
 */
if (cluster.isWorker) {
    switch (process.env.workerType) {
        case 'pool':
            new PoolWorker();
            break;
        case 'website':
            new Website();
            break;
        default:
            console.error(`Unknown worker type: ${process.env.workerType}`);
            process.exit(1);
    }
    return;
}

/**
 * Initializes the application by creating logs, spawning pool cluster workers, and starting listeners.
 */
(function init() {
    createEmptyLogs();
    spawnPoolWorkers();
    startListeners();
})();
