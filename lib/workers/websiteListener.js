const fs = require('fs');
const path = require('path');
const http = require('http');
const url = require('url');

const Stratum = require('../pool/index.js');
const util = require('../pool/helpers/util.js');
const { interface: DaemonInterface } = require('../pool/protocols/daemon.js');
const logging = require('../middlewares/logging.js');

/**
 * Serves static files with proper MIME types
 */
const serveStaticFile = (filePath, res) => {
    const extname = path.extname(filePath);
    const mimeTypes = {
        '.html': 'text/html',
        '.js': 'text/javascript',
        '.css': 'text/css',
        '.json': 'application/json',
        '.png': 'image/png',
        '.jpg': 'image/jpeg',
        '.ico': 'image/x-icon'
    };

    fs.readFile(filePath, (err, content) => {
        if (err) {
            if (err.code === 'ENOENT') {
                res.writeHead(404);
                res.end('404 Not Found');
            } else {
                res.writeHead(500);
                res.end('500 Internal Server Error');
            }
        } else {
            res.writeHead(200, { 'Content-Type': mimeTypes[extname] || 'text/plain' });
            res.end(content, 'utf-8');
        }
    });
};

/**
 * Simple rate limiting implementation
 */
class RateLimiter {
    constructor(windowMs = 900000, max = 100) { // 15 minutes, 100 requests
        this.windowMs = windowMs;
        this.max = max;
        this.clients = new Map();
    }

    tryRequest(ip) {
        const now = Date.now();
        const client = this.clients.get(ip) || { count: 0, resetTime: now + this.windowMs };

        if (now > client.resetTime) {
            client.count = 1;
            client.resetTime = now + this.windowMs;
        } else {
            client.count++;
        }

        this.clients.set(ip, client);
        return client.count <= this.max;
    }
}

/**
 * Initializes and configures the website listener.
 */
module.exports = function () {
    if (!process.env.config) {
        throw new Error('Environment variable "config" is required');
    }

    const config = JSON.parse(process.env.config);
    const websiteConfig = config.website;
    const rateLimiter = new RateLimiter();

    const daemon = new DaemonInterface(config.daemons, (severity, message) => {
        logging('Website', severity, message);
    });

    const getInfoFromDaemon = () => {
        return new Promise((resolve, reject) => {
            daemon.cmd('getinfo', [], (results) => {
                if (!results || !results[0] || !results[0].response) {
                    reject(new Error('Failed to get blockchain info'));
                    return;
                }
                resolve(results[0].response);
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

    const renderError = (res, message, status = 503) => {
        fs.readFile(path.join(process.cwd(), 'website/public/views/error.dot'), 'utf8', (err, template) => {
            if (err) {
                res.writeHead(500);
                res.end('Internal Server Error');
                return;
            }

            // Create error model similar to express
            const errorModel = {
                message: message,
                error: status === 404 ? undefined : {
                    status: status,
                    stack: config.debug ? new Error(message).stack : ''
                },
                coin: config.coin
            };

            let html = template
                .replace(/\[\[= model\.message \]\]/g, errorModel.message)
                .replace(/\[\[= model\.coin\.name \]\]/g, errorModel.coin.name);

            // Handle error stack conditional section
            if (errorModel.error && errorModel.error.stack) {
                html = html.replace(/\[\[\? model\.error && model\.error\.stack.+?\]\]/g, '')
                    .replace(/\[\[= model\.error\.stack \]\]/g, errorModel.error.stack);
            } else {
                // Remove the conditional section if no stack
                html = html.replace(/\[\[\? model\.error && model\.error\.stack.+?\[\[\?\]\]/gs, '');
            }

            res.writeHead(status, { 'Content-Type': 'text/html' });
            res.end(html);
        });
    };

    const server = http.createServer(async (req, res) => {
        const pathname = url.parse(req.url).pathname;
        const clientIp = req.socket.remoteAddress;

        // Handle static files
        if (req.method === 'GET' && !pathname.includes('..')) {
            if (pathname.startsWith('/css/') || pathname.startsWith('/scripts/')) {
                const filePath = path.join(process.cwd(), 'website/public', pathname);
                return serveStaticFile(filePath, res);
            }
        }

        // Route handling
        switch (pathname) {
            case '/':
                try {
                    const info = await getInfoFromDaemon();
                    const networkSolps = await getNetworkHashrate();

                    const templatePath = path.join(process.cwd(), 'website/public/views/index.dot');
                    fs.readFile(templatePath, 'utf8', (err, template) => {
                        if (err) {
                            renderError(res, 'Template error');
                            return;
                        }

                        const data = {
                            blocks: info.blocks || 0,
                            difficulty: info.difficulty || 0,
                            hashrate: util.getReadableHashRateString(networkSolps || 0),
                            coin: config.coin
                        };

                        const html = template
                            .replace(/\[\[= model\.blocks \]\]/g, data.blocks)
                            .replace(/\[\[= model\.difficulty \]\]/g, data.difficulty)
                            .replace(/\[\[= model\.hashrate \]\]/g, data.hashrate)
                            .replace(/\[\[= model\.coin\.name \]\]/g, data.coin.name);

                        res.writeHead(200, { 'Content-Type': 'text/html' });
                        res.end(html);
                    });
                } catch (err) {
                    logging('Website', 'error', `Error fetching blockchain info: ${err.message}`);
                    renderError(res, 'Mining pool is temporarily unavailable');
                }
                break;

            case '/api':
                try {
                    const apiTemplatePath = path.join(process.cwd(), 'website/public/views/api.dot');
                    fs.readFile(apiTemplatePath, 'utf8', (err, template) => {
                        if (err) {
                            renderError(res, 'Template error');
                            return;
                        }
                        const html = template.replace(/\[\[= model\.coin\.name \]\]/g, config.coin.name);
                        res.writeHead(200, { 'Content-Type': 'text/html' });
                        res.end(html);
                    });
                } catch (err) {
                    logging('Website', 'error', `Error rendering API page: ${err.message}`);
                    renderError(res, 'Error loading API documentation');
                }
                break;

            case '/blocks.json':
                if (!rateLimiter.tryRequest(clientIp)) {
                    res.writeHead(429);
                    res.end('Too Many Requests');
                    return;
                }
                const blocksPath = path.join(process.cwd(), 'logs', `${config.coin.symbol}_blocks.json`);
                serveStaticFile(blocksPath, res);
                break;

            default:
                renderError(res, 'Page not found', 404);
                break;
        }
    });

    server.listen(websiteConfig.port, websiteConfig.host, () => {
        logging("Website", "debug", `Web pages served at http://${websiteConfig.host}:${websiteConfig.port}`);
    });

    // Error handling
    server.on('error', (err) => {
        logging('Website', 'error', `Server error: ${err.message}`);
    });

    process.on('uncaughtException', (err) => {
        logging('Website', 'error', `Uncaught Exception: ${err.message}`);
    });

    process.on('unhandledRejection', (reason, promise) => {
        logging('Website', 'error', `Unhandled Rejection at: ${promise}, reason: ${reason}`);
    });
};
