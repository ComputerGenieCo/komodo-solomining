const net = require('net');
const events = require('events');
const logging = require('@middlewares/logging.js');
const algos = require('@blockchain/algoProperties.js'); // Ensure algos is required
const {
    SubscriptionCounter,
    sendJson,
    setupSocket,
    getSafeString,
    getSafeWorkerString
} = require('@pool/helpers/stratumUtil.js');

/**
 * Represents a Stratum client.
 * This class handles the communication with a single mining client.
 * @param {Object} options The options for the Stratum client.
 * @constructor
 */
const StratumClient = function (options) {
    let pendingDifficulty = null;
    this.socket = options.socket;
    this.remoteAddress = options.socket.remoteAddress;
    const _this = this;
    this.lastActivity = Date.now();

    /**
     * Initializes the client by setting up the socket.
     */
    this.init = function init() { setupSocket(options, handleMessage, _this); };

    /**
     * Gets a label for the client.
     * This label is used for logging and identification purposes.
     * @return {string} The label for the client.
     */
    this.getLabel = () => `${_this.workerName || '(unauthorized)'} [${_this.remoteAddress}]`;

    /**
     * Enqueues the next difficulty for the client.
     * This function sets the next difficulty level for the client.
     * @param {number} requestedNewDifficulty The requested new difficulty.
     * @return {boolean} True if the difficulty was enqueued, false otherwise.
     */
    this.enqueueNextDifficulty = (requestedNewDifficulty) => {
        pendingDifficulty = requestedNewDifficulty;
        return true;
    };

    /**
     * Handles incoming messages from the client.
     * @param {Object} message The message from the client.
     */
    const handleMessage = (message) => {
        switch (message.method) {
            case 'mining.subscribe':
                handleSubscribe(message);
                break;
            case 'mining.authorize':
                handleAuthorize(message);
                break;
            case 'mining.submit':
                _this.lastActivity = Date.now();
                handleSubmit(message);
                break;
            case 'mining.get_transactions':
                sendJson(_this.socket, {
                    id: null,
                    result: [],
                    error: true
                });
                break;
            case 'mining.extranonce.subscribe':
                sendJson(_this.socket, {
                    id: message.id,
                    result: false,
                    error: [20, "Not supported.", null]
                });
                break;
            default:
                _this.emit('unknownStratumMethod', message);
                break;
        }
    };

    /**
     * Handles subscription requests from the client.
     * @param {Object} message The subscription message from the client.
     */
    const handleSubscribe = (message) => {
        if (!_this.authorized) { _this.requestedSubscriptionBeforeAuth = true; }
        _this.emit('subscription', {}, (error, extraNonce1) => {
            if (error) {
                sendJson(_this.socket, {
                    id: message.id,
                    result: null,
                    error: error
                });
                return;
            }
            _this.extraNonce1 = extraNonce1;
            sendJson(_this.socket, {
                id: message.id,
                result: [null, extraNonce1],
                error: null
            });
        });
    };

    /**
     * Handles authorization requests from the client.
     * @param {Object} message The authorization message from the client.
     */
    const handleAuthorize = (message) => {
        _this.workerName = getSafeWorkerString(message.params[0]);
        _this.workerPass = getSafeString(message.params[1]);
        _this.config = JSON.parse(process.env.config);
        const addr = _this.workerName.split(".")[0];
        options.authorizeFn(_this.remoteAddress, options.socket.localPort, addr, _this.workerPass, (result) => {
            _this.authorized = (!result.error && result.authorized);
            sendJson(_this.socket, {
                id: message.id,
                result: _this.authorized,
                error: result.error
            });
            if (_this.authorized) {
                difficulty = _this.config.ports[options.socket.localPort].diff;
                //console.log(`_this.difficulty: ${_this.difficulty}`);
                _this.sendDifficulty(difficulty); // Send target after authorization
            }
            if (result.disconnect === true) { options.socket.destroy(); }
        });
    };

    /**
     * Sends the difficulty to the client.
     * This function sends the new difficulty level to the client.
     * @param {number} difficulty The difficulty to send.
     * @return {boolean} True if the difficulty was sent, false otherwise.
     */
    this.sendDifficulty = (difficulty) => {
        if (!_this.authorized) {
            //console.log(`Client not authorized: ${_this.getLabel()}`);
            return false;
        }
        //console.log(`difficulty ${difficulty} this.difficulty ${this.difficulty} _this.difficulty ${_this.difficulty}`);
        //difficulty = _this.config.ports[options.socket.localPort].diff;
            
        if (difficulty === this.difficulty) {
            return false;
        }
        if (!options.hasInitialTarget || typeof _this.difficulty === 'undefined') {
            _this.difficulty = difficulty;
            options.hasInitialTarget = true;
            console.log(`Difficulty set.`);
            
        }
        _this.previousDifficulty = _this.difficulty;
        _this.difficulty = difficulty;
        console.log(`New difficulty set.`);
        // Calculate the scaling factor
        const scalingFactor = algos.zcash.diff1 / algos.komodo.diff1;

        // Scale the target
        const scaledTarget = algos.komodo.diff1 / (difficulty / scalingFactor);

        const zeroPad = (64 - scaledTarget.toString(16).length) === 0 ? '' : '0'.repeat((64 - (scaledTarget.toString(16)).length));
        const target = (zeroPad + scaledTarget.toString(16)).substr(0, 64);
        //console.log(`Sending target ${target} to miner ${_this.getLabel()}`);
        sendJson(_this.socket, {
            id: null,
            method: "mining.set_target",
            params: [target]
        });
        return true;
    };

    /**
     * Sends a mining job to the client.
     * This function sends a new mining job to the client.
     * @param {Array} jobParams The parameters of the mining job.
     */
    this.sendMiningJob = (jobParams) => {
        const lastActivityAgo = Date.now() - _this.lastActivity;
        // Check if the client has been inactive for too long
        if (lastActivityAgo > options.connectionTimeout * 1000) {
            _this.socket.destroy();
            return;
        }
        if (!_this.authorized) {
            //console.log(`Client not authorized: ${_this.getLabel()}`);
            return;
        }
        if (pendingDifficulty !== null) {
            const result = _this.sendDifficulty(pendingDifficulty);
            pendingDifficulty = null;
            if (result) { _this.emit('difficultyChanged', _this.difficulty); }
        } else {
            // Ensure difficulty is sent even if VarDiff is not used
            _this.sendDifficulty(_this.difficulty);
        }
        sendJson(_this.socket, {
            id: null,
            method: "mining.notify",
            params: jobParams
        });
    };

    /**
     * Handles submission of mining results from the client.
     * @param {Object} message The submission message from the client.
     */
    const handleSubmit = (message) => {
        if (!_this.workerName) { _this.workerName = getSafeWorkerString(message.params[0]); }
        if (_this.authorized === false) {
            sendJson(_this.socket, {
                id: message.id,
                result: null,
                error: [24, "unauthorized worker", null]
            });
            return;
        }
        if (!_this.extraNonce1) {
            sendJson(_this.socket, {
                id: message.id,
                result: null,
                error: [25, "not subscribed", null]
            });
            return;
        }
        _this.emit('submit', {
            name: _this.workerName,
            jobId: message.params[1],
            nTime: message.params[2],
            extraNonce2: message.params[3],
            soln: message.params[4],
            nonce: _this.extraNonce1 + message.params[3]
        }, (error, result) => {
            sendJson(_this.socket, {
                id: message.id,
                result: true,
                error: null
            });
        });
    };

    /**
     * Manually authorizes the client.
     * This function manually authorizes the client with the given username and password.
     * @param {string} username The username of the client.
     * @param {string} password The password of the client.
     */
    this.manuallyAuthClient = (username, password) => {
        handleAuthorize({ id: 1, params: [username, password] }, false);
    };

    /**
     * Manually sets values for the client.
     * This function copies values from another client object to this client.
     * @param {Object} otherClient The other client object to copy values from.
     */
    this.manuallySetValues = (otherClient) => {
        _this.extraNonce1 = otherClient.extraNonce1;
        _this.previousDifficulty = otherClient.previousDifficulty;
        _this.difficulty = otherClient.difficulty;
    };
};

// Set up prototype inheritance from EventEmitter
StratumClient.prototype.__proto__ = events.EventEmitter.prototype;

/**
 * Represents a Stratum server.
 * This class handles the communication with multiple mining clients.
 * @param {Object} options The options for the Stratum server.
 * @param {Function} authorizeFn The authorization function.
 * @constructor
 */
const StratumServer = function StratumServer(options, authorizeFn) {
    const _this = this;
    const stratumClients = {};
    const subscriptionCounter = SubscriptionCounter();
    let rebroadcastTimeout;

    /**
     * Handles a new client connection.
     * This function sets up a new Stratum client for the connected socket.
     * @param {Object} socket The socket of the new client.
     * @return {string} The subscription ID of the new client.
     */
    this.handleNewClient = (socket) => {
        socket.setKeepAlive(true);
        const subscriptionId = subscriptionCounter.next();
        const client = new StratumClient({
            subscriptionId: subscriptionId,
            authorizeFn: authorizeFn,
            socket: socket,
            banning: options.banning,
            connectionTimeout: options.connectionTimeout,
            tcpProxyProtocol: options.tcpProxyProtocol,
            hasInitialTarget: false
        });
        stratumClients[subscriptionId] = client;
        _this.emit('client.connected', client);
        client.on('socketDisconnect', () => {
            _this.removeStratumClientBySubId(subscriptionId);
            _this.emit('client.disconnected', client);
        }).init();
        return subscriptionId;
    };

    /**
     * Broadcasts mining jobs to all connected clients.
     * This function sends a new mining job to all connected clients.
     * @param {Array} jobParams The parameters of the mining job.
     */
    this.broadcastMiningJobs = (jobParams) => {
        Object.keys(stratumClients).forEach((clientId) => {
            const client = stratumClients[clientId];
            client.sendMiningJob(jobParams);
        });
    };

    /**
     * Initializes the Stratum server.
     * This function sets up the server to listen for incoming connections.
     */
    const init = () => {
        let serversStarted = 0;
        for (const port in options.ports) {
            net.createServer({ allowHalfOpen: false }, (socket) => {
                _this.handleNewClient(socket);
            }).listen(parseInt(port), () => {
                serversStarted++;
                if (serversStarted == Object.keys(options.ports).length) { _this.emit('started'); }
            });
        }
        clearTimeout(rebroadcastTimeout);
        rebroadcastTimeout = setTimeout(() => {
            _this.emit('broadcastTimeout');
        }, options.jobRebroadcastTimeout * 1000);
    };
    init();

    /**
     * Gets all connected Stratum clients.
     * @return {Object} The connected Stratum clients.
     */
    this.getStratumClients = () => stratumClients;

    /**
     * Removes a Stratum client by subscription ID.
     * This function removes a client from the list of connected clients.
     * @param {string} subscriptionId The subscription ID of the client to remove.
     */
    this.removeStratumClientBySubId = (subscriptionId) => { delete stratumClients[subscriptionId]; };

    /**
     * Manually adds a Stratum client.
     * This function manually adds a client to the list of connected clients.
     * @param {Object} clientObj The client object to add.
     */
    this.manuallyAddStratumClient = (clientObj) => {
        const subId = _this.handleNewClient(clientObj.socket);
        if (subId != null) {
            stratumClients[subId].manuallyAuthClient(clientObj.workerName, clientObj.workerPass);
            stratumClients[subId].manuallySetValues(clientObj);
        }
    };
};

// Set up prototype inheritance from EventEmitter
StratumServer.prototype.__proto__ = events.EventEmitter.prototype;

exports.Server = StratumServer;
