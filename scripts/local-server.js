// local-server.js — Zero-dependency static file server for local testing
// Run from the app ROOT folder: node scripts/local-server.js
// Opens at: http://localhost:3000
// No npm install required — uses Node.js built-in http and fs modules only.

const http = require('http');
const fs   = require('fs');
const path = require('path');

const PORT    = 3000;
const ROOT    = path.dirname(__dirname); // scripts/ parent = app root

// MIME types for all file types used in this project
const MIME = {
  '.html' : 'text/html; charset=utf-8',
  '.js'   : 'application/javascript; charset=utf-8',
  '.css'  : 'text/css; charset=utf-8',
  '.json' : 'application/json; charset=utf-8',
  '.xlsx' : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.png'  : 'image/png',
  '.jpg'  : 'image/jpeg',
  '.jpeg' : 'image/jpeg',
  '.svg'  : 'image/svg+xml',
  '.ico'  : 'image/x-icon',
  '.woff' : 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf'  : 'font/ttf',
  '.txt'  : 'text/plain; charset=utf-8',
  '.md'   : 'text/plain; charset=utf-8',
};

const server = http.createServer((req, res) => {
  // Strip query strings and decode URI
  let urlPath = decodeURIComponent(req.url.split('?')[0]);

  // Default to index.html at root
  if (urlPath === '/') urlPath = '/index.html';

  const filePath = path.join(ROOT, urlPath);
  const resolvedPath = path.resolve(filePath);
  const resolvedRoot = path.resolve(ROOT);

  // Containment check — reject any request whose resolved path escapes ROOT
  // (e.g. via ../ sequences). Must run before any fs call. path.sep is
  // appended to resolvedRoot so a sibling folder sharing a name prefix
  // (e.g. ROOT-evil) can't pass a naive startsWith() check.
  if (resolvedPath !== resolvedRoot && !resolvedPath.startsWith(resolvedRoot + path.sep)) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Forbidden');
    return;
  }

  const ext      = path.extname(filePath).toLowerCase();
  const mimeType = MIME[ext] || 'application/octet-stream';

  fs.readFile(filePath, (err, data) => {
    if (err) {
      if (err.code === 'ENOENT') {
        // File not found — fall back to index.html (SPA pattern)
        fs.readFile(path.join(ROOT, 'index.html'), (err2, html) => {
          if (err2) {
            res.writeHead(500);
            res.end('Server error: could not read index.html');
            return;
          }
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(html);
        });
      } else {
        res.writeHead(500);
        res.end('Server error: ' + err.message);
      }
      return;
    }

    res.writeHead(200, { 'Content-Type': mimeType });
    res.end(data);
  });
});

server.listen(PORT, () => {
  console.log('');
  console.log('  ✓ Product Growth Toolkit — local server running');
  console.log('');
  console.log('  → Open in browser:  http://localhost:' + PORT);
  console.log('');
  console.log('  Stop server:        Ctrl + C');
  console.log('');
});
