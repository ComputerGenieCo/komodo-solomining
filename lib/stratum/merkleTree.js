const Promise = require('promise');
const merklebitcoin = Promise.denodeify(require('merkle-bitcoin'));
const util = require('./util.js');

/**
 * Calculates the Merkle root from an array of transaction hashes.
 * @param {Array} hashes - An array of transaction hashes.
 * @returns {string} - The Merkle root.
 */
const calcRoot = (hashes) => {
    // Convert the array of hashes into a Merkle tree and get the root.
    const result = merklebitcoin(hashes);
    return Object.values(result)[2].root;
};

/**
 * Generates the Merkle root for the given RPC data and raw transaction.
 * @param {Object} rpcData - The RPC data containing transaction information.
 * @param {string} generateTxRaw - The raw transaction data in hexadecimal format.
 * @returns {string} - The Merkle root or the single transaction hash if only one transaction exists.
 */
exports.getRoot = (rpcData, generateTxRaw) => {
    // Initialize the array of hashes with the reversed raw transaction hash.
    const hashes = [util.reverseBuffer(Buffer.from(generateTxRaw, 'hex')).toString('hex')];
    
    // Add the hash of each transaction in the RPC data to the array of hashes.
    rpcData.transactions.forEach((value) => {
        hashes.push(value.hash);
    });

    // If there is only one transaction, return its hash.
    if (hashes.length === 1) {
        return hashes[0];
    }

    // Calculate and return the Merkle root from the array of hashes.
    return calcRoot(hashes);
};
