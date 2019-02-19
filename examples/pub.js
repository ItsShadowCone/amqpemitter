#!/usr/bin/node

const config = require('./config.js');

const events = new (require('../lib.js'))({
    server: {
        url: config.url,
        options: config.options,
    },
});
events.on('error', console.log);
const readline = require('readline');

events.on('disconnected', () => {
    console.log('disconnected');
});

events.on('connected', () => {
    console.log('connected');
});

async function run() {
    console.log('Connecting');
    await events.connect();

    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout
    });

    rl.on('line', async (line) => {
        const response = await events.emitOne('log.pub', {line});
        console.log(response);
        await events.emitAll('log.send', {line});
    });
    rl.prompt()
}

run().catch((error) => {
    console.log(error);
});