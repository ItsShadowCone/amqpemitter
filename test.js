#!/usr/bin/node

'use strict';

const FUZZ_TESTS = 10;
const NUM_MESSAGES = 1000;

const assert = require('assert');
const crypto = require('crypto');
const events = new (require('./lib.js'))({requestTimeout: 60});

function color(string, color) {
    return '\x1b[' + color + 'm' + string + '\x1b[0m';
}

function red(string) {
    return color(string, '31');
}

function green(string) {
    return color(string, '32');
}

async function random(encoding) {
    const [wait, callback] = createCallback();
    crypto.randomBytes(16, callback);
    return (await wait).toString(encoding);
}

/* async */
function timeout(duration) {
    return new Promise(resolve => setTimeout(resolve, duration));
}

function createCallback() {
    let cb;
    const _promise = (resolve, reject) => {
        cb = (err, res) => {
            if (err)
                reject(err);
            else
                resolve(res);
        };
    };

    return [new Promise(_promise), cb];
}

let tests = [];

function test(name, test) {
    tests.push({name, test});
}

test('Connect successfully', async () => {
    await events.connect();
});

async function _assertRequestTransport(payload) {
    const key = 'test.one-' + await random('hex');

    await events.manyOne(key, NUM_MESSAGES, async (event, request, arg2) => {
        try {
            assert.deepEqual(event, key);
            assert.deepEqual(request, payload);
            assert.deepEqual(arg2, payload);
            return request;
        } catch (err) {
            return err;
        }
    });
    let waits = [];
    for (let i = 0; i < NUM_MESSAGES; i++) {
        waits.push(events.emitOne(key, payload, payload));
    }

    const responses = await Promise.all(waits);
    for (let response of responses) {
        assert.deepEqual(response, payload);
    }
}

async function _assertPublishTransport(payload) {
    const key = 'test.all-' + await random('hex');
    const RECEIVERS = 5;

    let waits = [];
    for (let i = 0; i < RECEIVERS; i++) {
        const [wait, callback] = createCallback();
        let counter = 0;
        await events.manyAll(key, NUM_MESSAGES, async (event, msg, arg2) => {
            try {
                assert.deepEqual(event, key);
                assert.deepEqual(msg, payload);
                assert.deepEqual(arg2, payload);
                if (++counter === NUM_MESSAGES)
                    callback(null, true);
            } catch (err) {
                callback(err);
            }
        });
        waits.push(wait);
    }

    for (let i = 0; i < NUM_MESSAGES; i++) {
        waits.push(events.emitAll(key, payload, payload));
    }
    await Promise.all(waits);
}

test('Basic request/response test', async () => {
    await _assertRequestTransport(await random());
});
test('Basic publish/subscribe test', async () => {
    await _assertPublishTransport(await random());
});

test('Fuzz ' + FUZZ_TESTS + ' string/object request/response and publish/subscribe tests', async () => {
    let all = [];
    for (let i = 0; i < FUZZ_TESTS; i++) {
        all.push(...[async () => {
            await _assertRequestTransport(await random());
        }, async () => {
            await _assertRequestTransport({[await random()]: {[await random()]: await random()}});
        }, async () => {
            await _assertPublishTransport(await random());
        }, async () => {
            await _assertPublishTransport({[await random()]: {[await random()]: await random()}});
        }]);
    }

    await Promise.all(all.map(func => func()));
});

test('Disconnect safely', async () => {
    await events.disconnect();
});

(async () => {
    console.log('Running ' + green(tests.length) + ' tests...');
    console.log();
    let passing = 0;
    const startAll = Date.now();
    for (let test of tests) {
        try {
            const start = Date.now();
            await test.test();
            const end = Date.now();
            console.log(green('  ✔️ ' + test.name + ' (' + (end - start) + 'ms)'));
            passing++;
        } catch (err) {
            console.error(red('  ❌ ' + test.name));
            console.error(err);
        }
        // Make sure to let the event loop handle everything before going to the next test
        await timeout(0);
    }
    const endAll = Date.now();
    const allPassed = passing === tests.length;
    console.log();
    console.log((allPassed ? green(passing + '/' + tests.length) : red(passing + '/' + tests.length)) + ' tests passed in ' + green((endAll - startAll) + 'ms'));
    console.log();

    if (!allPassed)
        process.exitCode = 1;
})();