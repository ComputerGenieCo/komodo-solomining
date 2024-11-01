const net = require("net");

const defaultPort = 17117;
const defaultHost = "127.0.0.1";

const args = process.argv.slice(2);
const params = [];
const options = {};

args.forEach(arg => {
    if (arg.startsWith("-") && arg.includes("=")) {
        const [key, value] = arg.substring(1).split("=");
        options[key] = value;
    } else {
        params.push(arg);
    }
});

const command = params.shift();

const client = net.connect(options.port || defaultPort, options.host || defaultHost, () => {
    client.write(`${JSON.stringify({ command, params, options })}\n`);
});

client.on("error", (error) => {
    if (error.code === "ECONNREFUSED") {
        console.error(`Could not connect to any pool at ${defaultHost}:${defaultPort}`);
    } else {
        console.error(`Socket error: ${JSON.stringify(error)}`);
    }
});

client.on("data", (data) => {
    console.log(data.toString());
});

client.on("close", () => {
    console.log("Connection closed");
});
