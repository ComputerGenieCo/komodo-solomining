const util = require('./util.js');

// Exporting the algos object which contains algorithm properties for different cryptocurrencies
var algos = module.exports = global.algos = {
    'komodo': {
        diff1: parseInt('0x0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f'), // The highest possible target for Komodo
        mindiff: parseInt('0x200f0f0f') // The minimum difficulty for Komodo
    },
    'zcash': {
        diff1: parseInt('0x0007ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff'), // The highest possible target for Zcash
        mindiff: parseInt('0x00ffffff') // The minimum difficulty for Zcash
    }
};
