const net = require('net');
const events = require('events');
const logging = require('@middlewares/logging.js');
const algos = require('@blockchain/algoProperties.js');
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
    const self = this;
    this.lastActivity = Date.now();

    /**
     * Initializes the client by setting up the socket.
     */
    this.init = function init() { setupSocket(options, handleMessage, self); };

    /**
     * Gets a label for the client.
     * This label is used for logging and identification purposes.
     * @return {string} The label for the client.
     */
    this.getLabel = () => `${self.workerName || '(unauthorized)'} [${self.remoteAddress}]`;

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
                self.lastActivity = Date.now();
                handleSubmit(message);
                break;
            case 'mining.extranonce.subscribe':
                sendJson(self.socket, {
                    id: message.id,
                    result: false,
                    error: [20, "Not supported.", null]
                });
                break;
            default:
                self.emit('unknownStratumMethod', message);
                break;
        }
    };

    /**
     * Handles subscription requests from the client.
     * @param {Object} message The subscription message from the client.
     */
    const handleSubscribe = (message) => {
        if (!self.authorized) { self.requestedSubscriptionBeforeAuth = true; }
        self.emit('subscription', {}, (error, extraNonce1) => {
            if (error) {
                sendJson(self.socket, {
                    id: message.id,
                    result: null,
                    error: error
                });
                return;
            }
            self.extraNonce1 = extraNonce1;
            sendJson(self.socket, {
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
        self.workerName = getSafeWorkerString(message.params[0]);
        self.workerPass = getSafeString(message.params[1]);
        self.config = JSON.parse(process.env.config);
        const addr = self.workerName.split(".")[0];
        options.authorizeFn(self.remoteAddress, options.socket.localPort, addr, self.workerPass, (result) => {
            self.authorized = (!result.error && result.authorized);
            sendJson(self.socket, {
                id: message.id,
                result: self.authorized,
                error: result.error
            });
            if (self.authorized) {
                difficulty = self.config.ports[options.socket.localPort].diff;
                self.sendDifficulty(difficulty); // Send target after authorization
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
        if (!self.authorized) {
            return false;
        }
            
        if (difficulty === this.difficulty) {
            return false;
        }
        if (!options.hasInitialTarget || typeof self.difficulty === 'undefined') {
            self.difficulty = difficulty;
            options.hasInitialTarget = true;
        }
        self.previousDifficulty = self.difficulty;
        self.difficulty = difficulty;

        // Calculate the scaling factor
        const scalingFactor = algos.zcash.diff1 / algos.komodo.diff1;

        // Scale the target
        const scaledTarget = algos.komodo.diff1 / (difficulty / scalingFactor);

        const zeroPad = (64 - scaledTarget.toString(16).length) === 0 ? '' : '0'.repeat((64 - (scaledTarget.toString(16)).length));
        const target = (zeroPad + scaledTarget.toString(16)).substr(0, 64);
        sendJson(self.socket, {
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
        const lastActivityAgo = Date.now() - self.lastActivity;
        // Check if the client has been inactive for too long
        if (lastActivityAgo > options.connectionTimeout * 1000) {
            self.socket.destroy();
            return;
        }
        if (!self.authorized) {
            return;
        }
        if (pendingDifficulty !== null) {
            const result = self.sendDifficulty(pendingDifficulty);
            pendingDifficulty = null;
            if (result) { self.emit('difficultyChanged', self.difficulty); }
        } else {
            // Ensure difficulty is sent even if VarDiff is not used
            self.sendDifficulty(self.difficulty);
        }
        sendJson(self.socket, {
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
        if (!self.workerName) { self.workerName = getSafeWorkerString(message.params[0]); }
        if (self.authorized === false) {
            sendJson(self.socket, {
                id: message.id,
                result: null,
                error: [24, "unauthorized worker", null]
            });
            return;
        }
        if (!self.extraNonce1) {
            sendJson(self.socket, {
                id: message.id,
                result: null,
                error: [25, "not subscribed", null]
            });
            return;
        }
        self.emit('submit', {
            name: self.workerName,
            jobId: message.params[1],
            nTime: message.params[2],
            extraNonce2: message.params[3],
            soln: message.params[4],
            nonce: self.extraNonce1 + message.params[3]
        }, (error, result) => {
            sendJson(self.socket, {
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
        self.extraNonce1 = otherClient.extraNonce1;
        self.previousDifficulty = otherClient.previousDifficulty;
        self.difficulty = otherClient.difficulty;
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
    const self = this;
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
        self.emit('client.connected', client);
        client.on('socketDisconnect', () => {
            self.removeStratumClientBySubId(subscriptionId);
            self.emit('client.disconnected', client);
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
                self.handleNewClient(socket);
            }).listen(parseInt(port), () => {
                serversStarted++;
                if (serversStarted == Object.keys(options.ports).length) { self.emit('started'); }
            });
        }
        clearTimeout(rebroadcastTimeout);
        rebroadcastTimeout = setTimeout(() => {
            self.emit('broadcastTimeout');
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
        const subId = self.handleNewClient(clientObj.socket);
        if (subId != null) {
            stratumClients[subId].manuallyAuthClient(clientObj.workerName, clientObj.workerPass);
            stratumClients[subId].manuallySetValues(clientObj);
        }
    };
};

// Set up prototype inheritance from EventEmitter
StratumServer.prototype.__proto__ = events.EventEmitter.prototype;

exports.Server = StratumServer;
