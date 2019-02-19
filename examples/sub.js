#!/usr/bin/node

const config = require('./config.js');

const events = new (require('../lib.js'))({
  server: {
    url: config.url,
    options: config.options,
  }
});

events.on('error', (err) => {
  console.log(err);
});

events.on('disconnected', () => {
  console.log('disconnected');
});

events.on('connected', () => {
  console.log('connected');
});

async function run() {
  console.log('Connecting');
  await events.connect();

  events.onOne(['log', 'pub'], (event, {line}) => {
    console.log('One', line);
    return 'ACK ' + line;
  });

  events.onAll(['log', 'send'], (event, {line}) => {
    console.log('All', line);
  });
  console.log('Waiting for messages');
}

run().catch((error) => {
  console.log(error);
});