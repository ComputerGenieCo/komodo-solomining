// Import the 'net' module for networking capabilities
var net = require('net');

// Import the 'events' module to handle event-driven programming
var events = require('events');

// Gives us global access to everything we need for each hashing algorithm
require('./algoProperties.js');

// Import the 'pool' module which handles the mining pool logic
var pool = require('./pool.js');

// Export the 'daemon' module for interacting with the cryptocurrency daemon
const { interface: DaemonInterface } = require('./daemon.js');
exports.daemon = DaemonInterface;

// Export the 'varDiff' module for variable difficulty adjustments
exports.varDiff = require('./varDiff.js');

/**
 * Creates a new mining pool with the given options and authorization function.
 * @param {Object} poolOptions - Configuration options for the pool.
 * @param {Function} authorizeFn - Function to authorize miners.
 * @returns {Object} newPool - The newly created pool instance.
 */
exports.createPool = function (poolOptions, authorizeFn) {
    // Instantiate a new pool with the provided options and authorization function
    var newPool = new pool(poolOptions, authorizeFn);
    return newPool;
};
