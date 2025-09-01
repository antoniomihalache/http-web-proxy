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

const HOP_BY_HOP = new Set([
    'connection',
    'proxy-connection',
    'keep-alive',
    'transfer-encoding',
    'upgrade',
    'te',
    'trailer'
]);

function scrubHeaders(headers) {
    const out = { ...headers };
    delete out['proxy-authorization'];
    Object.keys(out).forEach((k) => {
        if (HOP_BY_HOP.has(k.toLowerCase())) delete out[k];
    });
    out['connection'] = 'close';
    return out;
}

// Basic Auth Validation
function isAuthenticated(authHeader) {
    if (!authHeader || !authHeader.startsWith('Basic ')) return false;
    const encoded = authHeader.slice(6);
    const decoded = Buffer.from(encoded, 'base64').toString('utf8');
    const [user, pass] = decoded.split(':');
    return user === AUTH_USER && pass === AUTH_PASS;
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
    const isHttps = parsedUrl.protocol === 'https:';
    const mod = isHttps ? https : http;

    const options = {
        hostname: parsedUrl.hostname,
        port: parsedUrl.port || (isHttps ? 443 : 80),
        path: parsedUrl.path,
        method: clientReq.method,
        headers: scrubHeaders(clientReq.headers)
    };

    log(clientReq.method, `${parsedUrl.protocol}//${parsedUrl.hostname}${parsedUrl.path}`);

    const proxyReq = mod.request(options, (res) => {
        const respHeaders = { ...res.headers };
        Object.keys(respHeaders).forEach((k) => {
            if (HOP_BY_HOP.has(k.toLowerCase())) delete respHeaders[k];
        });
        respHeaders['connection'] = 'close';
        clientRes.writeHead(res.statusCode || 502, respHeaders);
        res.pipe(clientRes);
    });

    proxyReq.setTimeout(10_000, () => {
        proxyReq.destroy(new Error('Upstream request timeout'));
    });

    proxyReq.on('error', (err) => {
        log('HTTP proxy error:', err.message);
        const status = err.message === 'Upstream request timeout' ? 504 : 502;
        if (!clientRes.headersSent) clientRes.writeHead(status);
        clientRes.end(status === 504 ? 'Gateway Timeout' : 'Bad Gateway');
    });

    clientReq.on('aborted', () => proxyReq.destroy());
    clientReq.pipe(proxyReq);
}

function connectHandler(req, clientSocket, head) {
    const proxyAuth = req.headers['proxy-authorization'];
    if (!isAuthenticated(proxyAuth)) {
        clientSocket.write('HTTP/1.1 407 Proxy Authentication Required\r\n');
        clientSocket.write('Proxy-Authenticate: Basic realm="Proxy"\r\n\r\n');
        return clientSocket.destroy();
    }

    const lastColon = req.url.lastIndexOf(':');
    const host = lastColon > -1 ? req.url.slice(0, lastColon) : req.url;
    const portStr = lastColon > -1 ? req.url.slice(lastColon + 1) : '';
    const port = parseInt(portStr || '443', 10);

    log('CONNECT', `${host}:${port}`);

    const serverSocket = net.connect({ host, port }, () => {
        clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        if (head && head.length) serverSocket.write(head);
        serverSocket.pipe(clientSocket);
        clientSocket.pipe(serverSocket);
    });

    serverSocket.setTimeout(30_000, () => serverSocket.destroy());

    serverSocket.on('error', (err) => {
        log('HTTPS tunnel error:', err.message);
        try {
            clientSocket.write('HTTP/1.1 502 Bad Gateway\r\n\r\n');
        } catch {}
        clientSocket.end();
    });

    clientSocket.on('error', (err) => log('Client socket error:', err.message));
}

// HTTP Server
const httpServer = http.createServer(requestHandler);
httpServer.on('connect', connectHandler);
httpServer.listen(HTTP_PORT, () => log(`HTTP proxy server listening on port ${HTTP_PORT}`));

// HTTPS Server (optional, for HTTPS proxy clients)
const httpsServer = https.createServer(serverOptions, requestHandler);
httpsServer.on('connect', connectHandler);
httpsServer.listen(HTTPS_PORT, () => log(`HTTPS proxy server listening on port ${HTTPS_PORT}`));
