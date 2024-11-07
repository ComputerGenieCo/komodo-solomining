const net = require('net');
const crypto = require('crypto');
const events = require('events');
const util = require('@helpers/util.js');

// Example of p2p in node from TheSeven: http://paste.pm/e54.js

// Creates a fixed length buffer from a string
const fixedLenStringBuffer = (s, len) => {
    const buff = Buffer.alloc(len);
    buff.fill(0);
    buff.write(s);
    return buff;
};

// Creates a command string buffer with a fixed length of 12
const commandStringBuffer = (s) => fixedLenStringBuffer(s, 12);

/**
 * Reads a set amount of bytes from a flowing stream.
 * @param {Stream} stream - The stream to read from, must have data emitter.
 * @param {number} amount - The amount of bytes to read.
 * @param {Buffer} preRead - Optional pre-read buffer to start with.
 * @param {function} callback - Callback that returns data buffer and lopped/over-read data.
 */
const readFlowingBytes = (stream, amount, preRead, callback) => {
    let buff = preRead ? preRead : Buffer.from([]);

    const readData = (data) => {
        buff = Buffer.concat([buff, data]);

        if (buff.length >= amount) {
            const returnData = buff.subarray(0, amount);
            const lopped = buff.length > amount ? buff.subarray(amount) : null;
            callback(returnData, lopped);
        } else {
            stream.once('data', readData);
        }
    };

    readData(Buffer.from([]));
};

class Peer extends events.EventEmitter {
    /**
     * Peer constructor function.
     * @param {Object} options - Configuration options for the peer.
     */
    constructor(options) {
        super();
        this.options = options;
        this.client = null;
        this.magic = Buffer.from(options.testnet ? options.coin.peerMagicTestnet : options.coin.peerMagic, 'hex');
        this.magicInt = this.magic.readUInt32LE(0);
        this.verack = false;
        this.validConnectionConfig = true;

        // https://en.bitcoin.it/wiki/Protocol_specification#Inventory_Vectors
        this.invCodes = {
            error: 0,
            tx: 1,
            block: 2
        };

        this.networkServices = Buffer.from('0100000000000000', 'hex'); // NODE_NETWORK services (value 1 packed as uint64)
        this.emptyNetAddress = Buffer.from('010000000000000000000000000000000000ffff000000000000', 'hex');
        this.userAgent = util.varStringBuffer('komodo-solomining');
        this.blockStartHeight = Buffer.from('00000000', 'hex'); // Block start_height, should be empty unless only ever doing 1 coin

        // If protocol version is new enough, add do not relay transactions flag byte, outlined in BIP37
        // https://github.com/bitcoin/bips/blob/master/bip-0037.mediawiki#extensions-to-existing-messages
        this.relayTransactions = options.p2p.disableTransactions === true ? Buffer.from([false]) : Buffer.from([]);

        this.commands = {
            inv: commandStringBuffer('inv'),
            addr: commandStringBuffer('addr'),
            ping: commandStringBuffer('ping'),
            verack: commandStringBuffer('verack'),
            version: commandStringBuffer('version'),
            getblocks: commandStringBuffer('getblocks')
        };

        this.init();
    }

    /**
     * Initialize and connect to the peer.
     */
    init() {
        this.connect();
    }

    /**
     * Connects to the peer and sets up event handlers.
     */
    connect() {
        this.client = net.connect({
            host: this.options.p2p.host,
            port: this.options.p2p.port
        }, () => {
            this.sendVersion();
        });

        this.client.on('close', () => {
            if (this.verack) {
                this.emit('disconnected');
                this.verack = false;
                this.connect();
            } else if (this.validConnectionConfig) {
                this.emit('connectionRejected');
            }
        });

        this.client.on('error', (e) => {
            if (e.code === 'ECONNREFUSED') {
                this.validConnectionConfig = false;
                this.emit('connectionFailed');
            } else {
                this.emit('socketError', e);
            }
        });

        this.setupMessageParser(this.client);
    }

    /**
     * Sets up the message parser for the client.
     * @param {Object} client - The client object.
     */
    setupMessageParser(client) {
        const beginReadingMessage = (preRead) => {
            readFlowingBytes(client, 24, preRead, (header, lopped) => {
                const msgMagic = header.readUInt32LE(0);

                if (msgMagic !== this.magicInt) {
                    this.emit('error', 'bad magic number from peer');

                    while (header.readUInt32LE(0) !== this.magicInt && header.length >= 4) {
                        header = header.subarray(1);
                    }

                    if (header.readUInt32LE(0) === this.magicInt) {
                        beginReadingMessage(header);
                    } else {
                        beginReadingMessage(Buffer.from([]));
                    }

                    return;
                }

                const msgCommand = header.subarray(4, 16).toString();
                const msgLength = header.readUInt32LE(16);
                const msgChecksum = header.readUInt32LE(20);

                readFlowingBytes(client, msgLength, lopped, (payload, lopped) => {
                    if (util.sha256d(payload).readUInt32LE(0) !== msgChecksum) {
                        this.emit('error', 'bad payload - failed checksum');
                        beginReadingMessage(null);
                        return;
                    }

                    this.handleMessage(msgCommand, payload);
                    beginReadingMessage(lopped);
                });
            });
        };

        beginReadingMessage(null);
    }

    /**
     * Handles messages from the peer.
     * @param {string} command - The command of the message.
     * @param {Buffer} payload - The payload of the message.
     */
    handleMessage(command, payload) {
        this.emit('peerMessage', {command, payload});

        switch (command) {
            case this.commands.inv.toString():
                this.handleInv(payload);
                break;
            case this.commands.verack.toString():
                if (!this.verack) {
                    this.verack = true;
                    this.emit('connected');
                }
                break;
            case this.commands.ping.toString():
                // Respond to ping with pong
                // https://en.bitcoin.it/wiki/Protocol_documentation#pong
                this.sendMessage(commandStringBuffer('pong'), Buffer.alloc(0));
                break;
            default:
                break;
        }
    }

    // Parsing inv message https://en.bitcoin.it/wiki/Protocol_specification#inv
    /**
     * Handles 'inv' messages from the peer.
     * @param {Buffer} payload - The payload of the 'inv' message.
     */
    handleInv(payload) {
        // Sloppy varint decoding
        let count = payload.readUInt8(0);
        payload = payload.subarray(1);

        if (count >= 0xfd) {
            count = payload.readUInt16LE(0);
            payload = payload.subarray(2);
        }

        for (let i = 0; i < count; i++) {
            const type = payload.readUInt32LE(0);
            const data = payload.subarray(4, 36).toString('hex');

            switch (type) {
                case this.invCodes.error:
                    break;
                case this.invCodes.tx:
                    var tx = data;
                    break;
                case this.invCodes.block:
                    this.emit('blockFound', data);
                    break;
            }

            payload = payload.subarray(36);
        }
    }

    // Message structure defined at: https://en.bitcoin.it/wiki/Protocol_specification#Message_structure
    /**
     * Sends a message to the peer.
     * @param {Buffer} command - The command buffer.
     * @param {Buffer} payload - The payload buffer.
     */
    sendMessage(command, payload) {
        const message = Buffer.concat([
            this.magic,
            command,
            util.packUInt32LE(payload.length),
            util.sha256d(payload).subarray(0, 4),
            payload
        ]);
        this.client.write(message);
        this.emit('sentMessage', message);
    }

    /**
     * Sends the version message to the peer.
     */
    sendVersion() {
        // https://en.bitcoin.it/wiki/Protocol_documentation#version
        const payload = Buffer.concat([
            util.packUInt32LE(this.options.protocolVersion),
            this.networkServices,
            util.packInt64LE(Date.now() / 1000 | 0),
            this.emptyNetAddress, // addr_recv, can be empty
            this.emptyNetAddress, // addr_from, can be empty
            crypto.pseudoRandomBytes(8), // nonce, random unique ID
            this.userAgent,
            this.blockStartHeight,
            this.relayTransactions
        ]);
        this.sendMessage(this.commands.version, payload);
    }
}

module.exports = Peer;
