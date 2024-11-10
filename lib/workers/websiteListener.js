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
module.exports = function() {
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
    app.set('views', path.join(`${process.cwd()}/website/public`))
       .set('view engine', 'dot')
       .set('coin', config.coin);

    app.use(express.static(`${process.cwd()}/website/public`));

    /**
     * Handles the root route ('/').
     * Fetches blockchain info and renders the index page.
     */
    app.get('/', async (req, res) => {
        let blocks;
        let difficulty;
        let hashrate;
        const daemon = new DaemonInterface(config.daemons, (severity, message) => { logging('Website', severity, message); });

        try {
            const getInfoResult = await new Promise((resolve, reject) => {
                daemon.cmd('getinfo', [], (result) => {
                    if (result.error) {
                        return reject(result.error);
                    }
                    resolve(result);
                });
            });
            blocks = getInfoResult[0].response.blocks;
            difficulty = getInfoResult[0].response.difficulty;

            const getNetworkSolpsResult = await new Promise((resolve, reject) => {
                daemon.cmd('getnetworksolps', [], (result) => {
                    if (result.error) {
                        return reject(result.error);
                    }
                    resolve(result);
                });
            });
            hashrate = util.getReadableHashRateString(getNetworkSolpsResult[0].response);

            res.render('index', {
                blocks: blocks,
                difficulty: difficulty,
                hashrate: hashrate
            });
        } catch (err) {
            logging('Website', 'error', `Error fetching blockchain info: ${err.message}`);
            res.status(500).send('Internal Server Error');
        }
    });

    /**
     * Handles the '/api' route.
     * Renders the API documentation page.
     */
    app.get('/api', (req, res) => {
        res.render('api', {});
    });

    /**
     * Handles the '/blocks.json' route.
     * Serves the blocks JSON file with rate limiting.
     */
    app.get('/blocks.json', limiter, (req, res) => {
        res.sendFile(`${process.cwd()}/logs/${config.coin.symbol}_blocks.json`, (err) => {
            if (err) {
                logging('Website', 'error', `Error sending blocks.json file: ${err.message}`);
                res.status(500).send('Internal Server Error');
            }
        });
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
