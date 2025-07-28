require('dotenv').config();

const https = require('https');
const http = require('http');
const net = require('net');
const url = require('url');
const { Buffer } = require('buffer');
const fs = require('fs');
const path = require('path');
const rfs = require('rotating-file-stream');

const logDirectory = path.join(__dirname, 'logs');
fs.mkdirSync(logDirectory, { recursive: true });

const serverOptions = {
    key: fs.readFileSync('./certs/key.pem'),
    cert: fs.readFileSync('./certs/cert.pem')
};

const accessLogStream = rfs.createStream(
    (time) => {
        const now = time || new Date();
        return `proxy-${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(
            now.getDate()
        ).padStart(2, '0')}.log`;
    },
    {
        interval: '1d',
        path: logDirectory,
        compress: 'gzip',
        maxFiles: 7
    }
);

const HTTP_PORT = process.env.HTTP_PORT || 3456;
const HTTPS_PORT = process.env.HTTPS_PORT || 4433;
const AUTH_USER = process.env.PROXY_USER;
const AUTH_PASS = process.env.PROXY_PASSWORD;

// Basic Auth Validation
function isAuthenticated(authHeader) {
    if (!authHeader || !authHeader.startsWith('Basic ')) return false;
    const encoded = authHeader.slice(6); // remove "Basic "
    const decoded = Buffer.from(encoded, 'base64').toString('utf8');
    const [user, pass] = decoded.split(':');
    return user === AUTH_USER && pass === AUTH_PASS;
}

function logRequest(method, targetUrl) {
    const logLine = `[${new Date().toISOString()}] ${method} ${targetUrl}\n`;

    console.log(logLine.trim());

    // Write to log file
    accessLogStream.write(logLine);
}

function log(...args) {
    const line = `[${new Date().toISOString()}] ${args
        .map((a) => (typeof a === 'object' ? JSON.stringify(a) : String(a)))
        .join(' ')}\n`;
    console.log(line.trim());
    accessLogStream.write(line);
}

function requestHandler(clientReq, clientRes) {
    const proxyAuth = clientReq.headers['proxy-authorization'];

    if (!isAuthenticated(proxyAuth)) {
        clientRes.writeHead(407, { 'Proxy-Authenticate': 'Basic realm="Proxy"' });
        return clientRes.end('Proxy Authentication Required');
    }

    const parsedUrl = url.parse(clientReq.url);
    const options = {
        hostname: parsedUrl.hostname,
        port: parsedUrl.port || 80,
        path: parsedUrl.path,
        method: clientReq.method,
        headers: clientReq.headers
    };

    log(clientReq.method, `${parsedUrl.protocol}//${parsedUrl.hostname}${parsedUrl.path}`);

    const proxyReq = http.request(options, (res) => {
        clientRes.writeHead(res.statusCode, res.headers);
        res.pipe(clientRes);
    });

    proxyReq.on('error', (err) => {
        log('HTTP proxy error:', err.message);
        clientRes.writeHead(500);
        clientRes.end('Proxy Error');
    });

    clientReq.pipe(proxyReq);
}

function connectHandler(req, clientSocket, head) {
    const proxyAuth = req.headers['proxy-authorization'];
    if (!isAuthenticated(proxyAuth)) {
        clientSocket.write('HTTP/1.1 407 Proxy Authentication Required\r\n');
        clientSocket.write('Proxy-Authenticate: Basic realm="Proxy"\r\n\r\n');
        return clientSocket.destroy();
    }

    const [host, port] = req.url.split(':');
    log('CONNECT', req.url);

    const serverSocket = net.connect(port, host, () => {
        clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        serverSocket.write(head);
        serverSocket.pipe(clientSocket);
        clientSocket.pipe(serverSocket);
    });

    serverSocket.on('error', (err) => {
        log('HTTPS tunnel error:', err.message);
        clientSocket.write('HTTP/1.1 500 Tunnel Error\r\n\r\n');
        clientSocket.end();
    });
}

// HTTP Server
const httpServer = http.createServer(requestHandler);
httpServer.on('connect', connectHandler);
httpServer.listen(HTTP_PORT, () => log(`HTTP proxy server listening on port ${HTTP_PORT}`));

// HTTPS Server
const httpsServer = https.createServer(serverOptions, requestHandler);
httpsServer.on('connect', connectHandler);
httpsServer.listen(HTTPS_PORT, () => log(`HTTPS proxy server listening on port ${HTTPS_PORT}`));

// httpsServer.listen(4433, () => {
//     log('*********************************************');
//     log('*********************************************');
//     log(`Proxy server listening on port ${4433}`);
//     log('*********************************************');
//     log('*********************************************');
// });
