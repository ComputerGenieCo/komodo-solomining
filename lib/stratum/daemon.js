var http = require('http');
var events = require('events');
var async = require('async');
var logging = require('../modules/logging.js');

/**
 * The daemon interface interacts with the coin daemon by using the RPC interface.
 * in order to make it work it needs, as constructor, an array of objects containing
 * - 'host'    : hostname where the coin lives
 * - 'port'    : port where the coin accepts RPC connections
 * - 'user'    : username of the coin for the RPC interface
 * - 'password': password for the RPC interface of the coin
 * @constructor
 * @param {Array<Object>} daemons - Array of daemon configuration objects.
 * @param {Function} logger - Logger function.
 */
function DaemonInterface(daemons, logger) {
    // Private members
    var _this = this;
    var logger = (severity, message) => { logging("Daemon", severity, message); };

    // Initialize daemon instances with an index
    var instances = (() => {
        for (var i = 0; i < daemons.length; i++) { daemons[i]['index'] = i; }
        return daemons;
    })();

    /**
     * Initializes the daemon interface and checks if it's online.
     * @return {void}
     */
    function init() {
        isOnline((online) => {
            if (online) { _this.emit('online'); }
        });
    }

    /**
     * Check if all daemon instances are online.
     * @param {Function} callback - Callback function to handle the online status.
     * @return {void}
     */
    function isOnline(callback) {
        cmd('getinfo', [], (results) => {
            var allOnline = results.every((result) => { return !result.error; });
            callback(allOnline);
            if (!allOnline) { _this.emit('connectionFailed', results); }
        });
    }

    /**
     * Perform an HTTP request to a daemon instance.
     * @param {Object} instance - Daemon instance configuration.
     * @param {string} jsonData - JSON data to send in the request.
     * @param {Function} callback - Callback function to handle the response.
     * @return {void}
     */
    function performHttpRequest(instance, jsonData, callback) {
        var options = {
            hostname: (typeof(instance.host) === 'undefined' ? '127.0.0.1' : instance.host),
            port: instance.port,
            method: 'POST',
            auth: instance.user + ':' + instance.password,
            headers: {
                'Content-Length': jsonData.length
            }
        };

        // Parse JSON response from the daemon
        var parseJson = (res, data) => {
            var dataJson;

            if (res.statusCode === 401) {
                logger('error', 'Unauthorized RPC access - invalid RPC username or password');
                return;
            }

            try {
                dataJson = JSON.parse(data);
            } catch (e) {
                if (data.indexOf(':-nan') !== -1) {
                    data = data.replace(/:-nan, /g, ":0");
                    parseJson(res, data);
                    return;
                }
                logger('error', `Could not parse rpc data from daemon instance ${instance.index}\nRequest Data: ${jsonData}\nReponse Data: ${data}`);
            }
            if (dataJson) { callback(dataJson.error, dataJson, data); }
        };

        var req = http.request(options, (res) => {
            var data = '';
            res.setEncoding('utf8');
            res.on('data', (chunk) => {
                data += chunk;
            }).on('end', () => {
                parseJson(res, data);
            });
        });

        req.on('error', (e) => {
            if (e.code === 'ECONNREFUSED')
                callback({type: 'offline', message: e.message}, null);
            else
                callback({type: 'request error', message: e.message}, null);
        });

        req.end(jsonData);
    }

    /**
     * Performs a batch JSON-RPC command - only uses the first configured rpc daemon.
     * @param {Array<Array>} cmdArray - Array of command arrays, each containing method name and parameters.
     * @param {Function} callback - Callback function to handle the response.
     * @return {void}
     */
    function batchCmd(cmdArray, callback) {
        var requestJson = [];

        for (var i = 0; i < cmdArray.length; i++) {
            requestJson.push({
                method: cmdArray[i][0],
                params: cmdArray[i][1],
                id: Date.now() + Math.floor(Math.random() * 10) + i
            });
        }

        var serializedRequest = JSON.stringify(requestJson);
        performHttpRequest(instances[0], serializedRequest, (error, result) => { callback(error, result); });
    }

    /**
     * Sends a JSON RPC (http://json-rpc.org/wiki/specification) command to every configured daemon.
     * The callback function is fired once with the result from each daemon unless streamResults is
     * set to true.
     * @param {string} method - The RPC method to call.
     * @param {Array} params - Parameters for the RPC method.
     * @param {Function} callback - Callback function to handle the response.
     * @param {boolean} [streamResults=false] - Whether to stream results as they come in.
     * @param {boolean} [returnRawData=false] - Whether to return raw data in the response.
     * @return {void}
     */
    function cmd(method, params, callback, streamResults = false, returnRawData = false) {
        var results = [];

        async.each(instances, (instance, eachCallback) => {
            var itemFinished = (error, result, data) => {
                var returnObj = {
                    error: error,
                    response: (result || {}).result,
                    instance: instance
                };
                
                if (returnRawData) { returnObj.data = data; }
                if (streamResults) {
                    callback(returnObj);
                } else {
                    results.push(returnObj);
                }
                
                eachCallback();
                itemFinished = () => {};
            };
            var requestJson = JSON.stringify({
                method: method,
                params: params,
                id: Date.now() + Math.floor(Math.random() * 10)
            });
            performHttpRequest(instance, requestJson, (error, result, data) => { itemFinished(error, result, data); });
        }, () => {
            if (!streamResults) { callback(results); }
        });
    }

    // Public members
    this.init = init;
    this.isOnline = isOnline;
    this.cmd = cmd;
    this.batchCmd = batchCmd;
}

// Inherit from EventEmitter to allow emitting events
DaemonInterface.prototype.__proto__ = events.EventEmitter.prototype;

exports.interface = DaemonInterface;