var net = require('net');
var events = require('events');

/**
 * Listener constructor function.
 * @param {number} port - The port number to listen on.
 */
var listener = module.exports = function listener(port) {
    var _this = this;

    /**
     * Emit a log event.
     * @param {string} text - The text to log.
     */
    var emitLog = (text) => {
        _this.emit('log', text);
    };

    /**
     * Check if a string is valid JSON.
     * @param {string} str - The string to check.
     * @returns {boolean} - True if the string is valid JSON, false otherwise.
     */
    function isJson(str) {
        try {
            JSON.parse(str);
        } catch (e) {
            return false;
        }
        return true;
    }

    /**
     * Start the CLI listener.
     */
    this.start = () => {
        net.createServer((c) => {
            var data = '';
            try {
                c.on('data', (d) => {
                    // Check if the incoming data is valid JSON
                    if (isJson(d.toString())) {
                        data += d;
                        // Check if the data ends with a newline character
                        if (data.slice(-1) === '\n') {
                            var message = JSON.parse(data);
                            // Emit a command event with the parsed message
                            _this.emit('command', message.command, message.params, message.options, function(message) {
                                c.end(message);
                            });
                        }
                    } else {
                        // Send an error message if the data is not valid JSON
                        c.end(`You must send JSON, not: ${d.toString()}`);
                        return;
                    }
                }).on('end', () => {
                    // Handle end of connection
                }).on('error', () => {
                    // Handle connection error
                });
            } catch(e) {
                emitLog(`CLI listener failed to parse message ${data}`);
            }

        }).listen(port, '127.0.0.1', () => {
            emitLog(`CLI listening on port ${port}`);
        });
    };
};

// Inherit from EventEmitter
listener.prototype.__proto__ = events.EventEmitter.prototype;
