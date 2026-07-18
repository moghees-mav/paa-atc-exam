const http = require('http');
const fs = require('fs');
const path = require('path');

const PORTS = [8000, 8001, 8002, 8080];
let currentPortIndex = 0;

const mimeTypes = {
  '.html': 'text/html',
  '.css': 'text/css',
  '.js': 'application/javascript',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon'
};

function serveFile(res, filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const contentType = mimeTypes[ext] || 'application/octet-stream';
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end('404 Not Found');
      return;
    }
    res.writeHead(200, { 'Content-Type': contentType });
    res.end(data);
  });
}

function startServer(port) {
  const server = http.createServer((req, res) => {
    let filePath = '.' + req.url;
    if (filePath === './') filePath = './index.html';
    serveFile(res, filePath);
  });

  server.listen(port, () => {
    console.log(`\n✅ ATC Exam Simulator running at:`);
    console.log(`   http://localhost:${port}\n`);
    const startCmd = process.platform === 'win32' ? 'start' : (process.platform === 'darwin' ? 'open' : 'xdg-open');
    const { exec } = require('child_process');
    exec(`${startCmd} http://localhost:${port}`);
  });

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      currentPortIndex++;
      if (currentPortIndex < PORTS.length) {
        console.log(`Port ${port} is busy, trying ${PORTS[currentPortIndex]}...`);
        startServer(PORTS[currentPortIndex]);
      } else {
        console.error('No available ports. Please close some applications.');
        process.exit(1);
      }
    } else {
      console.error('Server error:', err);
      process.exit(1);
    }
  });
}

startServer(PORTS[currentPortIndex]);