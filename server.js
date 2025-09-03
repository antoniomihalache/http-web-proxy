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

// RFC7230 hop-by-hop headers (Node lowercases header names)
const HOP_BY_HOP = new Set([
    'connection',
    'proxy-connection', // non-standard but seen in the wild
    'keep-alive',
    'transfer-encoding',
    'upgrade',
    'te', // TE header (Node lowercase)
    'trailer', // Trailer header field name
    'proxy-authenticate',
    'proxy-authorization'
]);

function removeConnectionTokenHeaders(obj, connectionHeaderValue) {
    if (!connectionHeaderValue) return;
    // Connection: close, foo, Bar
    connectionHeaderValue
        .split(',')
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean)
        .forEach((token) => {
            delete obj[token];
        });
}

function scrubRequestHeaders(headers) {
    const out = { ...headers };

    // Always drop Proxy-Authorization before forwarding to origin
    delete out['proxy-authorization'];

    // Remove hop-by-hop headers
    Object.keys(out).forEach((k) => {
        if (HOP_BY_HOP.has(k.toLowerCase())) delete out[k];
    });

    // Also remove anything named by the Connection header tokens
    removeConnectionTokenHeaders(out, headers['connection']);

    // We’ll keep it simple and close upstream connections
    out['connection'] = 'close';

    return out;
}

function scrubResponseHeaders(headers) {
    const out = { ...headers };

    // Remove hop-by-hop headers on the way back
    Object.keys(out).forEach((k) => {
        if (HOP_BY_HOP.has(k.toLowerCase())) delete out[k];
    });

    // Also remove anything named by the Connection header tokens
    removeConnectionTokenHeaders(out, headers['connection']);

    // keep it simple for clients
    out['connection'] = 'close';

    return out;
}

// Basic Auth Validation
function isValidBasicAuthHeader(authHeader) {
    if (!authHeader || !authHeader.startsWith('Basic ')) return false;
    const encoded = authHeader.slice(6);
    const decoded = Buffer.from(encoded, 'base64').toString('utf8');
    const sep = decoded.indexOf(':');
    if (sep === -1) return false;
    const user = decoded.slice(0, sep);
    const pass = decoded.slice(sep + 1);
    return user === AUTH_USER && pass === AUTH_PASS;
}

// Optional auth policy:
// - If client sends Proxy-Authorization AND credentials are configured, validate it.
// - If header is present but invalid => 407
// - If header is absent => allow (no auth required)
function shouldRejectForAuth(authHeader) {
    const credsConfigured = AUTH_USER && AUTH_PASS;
    if (!credsConfigured) return false; // no creds set => never require
    if (!authHeader) return false; // optional => allow if not provided
    return !isValidBasicAuthHeader(authHeader); // provided but invalid => reject
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

    if (shouldRejectForAuth(proxyAuth)) {
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
        headers: scrubRequestHeaders(clientReq.headers)
    };

    log(clientReq.method, `${parsedUrl.protocol}//${parsedUrl.hostname}${parsedUrl.path}`);

    const proxyReq = mod.request(options, (res) => {
        const respHeaders = scrubResponseHeaders(res.headers);
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

    if (shouldRejectForAuth(proxyAuth)) {
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
