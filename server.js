// Static server + same-origin proxy to the backend. No dependencies. Run: node server.js
// /api/v1/* is forwarded to BACKEND_URL, so the browser never talks to the backend directly.
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const PORT = process.env.PORT || 3000;
const BACKEND_URL = process.env.BACKEND_URL || 'http://localhost:8000';

function proxy(req, res) {
  let target;
  try { target = new URL(req.url, BACKEND_URL); } catch (e) { res.writeHead(400); return res.end('Bad URL'); }
  const transport = target.protocol === 'https:' ? https : http;

const up = transport.request(target, {
  method: req.method,
  headers: {
    ...req.headers,
    host: target.host
  }
}, (upRes) => {
  res.writeHead(upRes.statusCode, upRes.headers);
    upRes.pipe(res);
  });
  up.on('error', () => {
    if (!res.headersSent) res.writeHead(502, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Backend unreachable at ' + BACKEND_URL }));
  });
  req.pipe(up);
}
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml' };
http.createServer((req, res) => {
  if (req.url.startsWith('/api/')) return proxy(req, res);
  const url = req.url.split('?')[0];
  const file = path.join(__dirname, url === '/' ? 'index.html' : path.normalize(url).replace(/^(\.\.[\/\\])+/, ''));
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'text/plain' });
    res.end(data);
  });
}).listen(PORT, () => console.log(`Smart Mess running at http://localhost:${PORT} (API -> ${BACKEND_URL})`));
