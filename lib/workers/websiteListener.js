const fs = require('fs');
const path = require('path');
const async = require('async');
const express = require('express');
const engine = require('express-dot-engine');
const RateLimit = require('express-rate-limit');

const Stratum = require('../stratum/index.js');
const { interface: DaemonInterface } = require('../stratum/daemon.js');
const logging = require('../modules/logging.js');

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
    app.get('/', (req, res) => {
        let blocks;
        let difficulty;
        let hashrate;
        const daemon = new DaemonInterface(config.daemons, (severity, message) => { logging('Website', severity, message); });
        async.series([
            (callback) => {
                daemon.cmd('getinfo', [], (result) => {
                    if (result.error) {
                        return callback(result.error);
                    }
                    blocks = result[0].response.blocks;
                    difficulty = result[0].response.difficulty;
                    callback(null);
                });
            },
            (callback) => {
                daemon.cmd('getnetworksolps', [], (result) => {
                    if (result.error) {
                        return callback(result.error);
                    }
                    hashrate = result[0].response;
                    callback(null);
                });
            },
            (callback) => {
                res.render('index', {
                    blocks: blocks,
                    difficulty: difficulty,
                    hashrate: hashrate
                });
                callback(null);
            }
        ], (err) => {
            if (err) {
                logging('Website', 'error', `Error fetching blockchain info: ${err.message}`);
                res.status(500).send('Internal Server Error');
            }
        });
    })
    /**
     * Handles the '/api' route.
     * Renders the API documentation page.
     */
    .get('/api', (req, res) => {
        res.render('api', {});
    })
    /**
     * Handles the '/blocks.json' route.
     * Serves the blocks JSON file with rate limiting.
     */
    .get('/blocks.json', limiter, (req, res) => {
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
