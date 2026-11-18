'use strict';

const http = require('node:http');
const WebSocket = require('ws');

const WAIT_MS = 10 * 60 * 1000;
const MAX_PACKET = 160 * 1024;

// This process sees routing metadata. Only endpoints hold the invitation secret.
function createRelay(server, path = '/pair') {
  const rooms = new Map();
  const wss = new WebSocket.Server({ noServer: true, maxPayload: MAX_PACKET, perMessageDeflate: false });
  const reject = (socket, status) => socket.end('HTTP/1.1 ' + status + '\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
  const remove = room => {
    if (rooms.get(room.id) !== room) return;
    rooms.delete(room.id);
    clearTimeout(room.expires);
    room.host?.terminate();
    room.viewer?.terminate();
  };

  server.on('upgrade', (request, socket, head) => {
    let url;
    try { url = new URL(request.url, 'http://localhost'); }
    catch { reject(socket, '400 Bad Request'); return; }
    const id = url.searchParams.get('room') || '';
    const role = url.searchParams.get('role');
    if (url.pathname !== path || !/^[\w-]{43}$/.test(id) || !['host', 'viewer'].includes(role)) {
      reject(socket, '404 Not Found'); return;
    }
    let room = rooms.get(id);
    if ((role === 'host' && (room || rooms.size >= 256)) || (role === 'viewer' && (!room || room.viewer))) {
      reject(socket, '409 Conflict'); return;
    }
    wss.handleUpgrade(request, socket, head, ws => {
      if (role === 'host') {
        room = { id, host: ws, viewer: null };
        rooms.set(id, room);
        room.expires = setTimeout(() => remove(room), WAIT_MS);
      } else {
        room.viewer = ws;
        clearTimeout(room.expires);
      }
      ws.alive = true;
      let bucketStart = Date.now();
      let bucketBytes = 0;
      ws.on('pong', () => { ws.alive = true; });
      ws.on('close', () => remove(room));
      ws.on('error', () => remove(room));
      ws.on('message', (data, binary) => {
        const other = role === 'host' ? room.viewer : room.host;
        const now = Date.now();
        if (now - bucketStart >= 10000) { bucketStart = now; bucketBytes = 0; }
        bucketBytes += data.length;
        if (!binary || !other || other.readyState !== WebSocket.OPEN || other.bufferedAmount > MAX_PACKET * 4 || bucketBytes > 2 * 1024 * 1024) {
          remove(room); return;
        }
        other.send(data, { binary: true });
      });
      ws.send('ready-v1');
    });
  });
  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (!ws.alive) { ws.terminate(); continue; }
      ws.alive = false;
      if (ws.readyState === WebSocket.OPEN) ws.ping();
    }
  }, 20000);
  heartbeat.unref();
  const close = () => {
    clearInterval(heartbeat);
    for (const room of rooms.values()) remove(room);
    wss.close();
  };
  server.once('close', close);
  return { close };
}

if (require.main === module) {
  const host = process.env.RELAY_BIND || '127.0.0.1';
  const port = Number(process.env.RELAY_PORT || 8844);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid RELAY_PORT');
  const server = http.createServer((_req, res) => { res.writeHead(404); res.end(); });
  server.maxConnections = 600;
  server.headersTimeout = 10000;
  createRelay(server);
  server.listen(port, host, () => console.log('Pairing relay listening on ' + host + ':' + port));
}

module.exports = { createRelay };
