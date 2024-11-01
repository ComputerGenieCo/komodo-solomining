const { writeFile, readFile } = require('fs').promises;
const path = require('path');
const logging = require('./logging.js');

/**
 * Handles API methods for block operations.
 * @param {string} method - The API method to execute.
 * @param {Object} obj - The object to process.
 */
module.exports = async function(method, obj) {
    // Parse configuration from environment variable
    let config;
    try {
        config = JSON.parse(process.env.config);
    } catch (err) {
        logging(' API ', 'error', 'Invalid JSON in config environment variable');
        return;
    }
    const csymbol = config.coin.symbol;

    // Define logging functions
    const emitLog = (text) => { logging(' API ', 'gray', text); };
    const emitErrorLog = (text) => { logging(' API ', 'error', text); };

    const filePath = path.join(__dirname, `../../logs/${csymbol}_blocks.json`);

    if (method === "block") {
        try {
            let data;
            try {
                data = await readFile(filePath, 'utf8');
            } catch (err) {
                if (err.code === "ENOENT") {
                    // If file does not exist, create a new one with an empty array
                    await writeFile(filePath, JSON.stringify([]));
                    data = '[]';
                } else {
                    throw err;
                }
            }

            // Parse the existing data and append the new object
            let object;
            try {
                object = JSON.parse(data);
            } catch (err) {
                emitErrorLog('Error parsing JSON data from blocks file');
                return;
            }
            object.push(obj);
            await writeFile(filePath, JSON.stringify(object));
            emitLog(`Block written successfully to ${filePath}`);
        } catch (err) {
            emitErrorLog(err);
        }
    }
}
