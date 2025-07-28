const https = require('https');
const http = require('http');
const { HttpsProxyAgent } = require('https-proxy-agent');

const proxyUrl = 'http://xc1:Func2test@192.168.131.131:3456';
const agent = new HttpsProxyAgent(proxyUrl);

https
    .get('https://jsonplaceholder.typicode.com/users/1', { agent }, (res) => {
        console.log(`Status: ${res.statusCode}`);
        // res.on('data', (chunk) => process.stdout.write(chunk));

        let rawData = '';
        res.on('data', (chunk) => {
            rawData += chunk;
        });

        res.on('end', () => {
            try {
                const jsonData = JSON.parse(rawData);
                console.log('PARSED JSON: ', jsonData);
            } catch (err) {
                console.log('Failed to get response ', err);
            }
        });
    })
    .on('error', (err) => {
        console.error('Request error: ', err);
    });

// http.get('http://httpbin.org/get', { agent }, (res) => {
//     console.log('-------------------- Testing HTTP target');
//     console.log(`Status: ${res.statusCode}`);
//     res.on('data', (chunk) => process.stdout.write(chunk));
// });

// POST
// const data = JSON.stringify({
//     name: 'antonio',
//     email: 'antonio@example.com'
// });

// const options = {
//     hostname: 'jsonplaceholder.typicode.com',
//     port: 443,
//     path: '/posts',
//     method: 'POST',
//     headers: {
//         'Content-Type': 'application/json',
//         'Content-Length': Buffer.byteLength(data)
//     },
//     agent
// };

// const req = https.request(options, (res) => {
//     console.log(`Status: ${res.statusCode}`);

//     res.setEncoding('utf8');
//     res.on('data', (chunk) => {
//         process.stdout.write(chunk);
//     });

//     res.on('end', () => {
//         console.log('\n✅ POST complete');
//     });
// });

// req.on('error', (err) => {
//     console.error(`❌ Request error: ${err.message}`);
// });

// // Write the request body and end it
// req.write(data);
// req.end();
