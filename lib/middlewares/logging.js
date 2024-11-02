/**
 * Converts severity level to corresponding color code.
 * @param {string} severity - The severity level.
 * @returns {number} - The color code.
 */
const severityToColor = (severity) => {
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
};

/**
 * Generates a timestamp in the format HH:MM:SS MM/DD.
 * @returns {string} - The formatted timestamp.
 */
const timestamp = () => {
    const date = new Date();
    const pad = (num) => String(num).padStart(2, '0');
    return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())} ${pad(date.getMonth() + 1)}/${pad(date.getDate())}`;
};

/**
 * Logs a message with a specific severity and optional thread ID.
 * @param {string} worker - The worker identifier.
 * @param {string} severity - The severity level.
 * @param {string} text - The message text.
 * @param {string} [forkId] - The optional thread ID.
 */
const logMessage = (worker, severity, text, forkId) => {
    const colorCode = severityToColor(severity);
    const time = timestamp();
    const threadInfo = forkId && forkId !== '0' && forkId !== 'undefined' ? `\t[Thread ${forkId}]` : '';
    console.log(`\x1b[${colorCode}m%s\x1b[0m`, `[${time}] [${worker}]\t${text}${threadInfo}`);
};

module.exports = logMessage;
