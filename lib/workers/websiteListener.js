const fs = require('fs');
const path = require('path');
const express = require('express');
const engine = require('express-dot-engine');
const RateLimit = require('express-rate-limit');

const Stratum = require('@pool/index.js');
const util = require('@helpers/util.js');
const { interface: DaemonInterface } = require('@protocols/daemon.js');
const logging = require('@middlewares/logging.js');

/**
 * Initializes and configures the website listener.
 * Sets up rate limiting, view engine, static file serving, and routes.
 */
module.exports = function () {
    if (!process.env.config) {
        throw new Error('Environment variable "config" is required');
    }

    const config = JSON.parse(process.env.config);
    const websiteConfig = config.website;
    const app = express();
    const limiter = RateLimit({
        windowMs: 15 * 60 * 1000, // 15 minutes
        max: 100, // max 100 requests per windowMs
    });

    app.engine('dot', engine.__express);
    app.set('views', path.join(`${process.cwd()}/website/public/views`))
        .set('view engine', 'dot')
        .set('coin', config.coin);

    app.use(express.static(`${process.cwd()}/website/public`));

    /**
     * Handles the root route ('/').
     * Fetches blockchain info and renders the index page.
     */
    app.get('/', async (req, res) => {
        const daemon = new DaemonInterface(config.daemons, (severity, message) => {
            logging('Website', severity, message);
        });

        const retryOperation = async (operation, retries = 3, delay = 1000) => {
            for (let i = 0; i < retries; i++) {
                try {
                    return await operation();
                } catch (err) {
                    if (i === retries - 1) throw err;
                    await new Promise(resolve => setTimeout(resolve, delay));
                }
            }
        };

        const getInfoFromDaemon = () => {
            return new Promise((resolve, reject) => {
                daemon.cmd('getinfo', [], (results) => {
                    if (!results) {
                        reject(new Error('Failed to get blockchain info'));
                        return;
                    }
                    const result = results[0];
                    if (!result || !result.response) {
                        reject(new Error('Failed to get blockchain info'));
                        return;
                    }
                    resolve(result.response);
                });
            });
        };

        const getNetworkHashrate = () => {
            return new Promise((resolve) => {
                daemon.cmd('getnetworksolps', [], (results) => {
                    if (!results || !results[0] || !results[0].response) {
                        resolve(0);
                        return;
                    }
                    resolve(results[0].response);
                });
            });
        };

        try {
            // Single promise instead of Promise.all to ensure getInfo succeeds
            const info = await getInfoFromDaemon();
            const networkSolps = await getNetworkHashrate();

            const blocks = info.blocks || 0;
            const difficulty = info.difficulty || 0;
            const hashrate = util.getReadableHashRateString(networkSolps || 0);

            res.render('index', {
                blocks,
                difficulty,
                hashrate,
                coin: config.coin
            });

        } catch (err) {
            logging('Website', 'error', `Error fetching blockchain info: ${err.message}`);
            res.status(503).render('error', {
                message: 'Mining pool is temporarily unavailable. The daemon may be syncing or offline. Please try again later.',
                error: {
                    status: 503,
                    stack: config.debug ? err.stack : ''
                },
                coin: config.coin
            });
        }
    });

    /**
     * Handles the '/api' route.
     * Renders the API documentation page.
     */
    app.get('/api', (req, res) => {
        res.render('api', {
            coin: config.coin // Add coin config to template data
        });
    });

    /**
     * Handles the '/blocks.json' route.
     * Serves the blocks JSON file with rate limiting.
     */
    app.get('/blocks.json', limiter, async (req, res) => {
        try {
            await res.sendFile(`${process.cwd()}/logs/${config.coin.symbol}_blocks.json`);
        } catch (err) {
            logging('Website', 'error', `Error sending blocks.json file: ${err.message}`);
            res.status(500).send('Internal Server Error');
        }
    });

    /**
     * Starts the server and listens on the configured port.
     * Logs the URL where the web pages are served.
     */
    const server = app.listen(websiteConfig.port, () => {
        const host = websiteConfig.host;
        const port = server.address().port;
        logging("Website", "debug", `Web pages served at http://${host}:${port}`);
    });

    // Handle uncaught exceptions and unhandled rejections
    process.on('uncaughtException', (err) => {
        logging('Website', 'error', `Uncaught Exception: ${err.message}`);
    });

    process.on('unhandledRejection', (reason, promise) => {
        logging('Website', 'error', `Unhandled Rejection at: ${promise}, reason: ${reason}`);
    });
};
