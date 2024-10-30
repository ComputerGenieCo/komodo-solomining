const events = require('events');

/*
Vardiff ported from stratum-mining share-limiter
https://github.com/ahmedbodi/stratum-mining/blob/master/mining/basic_share_limiter.py
*/

/**
 * RingBuffer is a circular buffer that holds a fixed number of elements.
 * When the buffer is full, new elements overwrite the oldest ones.
 * @param {number} maxSize - The maximum size of the buffer.
 */
function RingBuffer(maxSize) {
    let data = [];  // Array to store buffer elements
    let cursor = 0;  // Pointer to the current position in the buffer
    let isFull = false;  // Flag to indicate if the buffer is full

    /**
     * Appends a new element to the buffer.
     * @param {any} x - The element to append.
     */
    this.append = function(x) {
        if (isFull) {
            data[cursor] = x;  // Overwrite the oldest element
            cursor = (cursor + 1) % maxSize;  // Move cursor to the next position
        } else {
            data.push(x);  // Add new element to the buffer
            cursor++;
            if (data.length === maxSize) {
                cursor = 0;  // Reset cursor when buffer is full
                isFull = true;  // Set the buffer as full
            }
        }
    };

    /**
     * Calculates the average of the elements in the buffer.
     * @returns {number} The average of the elements.
     */
    this.avg = function() {
        const sum = data.reduce((a, b) => a + b, 0);  // Sum all elements
        return sum / (isFull ? maxSize : cursor);  // Calculate average
    };

    /**
     * Returns the current size of the buffer.
     * @returns {number} The size of the buffer.
     */
    this.size = function() {
        return isFull ? maxSize : cursor;  // Return the size based on the buffer state
    };

    // Clears the buffer.
    this.clear = function() {
        data = [];  // Reset data array
        cursor = 0;  // Reset cursor
        isFull = false;  // Reset full flag
    };
}

/**
 * varDiff dynamically adjusts the difficulty of mining shares based on the target time.
 * @param {number} port - The port number.
 * @param {object} varDiffOptions - The options for varDiff.
 */
const varDiff = module.exports = function varDiff(port, varDiffOptions) {
    events.EventEmitter.call(this);  // Call the parent constructor
    const _this = this;
    let networkDifficulty;  // Variable to store network difficulty
    
    if (!varDiffOptions) { return; }

    // Calculate the variance based on the target time and variance percentage
    const variance = varDiffOptions.targetTime * (varDiffOptions.variancePercent / 100);

    // Determine the buffer size and time thresholds
    const bufferSize = varDiffOptions.retargetTime / varDiffOptions.targetTime * 4;
    const tMin = varDiffOptions.targetTime - variance;
    const tMax = varDiffOptions.targetTime + variance;

    /**
     * Sets the network difficulty.
     * @param {number} diff - The network difficulty.
     */
    this.setNetworkDifficulty = function(diff) { networkDifficulty = diff; };

    /**
     * Manages the client by adjusting the difficulty based on the average time between share submissions.
     * @param {object} client - The client to manage.
     */
    this.manageClient = function(client) {
        const stratumPort = client.socket.localPort;

        // Ensure the client is connected to the correct port
        if (stratumPort != port) { 
            console.error("Handling a client which is not of this vardiff?");
            return;
        }

        const options = varDiffOptions;
        let lastTs;  // Timestamp of the last share submission
        let lastRtc;  // Timestamp of the last retarget
        let timeBuffer;  // Buffer to store time intervals between submissions

        client.on('submit', function() {
            const ts = Math.floor(Date.now() / 1000);  // Current timestamp in seconds

            // Initialize the time buffer and timestamps on the first submission
            if (!lastRtc) {
                initializeBuffer(ts);
                return;
            }

            // Calculate the time since the last submission and update the buffer
            const sinceLast = ts - lastTs;
            timeBuffer.append(sinceLast);  // Add time interval to buffer
            lastTs = ts;  // Update last submission timestamp

            // If the retarget time has not been reached, return early
            if ((ts - lastRtc) < options.retargetTime && timeBuffer.size() > 0) { return; }

            lastRtc = ts;  // Update last retarget timestamp
            adjustDifficulty(client, timeBuffer.avg());
        });

        /**
         * Initializes the time buffer and timestamps.
         * @param {number} ts - The current timestamp.
         */
        function initializeBuffer(ts) {
            lastRtc = ts - options.retargetTime / 2;  // Set initial retarget timestamp
            lastTs = ts;  // Set initial last submission timestamp
            timeBuffer = new RingBuffer(bufferSize);  // Initialize time buffer
        }

        /**
         * Adjusts the difficulty based on the average submission time.
         * @param {object} client - The client to adjust difficulty for.
         * @param {number} avg - The average submission time.
         */
        function adjustDifficulty(client, avg) {
            let ddiff;  // Variable for difficulty adjustment factor
            //console.log(`${client.workerName} avg is: ${avg}`);
            if (avg > tMax && client.difficulty > options.minDiff) {
                ddiff = 0.5;  // Decrease difficulty
                if (ddiff * client.difficulty < options.minDiff) {
                    ddiff = options.minDiff / client.difficulty;
                }
            } else if (avg < tMin) {
                ddiff = 2;  // Increase difficulty
                const diffMax = Math.min(networkDifficulty, options.maxDiff);
                if (ddiff * client.difficulty > diffMax) {
                    ddiff = diffMax / client.difficulty;
                }
            } else {
                return;  // No adjustment needed
            }

            const newDiff = client.difficulty * ddiff;  // Calculate the new difficulty
            timeBuffer.clear();  // Clear the buffer for new calculations
            _this.emit('newDifficulty', client, newDiff);  // Emit event with new difficulty
        }
    };
};

// Inherit from EventEmitter using Object.create
varDiff.prototype = Object.create(events.EventEmitter.prototype);
varDiff.prototype.constructor = varDiff;
