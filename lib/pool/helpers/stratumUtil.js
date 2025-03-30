const util = require('./util.js');

/**
 * Creates a subscription counter.
 * This counter generates unique subscription IDs for clients.
 * @return {Object} An object with a method to generate the next subscription ID.
 */
const SubscriptionCounter = function () {
    let count = 0;
    const padding = 'deadbeefcafebabe';
    return {
        /**
         * Generates the next subscription ID.
         * @return {string} The next subscription ID.
         */
        next: function () {
            count++;
            if (Number.MAX_VALUE === count) { count = 0; }
            return padding + util.packInt64LE(count).toString('hex');
        }
    };
};

/**
 * Sends a JSON response to the client.
 * @param {...Object} args The JSON objects to send.
 */
const sendJson = (socket, ...args) => {
    let response = '';
    args.forEach(arg => {
        response += JSON.stringify(arg) + '\n';
    });
    socket.write(response);
};

/**
 * Sets up the socket to handle incoming data and events.
 * This function sets up event listeners for the socket.
 */
const setupSocket = (options, handleMessage, self) => {
    const socket = options.socket;
    let dataBuffer = '';
    socket.setEncoding('utf8');
    socket.on('data', (d) => {
        dataBuffer += d;
        // Check if data buffer exceeds 10KB
        if (Buffer.byteLength(dataBuffer, 'utf8') > 10240) {
            dataBuffer = '';
            self.emit('socketFlooded');
            socket.destroy();
            return;
        }
        if (dataBuffer.indexOf('\n') !== -1) {
            const messages = dataBuffer.split('\n');
            const incomplete = dataBuffer.slice(-1) === '\n' ? '' : messages.pop();
            messages.forEach((message) => {
                if (message.length < 1) { return; }
                let messageJson;
                try {
                    messageJson = JSON.parse(message);
                } catch (e) {
                    if (options.tcpProxyProtocol !== true || d.indexOf('PROXY') !== 0) {
                        self.emit('malformedMessage', message);
                        socket.destroy();
                    }
                    return;
                }
                if (messageJson) { handleMessage(messageJson); }
            });
            dataBuffer = incomplete;
        }
    });
    socket.on('close', () => { self.emit('socketDisconnect'); });
    socket.on('error', (err) => {
        if (err.code !== 'ECONNRESET') {
            self.emit('socketError', err);
        }
    });
};

/**
 * Sanitizes a string to ensure it contains only safe characters.
 * This helps prevent injection attacks.
 * @param {string} s The string to sanitize.
 * @return {string} The sanitized string.
 */
const getSafeString = (s) => s.toString().replace(/[^a-zA-Z0-9.]+/g, '');

/**
 * Sanitizes and formats a worker string.
 * This ensures the worker string is safe and properly formatted.
 * @param {string} raw The raw worker string.
 * @return {string} The sanitized and formatted worker string.
 */
const getSafeWorkerString = (raw) => {
    const s = getSafeString(raw).split(".");
    const addr = s[0];
    const wname = s.length > 1 ? s[1] : "noname";
    return `${addr}.${wname}`;
};

module.exports = {
    SubscriptionCounter,
    sendJson,
    setupSocket,
    getSafeString,
    getSafeWorkerString
};
