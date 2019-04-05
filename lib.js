'use strict';

const amqplib = require('amqplib');
const crypto = require('crypto');
const EventEmitter = require('eventemitter2').EventEmitter2;

/* async */
function timeout(duration) {
    return new Promise(resolve => {
        setTimeout(() => {
            resolve();
        }, duration);
    });
}

/* async */
function generateID() {
    return new Promise((resolve, reject) => {
        crypto.randomBytes(32, (err, buf) => {
            if (err)
                reject(err);
            else
                resolve(buf.toString('base64'));
        });
    });
}
const TYPES = {
    ONE: 'one',
    ALL: 'all',
};

// Returns a promise and a callback; the promise is resolved when the callback is called
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

class AMQPEmitter {
    constructor(config) {
        this.emitter = new EventEmitter({wildcard: true});

        this.connected = false;
        this.connection = undefined;
        this.channel = undefined;
        this.exchange = undefined;

        this.queues = {};

        this.emitQueue = {};

        this.requests = {};

        this._onRequest = this._onRequest.bind(this);

        config = config || {};

        config.server = config.server || {
            url: 'amqp://localhost',
            options: {},
        };

        config.exchange = config.exchange || 'eventemitter';
        config.requestTimeout = config.requestTimeout || 30;
        config.reconnectTimeout = config.reconnectTimeout || 5;

        this.config = config;
    }

    async _createQueue(type, event) {
        const id = type + '.' + event;
        let queue;
        switch (type) {
            case TYPES.ALL:
                const topic = event.replace(/\*\*/g, '#');
                queue = await this.channel.assertQueue('', {exclusive: 'true'});
                await this.channel.bindQueue(queue.queue, this.config.exchange, topic);
                break;

            case TYPES.ONE:
                queue = await this.channel.assertQueue(event);
                break;
        }
        await this.channel.consume(queue.queue, this._onRequest);
        this.queues[id] = {type, event, queue, recreate: async () => await this._createQueue(type, event)};
        return queue;
    }

    async _send(exchange, queue, msg, options) {
        const id = await generateID();

        const [wait, callback] = createCallback();

        this.emitQueue[id] = async () => {
            if (this.emitQueue[id]) {
                delete this.emitQueue[id];
                try {
                    callback(null, await this._send(exchange, queue, msg, options));
                } catch (err) {
                    callback(err);
                }
            }
        };

        if (this.connected) {
            this.channel.publish(exchange, queue, Buffer.from(JSON.stringify(msg)), options, (nack, ack) => {
                if (nack)
                    callback(new Error('Message nacked'));
                else {
                    if (this.emitQueue[id])
                        delete this.emitQueue[id];
                    callback(null, ack);
                }
            });
        }
        await wait;
    }

    async connect() {
        await this.disconnect('connect() called');
        try {
            this.connection = await amqplib.connect(this.config.server.url, this.config.server.options);

            this.connection.on('close', async (err) => {
                if (err) {
                    await this.emit('error', err);
                    await timeout(this.config.reconnectTimeout * 1000);
                    await this.connect();
                }
            });
            this.connection.on('error', async (err) => {
                await this.emit('error', err);
            });
            this.connected = true;
            this.channel = await this.connection.createConfirmChannel();
            this.exchange = await this.channel.assertExchange(this.config.exchange, 'topic');
            this.channel.consume('amq.rabbitmq.reply-to', this._onResponse.bind(this), {noAck: true});
            for (let id in this.emitQueue) {
                await this.emitQueue[id]();
            }

            for (let queue in this.queues) {
                await this.queues[queue].recreate();
            }
            await this.emit('connected');
        } catch (err) {
            await this.emit('error', err);
            await timeout(this.config.reconnectTimeout * 1000);
            await this.connect();
        }
    }

    async disconnect(reason) {
        if (this.connection) {
            try {
                await this.channel.close();
            } catch (e) {
            }
            try {
                await this.connection.close();
            } catch (e) {
            }
            this.connected = false;
            this.connection = undefined;
            this.channel = undefined;
            this.exchange = undefined;
            await this.emit('disconnected', reason);
        }
    }

    async _onRequest(msg) {
        try {
            if (!msg)
                return;

            const type = msg.fields.exchange === '' ? TYPES.ONE : TYPES.ALL;
            const event = msg.fields.routingKey;
            const id = type + '.' + event;

            switch (type) {
                case TYPES.ALL:
                    await this.emitter.emitAsync(id, event, JSON.parse(msg.content.toString()));
                    this.channel.ack(msg);
                    break;

                case TYPES.ONE:
                    if (msg.properties.replyTo && msg.properties.correlationId) {
                        const response = await this.emitter.emitAsync(id, event, JSON.parse(msg.content.toString()));

                        await this._send('', msg.properties.replyTo, (response[0] === undefined ? null : response[0]), {correlationId: msg.properties.correlationId});
                        this.channel.ack(msg);
                    } else {
                        await this.emit('error', new Error('Invalid ONE request received, ignoring...'));
                        this.channel.ack(msg);
                    }
                    break;
            }
        } catch (err) {
            await this.emit('error', err);
        }
    }

    async _onResponse(msg) {
        const correlationID = msg.properties.correlationId;
        if (correlationID && this.requests[correlationID])
            this.requests[correlationID].callback(null, JSON.parse(msg.content.toString()));
    }

    // EventEmitter part

    async on(event, listener) {
        if (!Array.isArray(event))
            event = event.split('.');

        if (event.length === 1)
            return this.emitter.on(event, listener);
        else
            return await this.emit('error', new Error('Use of emitter.on() is deprecated for distributed use, use either onOne() or onAll()'));
    }

    async onOne(event, listener) {
        return await this._on(TYPES.ONE, event, listener);
    }

    async onAll(event, listener) {
        return await this._on(TYPES.ALL, event, listener);
    }

    async _on(type, event, listener) {
        if (Array.isArray(event))
            event = event.join('.');

        const id = type + '.' + event;

        if (!this.connected)
            return await this.emit('error', new Error('on ' + event + ', but not connected, ignoring...'));

        if (this.emitter.listeners(id).length === 0) {
            await this._createQueue(type, event);
        }

        return this.emitter.on(id, listener);
    }

    async once(event, listener) {
        if (!Array.isArray(event))
            event = event.split('.');

        if (event.length === 1)
            return this.emitter.once(event, listener);
        else
            return await this.emit('error', new Error('Use of emitter.once() is deprecated for distributed use, use either onceOne() or onceAll()'));
    }

    async onceOne(event, listener) {
        return await this._once(TYPES.ONE, event, listener);
    }

    async onceAll(event, listener) {
        return await this._once(TYPES.ALL, event, listener);
    }

    async _once(type, event, listener) {
        return await this._many(type, event, 1, listener);
    }

    async many(event, number, listener) {
        if (!Array.isArray(event))
            event = event.split('.');

        if (event.length === 1)
            return this.emitter.many(event, number, listener);
        else
            return this.emit('error', new Error('Use of emitter.many() is deprecated for distributed use, use either manyOne() or manyAll()'));
    }

    async manyOne(event, number, listener) {
        return await this._many(TYPES.ONE, event, number, listener);
    }

    async manyAll(event, number, listener) {
        return await this._many(TYPES.ALL, event, number, listener);
    }

    async _many(type, event, number, listener) {
        const _listener = async (event, body) => {
            const ret = await listener(event, body);

            if (--number === 0)
                await this._off(type, event, _listener);

            return ret;
        };
        return await this._on(type, event, _listener);
    }

    async off(event, listener) {
        if (!Array.isArray(event))
            event = event.split('.');

        if (event.length === 1)
            return this.emitter.off(event, listener);
        else
            return this.emit('error', new Error('Use of emitter.off() is deprecated for distributed use, use either offOne() or offAll()'));
    }

    async offOne(event, listener) {
        return await this._off(TYPES.ONE, event, listener);
    }

    async offMany(event, listener) {
        return await this._off(TYPES.ALL, event, listener);
    }

    async _off(type, event, listener) {
        if (Array.isArray(event))
            event = event.join('.');

        const id = type + '.' + event;

        if (!this.connected)
            return await this.emit('error', new Error('off ' + event + ', but not connected, ignoring...'));

        if (this.emitter.listeners(id).length === 1) {
            if (this.queues[id]) {
                await this.channel.deleteQueue(this.queues[id].queue.queue);
                delete this.queues[id];
            }
        }

        return this.emitter.off(id, listener);
    }

    async emit(event, body) {
        if (!Array.isArray(event))
            event = event.split('.');

        if (event.length === 1)
            return this.emitter.emit(event, body);
        else
            return await this.emit('error', new Error('Use of emitter.emit() is deprecated for distributed use, use either emitOne() or emitAll()'));
    }

    /* async */
    emitOne(event, body) {
        return new Promise(async (resolve, reject) => {
            if (Array.isArray(event))
                event = event.join('.');

            const correlationID = await generateID();

            await this._send('', event, body, {replyTo: 'amq.rabbitmq.reply-to', correlationId: correlationID});

            const _cleanup = () => {
                delete this.requests[correlationID];
            };

            const [wait, callback] = createCallback();

            const timeout = setTimeout(() => {
                callback(new Error('emitOne request timeout reached without receiving a response, dropping...'));
            }, this.config.requestTimeout * 1000);

            this.requests[correlationID] = {id: correlationID, callback, timeout};

            try {
                resolve(await wait);
                clearTimeout(timeout);
            } catch (err) {
                reject(err);
            } finally {
                _cleanup();
            }
        });
    }

    async emitAll(event, body) {
        if (Array.isArray(event))
            event = event.join('.');

        await this._send(this.config.exchange, event, body);
    }
}

module.exports = AMQPEmitter;
