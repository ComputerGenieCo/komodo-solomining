const util = require('./util.js');
const bitcoin = require('bitgo-utxo-lib');

// public members
let txHash;

/**
 * Returns the current transaction hash.
 * @returns {string} The current transaction hash.
 */
exports.txHash = () => txHash;

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
exports.createGeneration = (blockHeight, blockReward, poolAddress, coin, pubkey, vouts) => { // these must match genTx in blockTemplate.js
    // We're using the tx builder, so we define the params for it:
    const network = bitcoin.networks[coin.symbol];
    const txb = new bitcoin.TransactionBuilder(network);
    txb.setVersion(bitcoin.Transaction.ZCASH_SAPLING_VERSION);

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

    /**
     * Loop through each output (vout) and add it to the transaction builder.
     * @param {number} i - The index of the current output.
     * @param {Object} vouts[i] - The current output object.
     * @param {number} vouts[i].valueZat - The value of the output in Zatoshi.
     * @param {Object} vouts[i].scriptPubKey - The scriptPubKey object of the output.
     * @param {string} vouts[i].scriptPubKey.type - The type of the scriptPubKey.
     * @param {Array<string>} [vouts[i].scriptPubKey.addresses] - The addresses associated with the scriptPubKey.
     */
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
                /**
                 * This case is for KMD transaction fee burning.
                 * The output script is compiled using the pool address hash.
                 */
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
 * Calculates the total fees from an array of fee objects.
 * @param {Array<Object>} feeArray - The array of fee objects.
 * @param {number} feeArray[].fee - The fee value.
 * @returns {number} The total fee.
 */
module.exports.getFees = (feeArray) => {
    // Calculate the total fee by summing up each fee in the array
    return feeArray.reduce((total, value) => total + Number(value.fee), 0);
};
