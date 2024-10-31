var net = require('net');
var crypto = require('crypto');
var events = require('events');

var util = require('./util.js');

// Example of p2p in node from TheSeven: http://paste.pm/e54.js

// Creates a fixed length buffer from a string
const fixedLenStringBuffer = (s, len) => {
    var buff = new Buffer.alloc(len);
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
var readFlowingBytes = function (stream, amount, preRead, callback)
{
    var buff = preRead ? preRead : new Buffer.from([]);

    var readData = function (data) {
        buff = Buffer.concat([buff, data]);

        if (buff.length >= amount) {
            var returnData = buff.slice(0, amount);
            var lopped = buff.length > amount ? buff.slice(amount) : null;
            callback(returnData, lopped);
        } else {
            stream.once('data', readData);
        }
    };

    readData(new Buffer.from([]));
};

/**
 * Peer constructor function.
 * @param {Object} options - Configuration options for the peer.
 */
var Peer = module.exports = function (options)
{
    var _this = this;
    var client;
    var magic = new Buffer.from(options.testnet ? options.coin.peerMagicTestnet : options.coin.peerMagic, 'hex');
    var magicInt = magic.readUInt32LE(0);
    var verack = false;
    var validConnectionConfig = true;

    // https://en.bitcoin.it/wiki/Protocol_specification#Inventory_Vectors
    var invCodes = {
        error: 0,
        tx: 1,
        block: 2
    };

    var networkServices = new Buffer.from('0100000000000000', 'hex'); // NODE_NETWORK services (value 1 packed as uint64)
    var emptyNetAddress = new Buffer.from('010000000000000000000000000000000000ffff000000000000', 'hex');
    var userAgent = util.varStringBuffer('komodo-solomining');
    var blockStartHeight = new Buffer.from('00000000', 'hex'); // Block start_height, should be empty unless only ever doing 1 coin

    // If protocol version is new enough, add do not relay transactions flag byte, outlined in BIP37
    // https://github.com/bitcoin/bips/blob/master/bip-0037.mediawiki#extensions-to-existing-messages
    var relayTransactions = options.p2p.disableTransactions === true ? new Buffer.from([false]) : new Buffer.from([]);

    var commands = {
        inv: commandStringBuffer('inv'),
        addr: commandStringBuffer('addr'),
        ping: commandStringBuffer('ping'),
        verack: commandStringBuffer('verack'),
        version: commandStringBuffer('version'),
        getblocks: commandStringBuffer('getblocks')
    };

    // Initialize and connect to the peer
    (function init() {
        Connect();
    })();

    /**
     * Connects to the peer and sets up event handlers.
     */
    function Connect() {
        client = net.connect({
            host: options.p2p.host,
            port: options.p2p.port
        }, function () {
            SendVersion();
        });

        client.on('close', function () {
            if (verack) {
                _this.emit('disconnected');
                verack = false;
                Connect();
            } else if (validConnectionConfig) {
                _this.emit('connectionRejected');
            }
        });

        client.on('error', function (e) {
            if (e.code === 'ECONNREFUSED') {
                validConnectionConfig = false;
                _this.emit('connectionFailed');
            } else {
                _this.emit('socketError', e);
            }
        });

        SetupMessageParser(client);
    }

    /**
     * Sets up the message parser for the client.
     * @param {Object} client - The client object.
     */
    function SetupMessageParser(client) {
        var beginReadingMessage = function (preRead) {
            readFlowingBytes(client, 24, preRead, function (header, lopped) {
                var msgMagic = header.readUInt32LE(0);

                if (msgMagic !== magicInt) {
                    _this.emit('error', 'bad magic number from peer');

                    while (header.readUInt32LE(0) !== magicInt && header.length >= 4) {
                        header = header.slice(1);
                    }

                    if (header.readUInt32LE(0) === magicInt) {
                        beginReadingMessage(header);
                    } else {
                        beginReadingMessage(new Buffer.from([]));
                    }

                    return;
                }

                var msgCommand = header.slice(4, 16).toString();
                var msgLength = header.readUInt32LE(16);
                var msgChecksum = header.readUInt32LE(20);
                readFlowingBytes(client, msgLength, lopped, function (payload, lopped) {
                    if (util.sha256d(payload).readUInt32LE(0) !== msgChecksum) {
                        _this.emit('error', 'bad payload - failed checksum');
                        beginReadingMessage(null);
                        return;
                    }

                    HandleMessage(msgCommand, payload);
                    beginReadingMessage(lopped);
                });
            });
        };

        beginReadingMessage(null);
    }

    // Parsing inv message https://en.bitcoin.it/wiki/Protocol_specification#inv
    /**
     * Handles 'inv' messages from the peer.
     * @param {Buffer} payload - The payload of the 'inv' message.
     */
    function HandleInv(payload) {
        // Sloppy varint decoding
        var count = payload.readUInt8(0);
        payload = payload.slice(1);

        if (count >= 0xfd) {
            count = payload.readUInt16LE(0);
            payload = payload.slice(2);
        }

        while (count--) {
            switch (payload.readUInt32LE(0)) {
                case invCodes.error:
                    break;
                case invCodes.tx:
                    var tx = payload.slice(4, 36).toString('hex');
                    break;
                case invCodes.block:
                    var block = payload.slice(4, 36).toString('hex');
                    _this.emit('blockFound', block);
                    break;
            }

            payload = payload.slice(36);
        }
    }

    /**
     * Handles messages from the peer.
     * @param {string} command - The command of the message.
     * @param {Buffer} payload - The payload of the message.
     */
    function HandleMessage(command, payload) {
        _this.emit('peerMessage', {command: command, payload: payload});

        switch (command) {
            case commands.inv.toString():
                HandleInv(payload);
                break;
            case commands.verack.toString():
                if (!verack) {
                    verack = true;
                    _this.emit('connected');
                }
                break;
            case commands.ping.toString():
                // Respond to ping with pong
                // https://en.bitcoin.it/wiki/Protocol_documentation#pong
                SendMessage(commandStringBuffer('pong'), Buffer.alloc(0));
                break;
            default:
                break;
        }
    }

    // Message structure defined at: https://en.bitcoin.it/wiki/Protocol_specification#Message_structure
    /**
     * Sends a message to the peer.
     * @param {Buffer} command - The command buffer.
     * @param {Buffer} payload - The payload buffer.
     */
    function SendMessage(command, payload) {
        var message = Buffer.concat([
            magic,
            command,
            util.packUInt32LE(payload.length),
            util.sha256d(payload).slice(0, 4),
            payload
        ]);
        client.write(message);
        _this.emit('sentMessage', message);
    }

    /**
     * Sends the version message to the peer.
     */
    function SendVersion() {
        // https://en.bitcoin.it/wiki/Protocol_documentation#version
        var payload = Buffer.concat([
            util.packUInt32LE(options.protocolVersion),
            networkServices,
            util.packInt64LE(Date.now() / 1000 | 0),
            emptyNetAddress, // addr_recv, can be empty
            emptyNetAddress, // addr_from, can be empty
            crypto.pseudoRandomBytes(8), // nonce, random unique ID
            userAgent,
            blockStartHeight,
            relayTransactions
        ]);
        SendMessage(commands.version, payload);
    }
};

// Inherit from EventEmitter
Peer.prototype.__proto__ = events.EventEmitter.prototype;
