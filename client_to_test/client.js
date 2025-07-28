const https = require('https');
const { HttpsProxyAgent } = require('https-proxy-agent');
const fs = require('fs');

// ===== CONFIGURATION =====
const USE_HTTPS_PROXY = true; // Set to false if your proxy uses HTTP
const PROXY_HOST = '192.168.131.131';
const PROXY_PORT = USE_HTTPS_PROXY ? 4433 : 3456;
const PROXY_USER = 'xc1';
const PROXY_PASS = 'Func2test';
const TARGET_URL = 'https://jsonplaceholder.typicode.com/users/1';

// ===== OPTIONAL: Trust self-signed certs (for dev only) =====
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'; // ⚠️ Dev only

// ===== CREATE PROXY AGENT =====
const proxyProtocol = USE_HTTPS_PROXY ? 'https' : 'http';
const proxyUrl = `${proxyProtocol}://${PROXY_USER}:${PROXY_PASS}@${PROXY_HOST}:${PROXY_PORT}`;
console.log('------------- proxyProtocol is: ', proxyProtocol);
const agent = new HttpsProxyAgent(proxyUrl);

// ===== MAKE REQUEST THROUGH PROXY =====
https
    .get(TARGET_URL, { agent }, (res) => {
        console.log(`\n✅ Status: ${res.statusCode}`);

        let rawData = '';
        res.on('data', (chunk) => (rawData += chunk));
        res.on('end', () => {
            try {
                const json = JSON.parse(rawData);
                console.log('\n✅ Parsed JSON:\n', json);
            } catch (err) {
                console.error('\n❌ Failed to parse JSON:', err);
                console.log('\nRaw Response:\n', rawData);
            }
        });
    })
    .on('error', (err) => {
        console.error('\n❌ Request error:', err);
    });
