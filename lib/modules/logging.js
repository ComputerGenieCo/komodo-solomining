/**
 * Converts severity level to corresponding color code.
 * @param {string} severity - The severity level.
 * @param {string} text - The text to colorize.
 * @returns {number} - The color code.
 */
function severityToColor(severity, text) {
    switch (severity) {
        case 'special':
            return 36; // FgCyan
        case 'debug':
            return 32; // FgGreen
        case 'warning':
            return 33; // FgYellow
        case 'error':
            return 31; // FgRed
        case 'gray':
            return 90; // FgGray
        default:
            console.log(`Unknown severity: ${severity}`);
            return 37; // FgWhite
    }
}

/**
 * Generates a timestamp in the format HH:MM:SS MM/DD.
 * @returns {string} - The formatted timestamp.
 */
function timestamp() {
    var date = new Date();
    return ("0" + date.getHours()).slice(-2) + ":" +
           ("0" + date.getMinutes()).slice(-2) + ":" +
           ("0" + date.getSeconds()).slice(-2) + " " +
           ("0" + (date.getMonth() + 1)).slice(-2) + "/" +
           ("0" + date.getDate()).slice(-2);
}

/**
 * Logs a message with a specific severity and optional thread ID.
 * @param {string} worker - The worker identifier.
 * @param {string} severity - The severity level.
 * @param {string} text - The message text.
 * @param {string} [forkId] - The optional thread ID.
 */
module.exports = function (worker, severity, text, forkId) {
    const colorCode = severityToColor(severity);
    const time = timestamp();
    if (!forkId || forkId === '0' || forkId === 'undefined') {
        console.log(`\x1b[${colorCode}m%s\x1b[0m`, `[${time}] [${worker}]\t${text}`);
    } else {
        console.log(`\x1b[${colorCode}m%s\x1b[0m`, `[${time}] [${worker}]\t${text}\t[Thread ${forkId}]`);
    }
}
