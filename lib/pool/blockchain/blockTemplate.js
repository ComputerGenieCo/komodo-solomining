// Import necessary modules

// Standard Node.js Modules
const crypto = require('crypto');

// Third-Party Modules
const bignum = require('bignum');
const bitcoin = require('bitgo-utxo-lib');

// Local Modules
const util = require('../helpers/util.js');
const logging = require('../../middlewares/logging.js');
const algos = require('./algoProperties.js');

// Public members
let txHash; // Variable to store the current transaction hash

/**
 * Double hashes the input data.
 * @param {Buffer} data - The data to be double hashed.
 * @returns {Buffer} The double hash of the input data.
 */
const doubleHash = (data) => {
    const hash1 = crypto.createHash('sha256').update(data).digest();
    return crypto.createHash('sha256').update(hash1).digest();
};

/**
 * Calculates the total fees from an array of fee objects.
 * @param {Array<Object>} feeArray - The array of fee objects.
 * @param {number} feeArray[].fee - The fee value.
 * @returns {number} The total fee.
 */
const getFees = (feeArray) => {
    // Sum up all the fees in the array
    return feeArray.reduce((total, value) => total + Number(value.fee), 0);
};

/**
 * Returns the current transaction hash.
 * @returns {string} The current transaction hash.
 */
const getTxHash = () => txHash;

/**
 * Creates a generation transaction.
 * @param {number} blockHeight - The height of the block.
 * @param {number} blockReward - The reward for the block.
 * @param {string} poolAddress - The pool address.
 * @param {Object} coin - The coin object.
 * @param {string} pubkey - The public key.
 * @param {Array<Object>} vouts - The array of output objects.
 * @returns {string} The hex representation of the transaction.
 */
const createGeneration = (blockHeight, blockReward, poolAddress, coin, pubkey, vouts) => {
    const network = bitcoin.networks[coin.symbol]; // Get the network for the coin
    const txb = new bitcoin.TransactionBuilder(network); // Create a new transaction builder
    txb.setVersion(bitcoin.Transaction.ZCASH_SAPLING_VERSION); // Set the transaction version

    // Serialize the block height to hex and pad it to ensure even length
    let blockHeightSerial = blockHeight.toString(16).padStart(blockHeight.toString(16).length % 2 === 0 ? blockHeight.toString(16).length : blockHeight.toString(16).length + 1, '0');
    const height = Math.ceil((blockHeight << 1).toString(2).length / 8); // Calculate the number of bytes needed to represent the block height
    const lengthDiff = blockHeightSerial.length / 2 - height; // Calculate the difference in length

    // Pad the serialized block height with '00' to match the required length
    for (let i = 0; i < lengthDiff; i++) {
        blockHeightSerial += '00';
    }

    // Create the serialized block height buffer
    const serializedBlockHeight = Buffer.concat([
        Buffer.from(`0${height}`, 'hex'),
        util.reverseBuffer(Buffer.from(blockHeightSerial, 'hex')),
        Buffer.from('00', 'hex') // OP_0
    ]);

    // Add the coinbase input to the transaction builder
    txb.addInput(Buffer.from('0000000000000000000000000000000000000000000000000000000000000000', 'hex'),
        4294967295, // Index of the coinbase input
        4294967295, // Sequence number
        Buffer.concat([serializedBlockHeight, Buffer.from(util.toHexy(blockHeight.toString()), 'hex')])
    );

    // Loop through each output (vout) and add it to the transaction builder
    vouts.forEach((vout, i) => {
        const amt = Number(vout.valueZat); // Convert the value to a number
        if (amt === 0) return; // Skip adding the output if the amount is 0

        const scriptPubKey = vout.scriptPubKey;
        const isFirstOutput = i === 0; // Check if this is the first output
        const poolAddrHash = bitcoin.address.fromBase58Check(poolAddress).hash; // Get the hash of the pool address
        const scriptPubKeyHash = scriptPubKey.addresses ? bitcoin.address.fromBase58Check(scriptPubKey.addresses[0]).hash : null; // Get the hash of the scriptPubKey address

        let outputScript;
        switch (scriptPubKey.type) {
            case 'pubkey':
                outputScript = util.scriptCompileP2PK(isFirstOutput ? pubkey : scriptPubKey.asm.split(' ', 1)); // Compile the script for a public key
                break;
            case 'pubkeyhash':
                outputScript = util.scriptCompile(isFirstOutput ? poolAddrHash : scriptPubKeyHash); // Compile the script for a public key hash
                break;
            case 'nulldata':
                outputScript = util.scriptCompile(poolAddrHash); // Compile the script for null data
                break;
            default:
                outputScript = util.scriptCompile(isFirstOutput ? poolAddrHash : scriptPubKeyHash); // Default case for compiling the script
                break;
        }
        txb.addOutput(outputScript, amt); // Add the output to the transaction builder
    });

    const transaction = txb.build(); // Build the transaction
    const txHex = transaction.toHex(); // Get the hex representation of the transaction
    txHash = transaction.getHash().toString('hex'); // Assign the transaction hash
    return txHex; // Return the hex representation of the transaction
};

/**
 * The BlockTemplate class holds a single job and provides several methods to validate and submit it to the daemon coin.
 * @param {string} jobId - The job ID.
 * @param {object} rpcData - The RPC data.
 * @param {string} extraNoncePlaceholder - The extra nonce placeholder.
 * @param {number} reward - The reward.
 * @param {string} poolAddress - The pool address.
 * @param {string} coin - The coin name.
 * @param {string} pubkey - The public key.
 */
const BlockTemplate = module.exports = function BlockTemplate(jobId, rpcData, extraNoncePlaceholder, reward, poolAddress, coin, pubkey) {
    // Logging functions
    const doLog = (severity, text, forkId = "0") => logging("Blocks", severity, text, forkId);
    const emitGrayLog = (text) => doLog('gray', text);
    const emitWarningLog = (text) => doLog('warning', text);

    // Helper function to pack a 32-bit unsigned integer into a little-endian hex string
    const pack32 = (str) => util.packUInt32LE(str).toString('hex');

    // Environment variables
    const forkId = process.env.forkId;
    const config = JSON.parse(process.env.config);
    coin = config.coin.name;

    // Private members
    const submits = []; // Array to store submitted block headers

    // Public members
    this.rpcData = rpcData; // RPC data for the block
    this.jobId = jobId; // Job ID

    // Get target info
    this.target = bignum(rpcData.target, 16); // Target difficulty
    this.difficulty = parseFloat((algos.komodo.diff1 / this.target.toNumber()).toFixed(9)); // Use komodo.diff1 for internal calculations

    // Generate the fees and coinbase transaction
    const blockReward = this.rpcData.miner * 100000000; // Block reward in satoshis
    this.txCount = this.rpcData.transactions.length + 1; // Total transactions including the new coinbase transaction
    const fees = rpcData.transactions.map(value => value); // Extract fees from transactions

    this.rewardFees = getFees(fees); // Calculate total fees
    rpcData.rewardFees = this.rewardFees; // Store total fees in RPC data

    // Create the generation transaction if it doesn't exist
    if (typeof this.genTx === 'undefined') {
        this.genTx = createGeneration(rpcData.height, blockReward, poolAddress, coin, pubkey, this.rpcData.vouts).toString('hex');
        this.genTxHash = getTxHash(); // Store the transaction hash
    }

    // Create a custom coinbase transaction object
    const customCoinbaseTx = {
        data: this.genTx,
        hash: this.genTxHash
    };

    // Ensure coinbasetxn exists in rpcData and assign the custom coinbase transaction data and hash
    this.rpcData.coinbasetxn = this.rpcData.coinbasetxn || {};
    this.rpcData.coinbasetxn.data = customCoinbaseTx.data;
    this.rpcData.coinbasetxn.hash = customCoinbaseTx.hash;

    // Generate the merkle root
    this.generateMerkleRoot();

    // We can't do anything else until we have a submission

    // Serialize the block header
    this.serializeHeader = (nTime, nonce) => this.generateBlockHeader(nTime, nonce);

    // Serialize the block
    this.serializeBlock = (header, soln) => this.generateSerializedBlock(header, soln);

    /**
     * Submit the block header.
     * @param {Buffer} header - The block header.
     * @param {Buffer} soln - The solution.
     * @returns {boolean} True if the submission is registered, false otherwise.
     */
    this.registerSubmit = (header, soln) => {
        const submission = (header + soln).toLowerCase();
        if (!submits.includes(submission)) {
            submits.push(submission);
            return true;
        }
        return false;
    };

    /**
     * Get job parameters for mining.notify.
     * @returns {Array} The job parameters.
     */
    this.getJobParams = () => {
        if (!this.jobParams) {
            this.jobParams = [
                this.jobId,
                pack32(this.rpcData.version),
                this.prevHashReversed,
                this.merkleRootReversed,
                this.hashReserved,
                pack32(rpcData.curtime),
                util.reverseHex(this.rpcData.bits),
                true
            ];
        }
        return this.jobParams;
    };

    // Helper functions for network hash rate calculations
    const nethash = (givenDiff) => (((((givenDiff * Math.pow(2, 32)) / 60) / Math.pow(10, 9))).toFixed(2));
    const diffCalc = (hashrate) => util.getReadableHashRateString(hashrate);
    const vnethash = (givenDiff) => (nethash(givenDiff) * 8.192).toFixed(2);

    // Log current difficulty if configured to do so
    if (!process.env.forkId || process.env.forkId === '0') {
        if (config.printCurrentDiff === true) {
            // emitGrayLog(`The diff for block ${rpcData.height}: ${this.difficulty}`);
        }
    }
};

/**
 * Generate the merkle root and related properties.
 * The merkle root is a hash that represents all the transactions in a block.
 * It is used to efficiently and securely verify the integrity of the transactions.
 */
BlockTemplate.prototype.generateMerkleRoot = function () {
    // Reverse the previous block hash for use in the block header
    this.prevHashReversed = util.reverseHex(this.rpcData.previousblockhash);

    // Reverse the final sapling root hash for use in the block header
    this.hashReserved = util.reverseHex(this.rpcData.finalsaplingroothash);

    /**
     * Create the merkle root from the transactions and the coinbase transaction.
     * @param {Array} transactions - The list of transactions in the block.
     * @param {Object} cBase - The coinbase transaction.
     * @returns {string} The merkle root in reversed hex format.
     */
    const createMerkleRoot = (transactions, cBase) => {
        // If there are no transactions, return the reversed coinbase hash
        if (transactions.length === 0) {
            return util.reverseHex(cBase.hash.toString('hex'));
        }

        // Initialize the list of hashes with the coinbase transaction hash
        let hashes = [Buffer.from(cBase.hash, 'hex')];

        // Convert each transaction hash to a buffer and add to the list of hashes
        transactions.forEach(tx => {
            hashes.push(Buffer.from(util.reverseHex(tx.hash), 'hex'));
        });

        // Combine hashes pairwise until only one hash remains
        while (hashes.length > 1) {
            // If the number of hashes is odd, duplicate the last hash
            if (hashes.length % 2 !== 0) {
                hashes.push(hashes[hashes.length - 1]);
            }

            const newHashes = [];
            // Concatenate each pair of hashes, double hash the result, and add to the new list of hashes
            for (let i = 0; i < hashes.length; i += 2) {
                const concatenated = Buffer.concat([hashes[i], hashes[i + 1]]);
                const doubleHashed = doubleHash(concatenated);
                newHashes.push(doubleHashed);
            }
            hashes = newHashes;
        }

        // Return the final hash in reversed hex format
        return util.reverseHex(hashes[0].toString('hex'));
    };

    // Generate the merkle root from the transactions and the coinbase transaction
    const newMerkleRoot = createMerkleRoot(this.rpcData.transactions, this.rpcData.coinbasetxn);

    // Store the reversed merkle root for use in the block header
    this.merkleRootReversed = util.reverseHex(newMerkleRoot);
};

/**
 * Generate the block header.
 * @param {string} nTime - The current time.
 * @param {string} nonce - The nonce.
 * @returns {Buffer} The serialized header.
 */
BlockTemplate.prototype.generateBlockHeader = function (nTime, nonce) {
    const header = Buffer.alloc(140); // Allocate buffer for the header
    let position = 0;

    // Write various parts of the header to the buffer
    header.writeUInt32LE(this.rpcData.version, position += 0, 4, 'hex');
    header.write(this.prevHashReversed, position += 4, 32, 'hex');
    header.write(this.merkleRootReversed, position += 32, 32, 'hex');
    header.write(this.hashReserved, position += 32, 32, 'hex');
    header.write(nTime, position += 32, 4, 'hex');
    header.write(util.reverseHex(this.rpcData.bits), position += 4, 4, 'hex');
    header.write(nonce, position += 4, 32, 'hex');
    return header;
};

/**
 * Generate the serialized block.
 * @param {Buffer} header - The block header.
 * @param {Buffer} soln - The solution.
 * @returns {Buffer} The serialized block.
 */
BlockTemplate.prototype.generateSerializedBlock = function (header, soln) {
    let varInt;
    let txCount = this.txCount.toString(16);
    if (Math.abs(txCount.length % 2) === 1) {
        txCount = `0${txCount}`;
    }

    // Determine the variable integer format based on the transaction count
    if (this.txCount <= 0x7f) {
        varInt = Buffer.from(txCount, 'hex');
    } else if (this.txCount <= 0x7fff) {
        varInt = Buffer.concat([Buffer.from('FD', 'hex'), Buffer.from(txCount, 'hex')]);
    }
    let buf = Buffer.concat([
        header,
        soln,
        varInt,
        Buffer.from(this.genTx, 'hex')
    ]);

    // Append each transaction to the buffer
    if (this.txCount > 1) {
        this.rpcData.transactions.forEach((value) => {
            const tmpBuf = Buffer.concat([buf, Buffer.from(value.data, 'hex')]);
            buf = tmpBuf;
        });
    }
    return buf;
};
