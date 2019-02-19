const fs = require('fs');

module.exports = {
    url: {
        protocol: 'amqps',
        hostname: 'localhost',
        heartbeat: 2,
    },
    options: {
        cert: fs.readFileSync('./keys/certificate.pem'),
        key: fs.readFileSync('./keys/private_key.pem'),
        ca: [fs.readFileSync('./keys/ca_certificate.pem')],
        // Undocumented feature to enable use of the EXTERNAL mechanism i.e. use certificate CN as username
        credentials: {
            mechanism: 'EXTERNAL',
            response: () => Buffer.from(''),
        },
    },
    queue: 'events',
    requestTimeout: 10,
    reconnectTimeout: 0.1,
};