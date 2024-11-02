const http = require('http');
const events = require('events');
const async = require('async');
const logging = require('@middlewares/logging.js');

class DaemonInterface extends events.EventEmitter {
    /**
     * The daemon interface interacts with the coin daemon by using the RPC interface.
     * @constructor
     * @param {Array<Object>} daemons - Array of daemon configuration objects.
     * @param {Function} logger - Logger function.
     */
    constructor(daemons, logger) {
        super();
        // Logger function to log messages with severity
        this.logger = (severity, message) => logging("Daemon", severity, message);
        // Initialize daemon instances with an index
        this.instances = daemons.map((daemon, index) => ({ ...daemon, index }));
    }

    /**
     * Initializes the daemon interface and checks if it's online.
     * @return {void}
     */
    init() {
        this.isOnline((online) => {
            if (online) {
                this.emit('online');
            }
        });
    }

    /**
     * Check if all daemon instances are online.
     * @param {Function} callback - Callback function to handle the online status.
     * @return {void}
     */
    isOnline(callback) {
        this.cmd('getinfo', [], (results) => {
            const allOnline = results.every(result => !result.error);
            callback(allOnline);
            if (!allOnline) {
                this.emit('connectionFailed', results);
            }
        });
    }

    /**
     * Perform an HTTP request to a daemon instance.
     * @param {Object} instance - Daemon instance configuration.
     * @param {string} jsonData - JSON data to send in the request.
     * @param {Function} callback - Callback function to handle the response.
     * @return {void}
     */
    performHttpRequest(instance, jsonData, callback) {
        const options = {
            hostname: instance.host || '127.0.0.1',
            port: instance.port,
            method: 'POST',
            auth: `${instance.user}:${instance.password}`,
            headers: {
                'Content-Length': jsonData.length
            }
        };

        // Function to parse JSON response from the daemon
        const parseJson = (res, data) => {
            if (res.statusCode === 401) {
                this.logger('error', 'Unauthorized RPC access - invalid RPC username or password');
                return;
            }

            try {
                const dataJson = JSON.parse(data);
                callback(dataJson.error, dataJson, data);
            } catch (e) {
                if (data.includes(':-nan')) {
                    // Handle specific case where data contains ':-nan'
                    parseJson(res, data.replace(/:-nan, /g, ":0"));
                } else {
                    this.logger('error', `Could not parse rpc data from daemon instance ${instance.index}\nRequest Data: ${jsonData}\nResponse Data: ${data}`);
                }
            }
        };

        const req = http.request(options, (res) => {
            let data = '';
            res.setEncoding('utf8');
            res.on('data', chunk => data += chunk);
            res.on('end', () => parseJson(res, data));
        });

        req.on('error', (e) => {
            const errorType = e.code === 'ECONNREFUSED' ? 'offline' : 'request error';
            callback({ type: errorType, message: e.message }, null);
        });

        req.end(jsonData);
    }

    /**
     * Performs a batch JSON-RPC command - only uses the first configured rpc daemon.
     * @param {Array<Array>} cmdArray - Array of command arrays, each containing method name and parameters.
     * @param {Function} callback - Callback function to handle the response.
     * @return {void}
     */
    batchCmd(cmdArray, callback) {
        const requestJson = cmdArray.map((cmd, i) => ({
            method: cmd[0],
            params: cmd[1],
            id: Date.now() + Math.floor(Math.random() * 10) + i
        }));

        const serializedRequest = JSON.stringify(requestJson);
        this.performHttpRequest(this.instances[0], serializedRequest, callback);
    }

    /**
     * Sends a JSON RPC command to every configured daemon.
     * @param {string} method - The RPC method to call.
     * @param {Array} params - Parameters for the RPC method.
     * @param {Function} callback - Callback function to handle the response.
     * @param {boolean} [streamResults=false] - Whether to stream results as they come in.
     * @param {boolean} [returnRawData=false] - Whether to return raw data in the response.
     * @return {void}
     */
    cmd(method, params, callback, streamResults = false, returnRawData = false) {
        const results = [];

        async.each(this.instances, (instance, eachCallback) => {
            const requestJson = JSON.stringify({
                method,
                params,
                id: Date.now() + Math.floor(Math.random() * 10)
            });

            this.performHttpRequest(instance, requestJson, (error, result, data) => {
                const returnObj = {
                    error,
                    response: result?.result,
                    instance
                };

                if (returnRawData) returnObj.data = data;
                if (streamResults) {
                    callback(returnObj);
                } else {
                    results.push(returnObj);
                }

                eachCallback();
            });
        }, () => {
            if (!streamResults) callback(results);
        });
    }
}

module.exports = { interface: DaemonInterface };