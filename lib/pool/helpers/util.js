const crypto = require('crypto');
const bitcoin = require('bitgo-utxo-lib');

// Add base58 alphabet and functions
const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const ALPHABET_MAP = {};
for (let i = 0; i < ALPHABET.length; i++) {
    ALPHABET_MAP[ALPHABET.charAt(i)] = i;
}

// Native base58 encode implementation
const base58Encode = (buffer) => {
    let carry, digits = [0];
    for (let i = 0; i < buffer.length; i++) {
        carry = buffer[i];
        for (let j = 0; j < digits.length; j++) {
            carry += digits[j] << 8;
            digits[j] = carry % 58;
            carry = (carry / 58) | 0;
        }
        while (carry > 0) {
            digits.push(carry % 58);
            carry = (carry / 58) | 0;
        }
    }

    let result = '';
    for (let i = 0; i < buffer.length && buffer[i] === 0; i++) {
        result += '1';
    }
    for (let i = digits.length - 1; i >= 0; i--) {
        result += ALPHABET[digits[i]];
    }
    return result;
};

// Native base58 decode implementation
const base58Decode = (string) => {
    let bytes = [0];
    for (let i = 0; i < string.length; i++) {
        let value = ALPHABET_MAP[string[i]];
        if (value === undefined) {
            throw new Error('Invalid base58 string');
        }
        for (let j = 0; j < bytes.length; j++) {
            value += bytes[j] * 58;
            bytes[j] = value & 0xff;
            value >>= 8;
        }
        while (value > 0) {
            bytes.push(value & 0xff);
            value >>= 8;
        }
    }

    for (let i = 0; i < string.length && string[i] === '1'; i++) {
        bytes.push(0);
    }

    return Buffer.from(bytes.reverse());
}

// Add new BigInt utility functions
exports.bigIntFromBitsBuffer = function (bitsBuff) {
    const numBytes = bitsBuff.readUInt8(0);
    const slice = bitsBuff.slice(1);
    const bigBits = BigInt('0x' + slice.toString('hex'));
    const target = bigBits * (BigInt(2) ** BigInt(8 * (numBytes - 3)));
    return target;
};

exports.bigIntFromBitsHex = function (bitsString) {
    const bitsBuff = Buffer.from(bitsString, 'hex');
    return exports.bigIntFromBitsBuffer(bitsBuff);
};

exports.bigIntToBuffer = function (bigInt, size = 32) {
    let hex = bigInt.toString(16).padStart(size * 2, '0');
    return Buffer.from(hex, 'hex');
};

exports.bufferToBigInt = function (buffer) {
    return BigInt('0x' + buffer.toString('hex'));
};

/**
 * Computes the SHA-256 hash of a buffer.
 * @param {Buffer} buffer - The input buffer.
 * @returns {Buffer} The SHA-256 hash.
 */
exports.sha256 = function (buffer) {
    var hash1 = crypto.createHash('sha256');
    hash1.update(buffer);
    return hash1.digest();
};

/**
 * Computes the double SHA-256 hash of a buffer.
 * @param {Buffer} buffer - The input buffer.
 * @returns {Buffer} The double SHA-256 hash.
 */
exports.sha256d = function (buffer) {
    return exports.sha256(exports.sha256(buffer));
};

/**
 * Reverses the byte order of a buffer.
 * @param {Buffer} buff - The input buffer.
 * @returns {Buffer} The buffer with reversed byte order.
 */
exports.reverseBuffer = function (buff) {
    var reversed = new Buffer.alloc(buff.length);

    for (var i = buff.length - 1; i >= 0; i--) {
        reversed[buff.length - i - 1] = buff[i];
    }

    return reversed;
};

/**
 * Reverses the byte order of a hexadecimal string.
 * @param {string} hex - The input hexadecimal string.
 * @returns {string} The hexadecimal string with reversed byte order.
 */
exports.reverseHex = function (hex) {
    return exports.reverseBuffer(new Buffer.from(hex, 'hex')).toString('hex');
};

/**
 * Reverses the byte order of a buffer in 32-bit chunks.
 * @param {Buffer} buff - The input buffer.
 * @returns {Buffer} The buffer with reversed 32-bit chunks.
 */
exports.reverseByteOrder = function (buff) {
    for (var i = 0; i < 8; i++) {
        buff.writeUInt32LE(buff.readUInt32BE(i * 4), i * 4);
    }

    return exports.reverseBuffer(buff);
};

/**
 * Converts a hexadecimal string to a uint256 buffer with reversed byte order.
 * @param {string} hex - The input hexadecimal string.
 * @returns {Buffer} The uint256 buffer with reversed byte order.
 */
exports.uint256BufferFromHash = function (hex) {

    var fromHex = new Buffer.from(hex, 'hex');

    if (fromHex.length != 32) {
        var empty = new Buffer.alloc(32);
        empty.fill(0);
        fromHex.copy(empty);
        fromHex = empty;
    }

    return exports.reverseBuffer(fromHex);
};

/**
 * Converts a buffer to a hexadecimal string with reversed byte order.
 * @param {Buffer} buffer - The input buffer.
 * @returns {string} The hexadecimal string with reversed byte order.
 */
exports.hexFromReversedBuffer = function (buffer) {
    return exports.reverseBuffer(buffer).toString('hex');
};

/**
 * Reverses the endianness of a given hexadecimal string.
 *
 * This function takes a hexadecimal string and reverses its endianness.
 * Endianness refers to the order of bytes in a multi-byte number. Reversing
 * the endianness means to reverse the byte order.
 *
 * @param {string} hexString - The hexadecimal string to reverse.
 * @returns {string} The hexadecimal string with reversed endianness.
 * @throws {Error} If the input hexadecimal string has an odd length.
 */
exports.reverseEndianness = (hexString) => {
    if (hexString.length % 2 !== 0) {
        throw new Error("Invalid hex string");
    }
    return hexString.match(/../g).reverse().join('');
};

/**
 * Converts a string to its hexadecimal representation.
 * @param {string} str - The input string.
 * @returns {string} The hexadecimal representation of the string.
 */
exports.toHexy = function (str) {
    var arr1 = [];
    for (var n = 0, l = str.length; n < l; n++) {
        var hex = Number(str.charCodeAt(n)).toString(16);
        arr1.push(hex);
    }
    return arr1.join("");
}

/*
 Defined in bitcoin protocol here:
 https://en.bitcoin.it/wiki/Protocol_specification#Variable_length_integer
 */
/**
 * Converts an integer to a variable length integer buffer.
 * @param {number} n - The input integer.
 * @returns {Buffer} The variable length integer buffer.
 */
exports.varIntBuffer = function (n) {
    if (n < 0xfd) {
        return new Buffer.from([n]);
    } else if (n <= 0xffff) {
        var buff = new Buffer.alloc(3);
        buff[0] = 0xfd;
        buff.writeUInt16LE(n, 1);
        return buff;
    } else if (n <= 0xffffffff) {
        var buff = new Buffer.alloc(5);
        buff[0] = 0xfe;
        buff.writeUInt32LE(n, 1);
        return buff;
    } else {
        var buff = new Buffer.alloc(9);
        buff[0] = 0xff;
        exports.packUInt16LE(n).copy(buff, 1);
        return buff;
    }
};

/**
 * Converts a string to a variable length string buffer.
 * @param {string} string - The input string.
 * @returns {Buffer} The variable length string buffer.
 */
exports.varStringBuffer = function (string) {
    var strBuff = new Buffer.from(string);
    return new Buffer.concat([exports.varIntBuffer(strBuff.length), strBuff]);
};

/*
 "serialized CScript" formatting as defined here:
 https://github.com/bitcoin/bips/blob/master/bip-0034.mediawiki#specification
 Used to format height and date when putting into script signature:
 https://en.bitcoin.it/wiki/Script
 */
/**
 * Serializes a number into a Bitcoin script number format.
 * @param {number} n - The input number.
 * @returns {Buffer} The serialized number buffer.
 */
exports.serializeNumber = function (n) {
    if (n >= 1 && n <= 16) {
        return new Buffer.from([0x50 + n]);
    }

    var l = 1;
    var buff = new Buffer.alloc(9);

    while (n > 0x7f) {
        buff.writeUInt8(n & 0xff, l++);
        n >>= 8;
    }

    buff.writeUInt8(l, 0);
    buff.writeUInt8(n, l++);
    return buff.slice(0, l);
};

/*
 Used for serializing strings used in script signature
 */
/**
 * Serializes a string into a Bitcoin script string format.
 * @param {string} s - The input string.
 * @returns {Buffer} The serialized string buffer.
 */
exports.serializeString = function (s) {
    if (s.length < 253)
        return new Buffer.concat([
            new Buffer.alloc([s.length]),
            new Buffer.from(s)
        ]);
    else if (s.length < 0x10000)
        return new Buffer.concat([
            new Buffer.from([253]),
            exports.packUInt16LE(s.length),
            new Buffer.from(s)
        ]);
    else if (s.length < 0x100000000)
        return new Buffer.concat([
            new Buffer.from([254]),
            exports.packUInt32LE(s.length),
            new Buffer.from(s)
        ]);
    else
        return new Buffer.concat([
            new Buffer.from([255]),
            exports.packUInt16LE(s.length),
            new Buffer.from(s)
        ]);
};

/**
 * Packs a 16-bit unsigned integer into a little-endian buffer.
 * @param {number} num - The input number.
 * @returns {Buffer} The packed buffer.
 */
exports.packUInt16LE = function (num) {
    var buff = new Buffer.alloc(2);
    buff.writeUInt16LE(num, 0);
    return buff;
};

/**
 * Packs a 32-bit signed integer into a little-endian buffer.
 * @param {number} num - The input number.
 * @returns {Buffer} The packed buffer.
 */
exports.packInt32LE = function (num) {
    var buff = new Buffer.alloc(4);
    buff.writeInt32LE(num, 0);
    return buff;
};

/**
 * Packs a 32-bit signed integer into a big-endian buffer.
 * @param {number} num - The input number.
 * @returns {Buffer} The packed buffer.
 */
exports.packInt32BE = function (num) {
    var buff = new Buffer.alloc(4);
    buff.writeInt32BE(num, 0);
    return buff;
};

/**
 * Packs a 32-bit unsigned integer into a little-endian buffer.
 * @param {number} num - The input number.
 * @returns {Buffer} The packed buffer.
 */
exports.packUInt32LE = function (num) {
    var buff = new Buffer.alloc(4);
    buff.writeUInt32LE(num, 0);
    return buff;
};

/**
 * Packs a 32-bit unsigned integer into a big-endian buffer.
 * @param {number} num - The input number.
 * @returns {Buffer} The packed buffer.
 */
exports.packUInt32BE = function (num) {
    var buff = new Buffer.alloc(4);
    buff.writeUInt32BE(num, 0);
    return buff;
};

/**
 * Packs a 64-bit signed integer into a little-endian buffer.
 * @param {number} num - The input number.
 * @returns {Buffer} The packed buffer.
 */
exports.packInt64LE = function (num) {
    var buff = new Buffer.alloc(8);
    buff.writeUInt32LE(num % Math.pow(2, 32), 0);
    buff.writeUInt32LE(Math.floor(num / Math.pow(2, 32)), 4);
    return buff;
};

/*
 An exact copy of python's range feature. Written by Tadeck:
 http://stackoverflow.com/a/8273091
 */
/**
 * Generates a range of numbers similar to Python's range function.
 * @param {number} start - The start of the range.
 * @param {number} stop - The end of the range.
 * @param {number} step - The step between numbers.
 * @returns {number[]} The array of numbers in the range.
 */
exports.range = function (start, stop, step) {
    if (typeof stop === 'undefined') {
        stop = start;
        start = 0;
    }

    if (typeof step === 'undefined') {
        step = 1;
    }

    if ((step > 0 && start >= stop) || (step < 0 && start <= stop)) {
        return [];
    }

    var result = [];

    for (var i = start; step > 0 ? i < stop : i > stop; i += step) {
        result.push(i);
    }

    return result;
};

/*
 For POS coins - used to format wallet address for use in generation transaction's output
 */
/**
 * Converts a public key to a script for POS coins.
 * @param {string} key - The public key in hex format.
 * @returns {Buffer} The script buffer.
 */
exports.pubkeyToScript = function (key) {
    if (key.length !== 66) {
        console.error('Invalid pubkey: ' + key);
        throw new Error();
    }

    var pubkey = new Buffer.alloc(35);
    pubkey[0] = 0x21;
    pubkey[34] = 0xac;
    new Buffer.from(key, 'hex').copy(pubkey, 1);
    return pubkey;
};

/**
 * Converts a mining key to a script for POS coins.
 * @param {string} key - The mining key in hex format.
 * @returns {Buffer} The script buffer.
 */
exports.miningKeyToScript = function (key) {
    var keyBuffer = new Buffer.from(key, 'hex');
    return new Buffer.concat([new Buffer.from([0x76, 0xa9, 0x14]), keyBuffer, new Buffer.from([0x88, 0xac])]);
};

/*
 For POW coins - used to format wallet address for use in generation transaction's output
 */
/**
 * Converts a Bitcoin address to a script for POW coins.
 * @param {string} addr - The Bitcoin address.
 * @returns {Buffer} The script buffer.
 */
exports.addressToScript = function (addr) {
    var decoded = base58Decode(addr);

    if (decoded.length !== 25 && decoded.length !== 26) {
        console.error('invalid address length for ' + addr);
        throw new Error();
    }

    var pubkey = decoded.slice(1, -4);
    return new Buffer.concat([new Buffer.from([0x76, 0xa9, 0x14]), pubkey, new Buffer.from([0x88, 0xac])]);
};

/**
 * Converts a hashrate to a human-readable string.
 * @param {number} hashrate - The hashrate in hashes per second.
 * @returns {string} The human-readable hashrate string.
 */
exports.getReadableHashRateString = function (hashrate) {
    var i = -1;
    var byteUnits = [' KSol/s', ' MSol/s', ' GSol/s', ' TSol/s', ' PSol/s'];
    do {
        hashrate = hashrate / 1024;
        i++;
    } while (hashrate > 1024);

    return hashrate.toFixed(2) + byteUnits[i];
};

/**
 * Creates a non-truncated max difficulty by bitwise right-shifting the max value of a uint256.
 * @param {number} shiftRight - The number of bits to shift right.
 * @returns {Buffer} The shifted buffer.
 */
exports.shiftMax256Right = function (shiftRight) {
    const maxUint256 = (BigInt(1) << BigInt(256)) - BigInt(1);
    const shifted = maxUint256 >> BigInt(shiftRight);
    return exports.bigIntToBuffer(shifted);
};

/**
 * Converts a buffer to compact bits format.
 * @param {Buffer} startingBuff - The input buffer.
 * @returns {Buffer} The compact bits buffer.
 */
exports.bufferToCompactBits = function (startingBuff) {
    const num = exports.bufferToBigInt(startingBuff);
    let size = Math.ceil(num.toString(16).length / 2);
    let compact;

    if (size <= 3) {
        compact = num << BigInt(8 * (3 - size));
    } else {
        compact = num >> BigInt(8 * (size - 3));
    }

    const result = Buffer.alloc(4);
    result.writeUInt8(size);
    const compactHex = compact.toString(16).padStart(6, '0');
    result.write(compactHex, 1, 3, 'hex');
    return result;
};

/**
 * Converts a bits buffer to a target buffer.
 * @param {Buffer} bitsBuff - The bits buffer.
 * @returns {Buffer} The target buffer.
 */
exports.convertBitsToBuff = function (bitsBuff) {
    const target = exports.bigIntFromBitsBuffer(bitsBuff);
    const resultBuff = exports.bigIntToBuffer(target);
    const buff256 = Buffer.alloc(32);
    buff256.fill(0);
    resultBuff.copy(buff256, buff256.length - resultBuff.length);
    return buff256;
};

/**
 * Gets a truncated difficulty buffer by shifting the max value of a uint256.
 * @param {number} shift - The number of bits to shift.
 * @returns {Buffer} The truncated difficulty buffer.
 */
exports.getTruncatedDiff = function (shift) {
    return exports.convertBitsToBuff(exports.bufferToCompactBits(exports.shiftMax256Right(shift)));
};

/**
 * Compiles a Bitcoin script for a given address hash.
 * @param {Buffer} addrHash - The address hash.
 * @returns {Buffer} The compiled script.
 */
exports.scriptCompile = addrHash => bitcoin.script.compile([
    bitcoin.opcodes.OP_DUP,         // hex: 76
    bitcoin.opcodes.OP_HASH160,     // hex: A9
    addrHash,
    bitcoin.opcodes.OP_EQUALVERIFY, // hex: 88
    bitcoin.opcodes.OP_CHECKSIG     // hex: AC
]);

/**
 * Compiles a Bitcoin script for a given public key.
 * @param {string} pubkey - The public key in hex format.
 * @returns {Buffer} The compiled script.
 */
exports.scriptCompileP2PK = pubkey => bitcoin.script.compile([
    Buffer.from(pubkey, 'hex'),
    bitcoin.opcodes.OP_CHECKSIG     // hex: AC
]);

/**
 * Compiles a Bitcoin script for a given founder's address.
 * @param {Buffer} address - The founder's address.
 * @returns {Buffer} The compiled script.
 */
exports.scriptFoundersCompile = address => bitcoin.script.compile([
    bitcoin.opcodes.OP_HASH160,     // hex: A9
    address,
    bitcoin.opcodes.OP_EQUAL        // hex: 87
]);

/**
 * Generates a Bitcoin address from an extended address and a ripemd160 key.
 * @param {string} exAddress - The extended address.
 * @param {string} ripdm160Key - The ripemd160 key in hex format.
 * @returns {string|null} The generated Bitcoin address or null if an error occurs.
 */
exports.addressFromEx = function (exAddress, ripdm160Key) {
    try {
        var versionByte = exports.getVersionByte(exAddress);
        var addrBase = new Buffer.concat([versionByte, new Buffer.from(ripdm160Key, 'hex')]);
        var checksum = exports.sha256d(addrBase).slice(0, 4);
        var address = new Buffer.concat([addrBase, checksum]);
        return base58Encode(address);
    } catch (e) {
        return null;
    }
};

/**
 * Extracts the version byte from a base58 encoded address.
 * @param {string} addr - The base58 encoded address.
 * @returns {Buffer} The version byte.
 */
exports.getVersionByte = function (addr) {
    var versionByte = base58Decode(addr).slice(0, 1);
    return versionByte;
};
