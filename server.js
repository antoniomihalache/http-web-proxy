require('dotenv').config();

const http = require('http');
const net = require('net');
const url = require('url');
const { Buffer } = require('buffer');

const PROXY_PORT = process.env.HTTP_PORT || 3456;
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
    console.log(`[${new Date().toISOString()}] ${method} ${targetUrl}`);
}

// Handles HTTP requests through the proxy
const httpServer = http.createServer((clientReq, clientRes) => {
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

    logRequest(clientReq.method, `${parsedUrl.protocol}//${parsedUrl.hostname}${parsedUrl.path}`);

    const proxyReq = http.request(options, (res) => {
        clientRes.writeHead(res.statusCode, res.headers);
        res.pipe(clientRes, { end: true });
    });

    proxyReq.on('error', (err) => {
        console.error('HTTP proxy error:', err.message);
        clientRes.writeHead(500);
        clientRes.end('Proxy Error');
    });

    clientReq.pipe(proxyReq, { end: true });
});

// Handles HTTPS requests through the proxy (CONNECT method)
httpServer.on('connect', (req, clientSocket, head) => {
    const proxyAuth = req.headers['proxy-authorization'];
    console.log(`Received request with method: ${req.method} on url: ${req.url}`);

    if (!isAuthenticated(proxyAuth)) {
        clientSocket.write('HTTP/1.1 407 Proxy Authentication Required\r\n');
        clientSocket.write('Proxy-Authenticate: Basic realm="Proxy"\r\n');
        clientSocket.write('\r\n');
        clientSocket.destroy();
        return;
    }

    const [host, port] = req.url.split(':');

    logRequest('CONNECT', req.url);
    const targetSocket = net.connect(port, host, () => {
        clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        targetSocket.write(head);
        targetSocket.pipe(clientSocket);
        clientSocket.pipe(targetSocket);
    });

    targetSocket.on('error', (err) => {
        console.error('HTTPS tunnel error:', err.message);
        clientSocket.write('HTTP/1.1 500 Tunnel Error\r\n\r\n');
        clientSocket.end();
    });
});

httpServer.listen(PROXY_PORT, () => {
    console.log(`Proxy server listening on port ${PROXY_PORT}`);
});
