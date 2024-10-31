const { writeFile, readFile } = require('fs');
var logging = require('./logging.js');

/**
 * Handles API methods for block operations.
 * @param {string} method - The API method to execute.
 * @param {Object} obj - The object to process.
 */
module.exports = function(method, obj) {
    // Parse configuration from environment variable
    var config = JSON.parse(process.env.config);
    var csymbol = config.coin.symbol;

    // Define logging functions
    var emitLog = (text) => { logging(' API ', 'gray', text); };
    var emitErrorLog = (text) => { logging(' API ', 'error', text); };

    /**
     * Callback function for writeFile to handle errors.
     * @param {Error} err - The error object if an error occurred.
     */
    const doneWrite = (err) => {
        if (err) {
            emitErrorLog(err);
        }/* else {
            emitLog(`Block written successfully to logs/${csymbol}_blocks.json`);
        }*/;
    };

    if (method === "block") {
        // Read the existing blocks file
        readFile(`./logs/${csymbol}_blocks.json`, 'utf8', (err, data) => {
            if (err) {
                if (err.code === "ENOENT") {
                    // If file does not exist, create a new one with an empty array
                    let arr = [];
                    writeFile(`./logs/${csymbol}_blocks.json`, JSON.stringify(arr), doneWrite);
                } else {
                    emitErrorLog(err);
                }
                return;
            }

            // Parse the existing data and append the new object
            var object = JSON.parse(data);
            object.push(obj);
            writeFile(`./logs/${csymbol}_blocks.json`, JSON.stringify(object), doneWrite);
        });
    }
}
