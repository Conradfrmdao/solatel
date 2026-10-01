// A tab left open across a deploy: does it pick up the new client by itself?
//
//   node client/stale.mjs
//
// Needs no game server. It serves the built client from web/dist and answers
// every handshake the way a newer server would - refused, protocol mismatch -
// then checks the page reloads exactly once for that server and then stays
// put with the reason showing, rather than looping.

import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import puppeteer from 'puppeteer-core';
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../web/dist');
const types = { '.html': 'text/html', '.js': 'text/javascript', '.wasm': 'application/wasm', '.png': 'image/png', '.json': 'application/json' };
let handshakes = 0;
const server = http.createServer((req, res) => {
  let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (p === '/') p = '/index.html';
  const file = path.join(root, p);
  if (!file.startsWith(root) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'content-type': types[path.extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-store' });
  fs.createReadStream(file).pipe(res);
});
server.on('upgrade', (req, socket) => {
  handshakes += 1;
  const accept = crypto.createHash('sha1').update(req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
  socket.once('data', () => {
    const body = Buffer.from(JSON.stringify({ t: 'rejected', reason: 'protocol version mismatch: server speaks 99, client sent 15. Reload the page to pick up the current client.' }));
    socket.end(Buffer.concat([Buffer.from([0x81, 126, body.length >> 8, body.length & 255]), body]));
  });
});
await new Promise((r) => server.listen(8090, r));
const browser = await puppeteer.launch({ executablePath: '/opt/pw-browsers/chromium', headless: 'new', args: ['--no-sandbox', '--use-gl=swiftshader', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage();
let loads = 0;
page.on('load', () => { loads += 1; });
page.on('pageerror', (e) => console.log('error:', e.message.slice(0, 160)));
await page.goto('http://localhost:8090/');
await new Promise((r) => setTimeout(r, 12000));
const stored = await page.evaluate(() => sessionStorage.getItem('solatel.reloadedFor'));
console.log({ loads, handshakes, stored });
await browser.close();
server.close();
const ok = loads === 2 && stored === 'protocol 99' && handshakes === 2;
console.log(ok ? 'OK   a stale tab reloaded once for the new server, then stayed put' : 'FAIL');
process.exit(ok ? 0 : 1);
