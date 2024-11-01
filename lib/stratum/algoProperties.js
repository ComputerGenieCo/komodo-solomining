// Define algorithm properties for different cryptocurrencies
const algos = {
    komodo: {
        diff1: parseInt('0x0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f', 16), // The highest possible target for Komodo
        mindiff: parseInt('0x200f0f0f', 16) // The minimum difficulty for Komodo
    },
    zcash: {
        diff1: parseInt('0x0007ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff', 16), // The highest possible target for Zcash
        mindiff: parseInt('0x00ffffff', 16) // The minimum difficulty for Zcash
    }
};

// Export the algos object
module.exports = global.algos = algos;
