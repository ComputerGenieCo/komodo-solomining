const net = require('net');
const EventEmitter = require('events');

class Listener extends EventEmitter {
    /**
     * Listener constructor function.
     * @param {number} port - The port number to listen on.
     */
    constructor(port) {
        super();
        this.port = port;
    }

    /**
     * Emit a log event.
     * @param {string} text - The text to log.
     */
    emitLog = (text) => {
        this.emit('log', text);
    };

    /**
     * Check if a string is valid JSON.
     * @param {string} str - The string to check.
     * @returns {boolean} - True if the string is valid JSON, false otherwise.
     */
    isJson = (str) => {
        try {
            JSON.parse(str);
        } catch (e) {
            return false;
        }
        return true;
    };

    /**
     * Start the CLI listener.
     */
    start = () => {
        net.createServer((c) => {
            let data = '';
            try {
                c.on('data', (d) => {
                    // Check if the incoming data is valid JSON
                    if (this.isJson(d.toString())) {
                        data += d;
                        // Check if the data ends with a newline character
                        if (data.slice(-1) === '\n') {
                            const message = JSON.parse(data);
                            // Emit a command event with the parsed message
                            this.emit('command', message.command, message.params, message.options, (response) => {
                                c.end(response);
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
            } catch (e) {
                this.emitLog(`CLI listener failed to parse message ${data}`);
            }
        }).listen(this.port, '127.0.0.1', () => {
            this.emitLog(`CLI listening on port ${this.port}`);
        });
    };
}

module.exports = Listener;
