'use strict';

const { EventEmitter } = require('node:events');
const crypto = require('node:crypto');
const { promisify } = require('node:util');
const https = require('node:https');
const os = require('node:os');
const { isIP } = require('node:net');
const WebSocket = require('ws');
const forge = require('node-forge');
const { Mailbox } = require('./managed-mailbox.cjs');
const { validToken, messages } = require('./account.cjs');
const { makePairCode, normalizePairCode, formatPairCode, pairSecret } = require('./pair-code.cjs');

const INVITE_PREFIX = 'RD1.';
const LIFETIME = 10 * 60 * 1000;
const MAX_PACKET = 160 * 1024;
const READY = 'ready-v1';
const options = { maxPayload: MAX_PACKET, perMessageDeflate: false };
const hash = data => crypto.createHash('sha256').update(data).digest();
const b64 = data => data.toString('base64url');
const generateKeyPair = promisify(crypto.generateKeyPair);

function peerName(value) {
  return (typeof value === 'string' ? value : '').replace(/[\p{Cc}\p{Cf}]/gu, '').trim().slice(0, 64) || '另一台电脑';
}

function relayURL(value) {
  let url;
  try { url = new URL(value); } catch { /* Report one localized validation error. */ }
  if (!url || url.protocol !== 'wss:' || url.username || url.password || url.search || url.hash || value.length > 512) {
    throw new Error('信令地址需采用 wss://，并且不包含用户名、密码、查询参数或片段。');
  }
  return url.toString();
}

function isDigest(value) {
  return typeof value === 'string' && /^[\w-]{43}$/.test(value) && b64(Buffer.from(value, 'base64url')) === value;
}

function invitation(value) {
  const fail = () => { throw new Error('配对邀请格式无效，请复制完整邀请。'); };
  if (typeof value !== 'string' || value.length > 4096 || !value.trim().startsWith(INVITE_PREFIX)) fail();
  let spec;
  try { spec = JSON.parse(Buffer.from(value.trim().slice(INVITE_PREFIX.length), 'base64url').toString()); } catch { fail(); }
  if (!spec || !isDigest(spec.key) || !Number.isSafeInteger(spec.exp)) fail();
  if (spec.exp < Date.now()) throw new Error('配对邀请已过期，请让共享端创建新邀请。');
  if (spec.managed !== undefined && spec.managed !== 1) fail();
  if (spec.relay && spec.managed) fail();
  if (spec.relay) {
    if (typeof spec.relay !== 'string') fail();
    spec.relay = relayURL(spec.relay);
  } else if (spec.managed && !('ips' in spec) && !('pin' in spec) && !('port' in spec)) {
    return spec;
  } else if (!isDigest(spec.pin) || !Number.isInteger(spec.port) || spec.port < 1 || spec.port > 65535 ||
      !Array.isArray(spec.ips) || spec.ips.length === 0 || spec.ips.length > 8 ||
      !spec.ips.every(ip => typeof ip === 'string' && isIP(ip) && !ip.includes('%'))) fail();
  return spec;
}

function addresses(override) {
  if (override) {
    if (typeof override !== 'string' || !isIP(override) || override.includes('%')) throw new Error('指定的本机地址须为 IPv4 或 IPv6 地址。');
    return [override];
  }
  const entries = Object.values(os.networkInterfaces()).flat().filter(iface =>
    iface && !iface.internal && !iface.scopeid && !/^fe[89ab]/i.test(iface.address));
  const ips = [...new Set(entries.sort((a, b) => isIP(a.address) - isIP(b.address)).map(iface => iface.address))];
  return ips.length ? ips.slice(0, 8) : ['127.0.0.1'];
}

async function certificate() {
  const keys = await generateKeyPair('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' }
  });
  const cert = forge.pki.createCertificate();
  cert.publicKey = forge.pki.publicKeyFromPem(keys.publicKey);
  cert.serialNumber = '01' + crypto.randomBytes(14).toString('hex');
  cert.validity.notBefore = new Date(Date.now() - 60000);
  cert.validity.notAfter = new Date(Date.now() + 24 * 3600000);
  const subject = [{ name: 'commonName', value: 'Local desktop pairing' }];
  cert.setSubject(subject);
  cert.setIssuer(subject);
  cert.sign(forge.pki.privateKeyFromPem(keys.privateKey), forge.md.sha256.create());
  const pem = forge.pki.certificateToPem(cert);
  return { key: keys.privateKey, cert: pem, pin: b64(hash(new crypto.X509Certificate(pem).raw)) };
}

function isSignal(x, filesOnly = false) {
  if (!x || typeof x !== 'object') return false;
  if (x.type === 'ice-restart') return Object.keys(x).length === 1;
  if (x.type === 'offer' || x.type === 'answer') {
    if (typeof x.sdp !== 'string' || x.sdp.length > 128 * 1024) return false;
    if (!filesOnly) return true;
    const media = x.sdp.split(/\r\n|\r|\n/).filter(line => line.startsWith('m='));
    return media.length === 1 && media[0].startsWith('m=application ');
  }
  if (x.type !== 'candidate') return false;
  return x.candidate === null || (typeof x.candidate === 'object' && x.candidate && typeof x.candidate.candidate === 'string' &&
    x.candidate.candidate.length <= 4096 && JSON.stringify(x.candidate).length <= 8192);
}

// Both directions use distinct keys. A fresh viewer salt binds one handshake;
// the host challenge requires live possession of the invite before any prompt.
function channelKeys(secret, salt) {
  const derive = role => Buffer.from(crypto.hkdfSync('sha256', secret, salt, 'rd1-signaling-' + role, 32));
  return { host: derive('host'), viewer: derive('viewer') };
}

function write(peer, message) {
  if (peer.ws.readyState !== WebSocket.OPEN || peer.ws.bufferedAmount > MAX_PACKET * 4) throw new Error('连接已中断。');
  const data = Buffer.from(JSON.stringify(message));
  if (data.length > MAX_PACKET - 48) throw new Error('连接消息过长。');
  const header = Buffer.allocUnsafe(32);
  peer.salt.copy(header, 0);
  header.writeUInt32BE(peer.sent++, 16);
  crypto.randomFillSync(header, 20, 12);
  const cipher = crypto.createCipheriv('aes-256-gcm', peer.keys[peer.role], header.subarray(20));
  cipher.setAAD(header);
  const ciphertext = Buffer.concat([cipher.update(data), cipher.final()]);
  peer.ws.send(Buffer.concat([header, cipher.getAuthTag(), ciphertext]));
}

function read(peer, secret, data) {
  if (!Buffer.isBuffer(data) || data.length < 50 || data.length > MAX_PACKET || data.readUInt32BE(16) !== peer.received) {
    throw new Error('Invalid signaling packet');
  }
  const salt = data.subarray(0, 16);
  if (!peer.keys) {
    peer.salt = Buffer.from(salt);
    peer.keys = channelKeys(secret, salt);
  }
  if (!peer.salt.equals(salt)) throw new Error('Invalid signaling session');
  const remote = peer.role === 'host' ? 'viewer' : 'host';
  const decipher = crypto.createDecipheriv('aes-256-gcm', peer.keys[remote], data.subarray(20, 32));
  decipher.setAAD(data.subarray(0, 32));
  decipher.setAuthTag(data.subarray(32, 48));
  const plain = Buffer.concat([decipher.update(data.subarray(48)), decipher.final()]);
  peer.received++;
  return JSON.parse(plain.toString('utf8'));
}

function rendezvous(spec, role) {
  const url = new URL(spec.relay);
  const room = crypto.createHmac('sha256', Buffer.from(spec.key, 'base64url')).update('rd1-rendezvous').digest('base64url');
  url.searchParams.set('room', room);
  url.searchParams.set('role', role);
  return url.toString();
}

function dial(s, url, pin, timeout = pin ? 5000 : 10000) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, {
      ...options, followRedirects: false, handshakeTimeout: timeout,
      minVersion: 'TLSv1.2', rejectUnauthorized: !pin
    });
    s.sockets.add(ws);
    // The direct certificate is ephemeral. Verify the invite's exact SHA-256
    // pin on the upgrade response, before a single application byte is sent.
    let verified = !pin;
    let settled = false;
    const fail = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(pin ? '未能验证或连接到共享端。' : '无法连接信令服务，或邀请已被使用。'));
      ws.terminate();
    };
    const ready = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(ws);
    };
    const timer = setTimeout(fail, timeout);
    ws.on('error', fail);
    ws.once('close', () => { s.sockets.delete(ws); fail(); });
    if (pin) {
      ws.once('upgrade', response => {
        const raw = response.socket.getPeerCertificate().raw;
        verified = !!raw && crypto.timingSafeEqual(hash(raw), Buffer.from(pin, 'base64url'));
        if (!verified) fail();
      });
      ws.once('open', () => verified ? ready() : fail());
    } else {
      ws.once('message', (message, binary) => !binary && message.toString() === READY ? ready() : fail());
    }
  });
}

function listen(server, port, host) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => { server.removeListener('error', reject); resolve(); });
  });
}

class PairingNetwork extends EventEmitter {
  state = null;

  constructor({ managedUrl, fetchImpl = globalThis.fetch, accountOnly = false, accountToken } = {}) {
    super();
    this.managedUrl = managedUrl;
    this.fetchImpl = fetchImpl;
    this.accountOnly = accountOnly;
    this.accountToken = accountToken;
    if (accountOnly && (!managedUrl || !validToken(accountToken))) throw new Error(messages.account_required);
  }

  async mailbox(s) {
    const mailbox = new Mailbox(this.managedUrl, s.role, s.secret, this.fetchImpl, this.accountToken);
    s.sockets.add(mailbox);
    try {
      await mailbox.register();
      this.live(s);
      return mailbox;
    } catch (error) {
      mailbox.terminate();
      s.sockets.delete(mailbox);
      throw error;
    }
  }

  begin(role, name, secret) {
    if (this.state) throw new Error('请先结束当前配对或连接。');
    const state = { role, name: peerName(name), secret, sockets: new Set(), rawSockets: new Set(), peer: null };
    this.state = state;
    return state;
  }

  live(s) {
    if (this.state !== s) throw new Error('连接已结束。');
  }

  async host({ name, address, relayUrl } = {}) {
    const code = this.accountOnly ? makePairCode() : null;
    const s = this.begin('host', name, code ? null : crypto.randomBytes(32));
    try {
      if (code) {
        s.secret = await pairSecret(code);
        this.live(s);
      }
      const spec = { key: b64(s.secret), exp: Date.now() + LIFETIME };
      s.inviteExpiresAt = spec.exp;
      if (this.accountOnly) {
        spec.account = 1;
        spec.managed = 1;
        const socket = await this.mailbox(s);
        this.live(s);
        this.attach(s, socket, true);
      } else if (relayUrl) {
        spec.relay = relayURL(relayUrl);
        const ws = await dial(s, rendezvous(spec, 'host'));
        this.live(s);
        this.attach(s, ws, true);
      } else {
        const direct = this.openDirect(s, address);
        if (this.managedUrl) {
          const [lan, wan] = await Promise.allSettled([direct, this.mailbox(s)]);
          this.live(s);
          if (lan.status === 'fulfilled') {
            Object.assign(spec, lan.value);
            s.directAvailable = true;
          }
          if (wan.status === 'fulfilled') {
            spec.managed = 1;
            this.attach(s, wan.value, true);
          } else if (lan.status === 'rejected') throw wan.reason;
          else s.internetIssue = wan.reason.message;
        } else Object.assign(spec, await direct);
      }
      s.expires = setTimeout(() => this.end(s, '邀请已过期。'), Math.max(1, spec.exp - Date.now()));
      const longInvite = INVITE_PREFIX + b64(Buffer.from(JSON.stringify(spec)));
      return { invite: code ? formatPairCode(code) : longInvite, ...(code && {legacyInvite: longInvite}),
        expiresAt: spec.exp, internetAvailable: !!(spec.relay || spec.managed), internetIssue: s.internetIssue };
    } catch (err) { this.end(s, '', false); throw err; }
  }

  async openDirect(s, address) {
    const direct = { ips: addresses(address) };
    const tls = await certificate();
    this.live(s);
    direct.pin = tls.pin;
    s.server = https.createServer({ key: tls.key, cert: tls.cert, minVersion: 'TLSv1.2', handshakeTimeout: 5000 }, (_req, res) => {
      res.writeHead(404, { Connection: 'close' }); res.end();
    });
    s.server.maxConnections = 20;
    s.server.headersTimeout = 8000;
    s.server.on('connection', socket => {
      s.rawSockets.add(socket);
      socket.once('close', () => s.rawSockets.delete(socket));
    });
    s.wss = new WebSocket.Server({ ...options, server: s.server, path: '/pair', verifyClient: () => !s.peer && s.sockets.size < 12 });
    s.wss.on('error', () => { if (s.server.listening) this.end(s, '本机配对服务已中断。'); });
    s.wss.on('connection', ws => { s.sockets.add(ws); this.attach(s, ws, false); });
    try { await listen(s.server, 0, '::'); }
    catch (error) {
      if (!['EAFNOSUPPORT', 'EADDRNOTAVAIL', 'EPROTONOSUPPORT'].includes(error.code)) throw error;
      await listen(s.server, 0, '0.0.0.0');
      direct.ips = direct.ips.filter(ip => isIP(ip) === 4);
      if (!direct.ips.length) throw new Error('当前系统仅支持 IPv4 监听，请选择 IPv4 地址。');
    }
    this.live(s);
    s.server.on('error', () => this.end(s, '本机配对服务已中断。'));
    direct.port = s.server.address().port;
    return direct;
  }

  async join({ invite, name, relayUrl, intent = 'screen' } = {}) {
    if (!['screen','files'].includes(intent)) throw new Error('配对请求格式无效。');
    const code = this.accountOnly ? normalizePairCode(invite) : null;
    const spec = code ? { account: 1, managed: 1 } : invitation(invite);
    if (this.accountOnly && (spec.account !== 1 || spec.managed !== 1 || spec.relay || spec.ips)) {
      throw new Error('请将两端升级至 0.4.0 或更高版本，并重新生成配对码。');
    }
    if (spec.relay && (!relayUrl || relayURL(relayUrl) !== spec.relay)) {
      throw new Error('这是一份跨网邀请。请先在两端配置相同且受信任的 wss:// 信令地址。');
    }
    const s = this.begin('viewer', name, code ? null : Buffer.from(spec.key, 'base64url'));
    try {
      if (code) {
        s.secret = await pairSecret(code);
        this.live(s);
      }
      let ws;
      if (this.accountOnly) ws = await this.mailbox(s);
      else if (spec.relay) ws = await dial(s, rendezvous(spec, 'viewer'));
      else {
        const managed = spec.managed === 1 && this.managedUrl && !relayUrl;
        if (spec.ips) {
          const timeout = managed ? 1000 : 5000;
          try {
            ws = await Promise.any(spec.ips.map(ip => dial(s, 'wss://' + (isIP(ip) === 6 ? '[' + ip + ']' : ip) + ':' + spec.port + '/pair', spec.pin, timeout)));
          } catch { /* A managed invite can also rendezvous over HTTPS. */ }
          for (const other of s.sockets) if (other !== ws) other.terminate();
        }
        this.live(s);
        if (!ws && managed) ws = await this.mailbox(s);
        if (!ws && spec.managed && relayUrl) throw new Error('这份邀请使用公共配对服务。如需连接，请先在连接设置中清空自建信令地址。');
        if (!ws) throw new Error('无法验证或连接共享端。此配对码仅限局域网或 VPN。跨网连接请更新两端并重新生成配对码。');
      }
      this.live(s);
      const p = this.attach(s, ws, !!spec.relay || ws instanceof Mailbox);
      s.peer = p;
      p.salt = crypto.randomBytes(16);
      p.keys = channelKeys(s.secret, p.salt);
      p.requestedFiles = intent === 'files';
      write(p, { op: 'hello', name: s.name, fileSessions:1, intent });
    } catch (err) { this.end(s, '', false); throw err; }
  }

  attach(s, ws, relayed) {
    const managedWan = ws instanceof Mailbox;
    const p = { ws, managedWan, role: s.role, phase: 'initial', sent: 0, received: 0 };
    // Losing the unused managed route must not disconnect the selected LAN peer.
    const required = () => s.peer === p || (!s.peer && relayed && !s.directAvailable);
    const fail = () => {
      if (required()) this.end(s, '配对或网络连接已中断。');
      else ws.terminate();
    };
    // A relay host is already connected to the rendezvous while waiting for an invite recipient.
    if (s.role === 'viewer' || !relayed) p.timeout = setTimeout(fail, managedWan ? 35000 : 10000);
    let alive = true;
    const heartbeat = managedWan ? undefined : setInterval(() => {
      if (!alive) return fail();
      alive = false;
      if (ws.readyState === WebSocket.OPEN) ws.ping();
    }, 15000);
    ws.on('pong', () => { alive = true; });
    ws.on('error', fail);
    ws.once('close', () => {
      clearInterval(heartbeat);
      clearTimeout(p.timeout);
      s.sockets.delete(ws);
      if (this.state === s && required()) this.end(s, ws.accountError || '对端已断开，连接已结束。');
    });
    ws.on('message', (data, binary) => {
      if (this.state !== s) return;
      try {
        if (!binary) throw new Error('Binary message required');
        this.receive(s, p, read(p, s.secret, data));
      } catch { fail(); }
    });
    if (managedWan) void ws.poll();
    return p;
  }

  receive(s, p, msg) {
    if (p.phase === 'active' && msg.op === 'signal' && isSignal(msg.payload,p.filesOnly)) {
      this.emit('event', { type: 'signal', payload: msg.payload });
      return;
    }
    if (s.role === 'host' && !s.peer && p.phase === 'initial' && msg.op === 'hello') {
      p.name = peerName(msg.name);
      p.fileSessions = msg.fileSessions === 1;
      p.requestedFiles = msg.intent === 'files';
      if (p.requestedFiles && !p.fileSessions) throw new Error('Invalid file session');
      p.challenge = b64(crypto.randomBytes(24));
      p.phase = 'proof';
      write(p, { op: 'challenge', value: p.challenge, ...(p.fileSessions && {fileSessions:1}) });
      return;
    }
    if (s.role === 'host' && !s.peer && p.phase === 'proof' && msg.op === 'proof' && msg.value === p.challenge) {
      // A queued packet can run before a delayed timer after sleep or a
      // stalled event loop. Enforce the displayed deadline at claim time.
      if (Date.now() >= s.inviteExpiresAt) return this.end(s, '邀请已过期。');
      s.peer = p;
      // The authenticated viewer has claimed the invitation. Local approval
      // now has its own deadline, even when pairing began close to expiry.
      clearTimeout(s.expires);
      s.server?.close();
      p.phase = 'pending';
      for (const other of s.sockets) if (other !== p.ws) other.terminate();
      clearTimeout(p.timeout);
      p.timeout = setTimeout(() => this.end(s, '等待共享端确认超时。'), 90000);
      this.emit('event', { type: 'request', name: p.name, fileSessions:p.fileSessions, requestedFiles:p.requestedFiles });
      return;
    }
    if (s.role === 'viewer' && p.phase === 'initial' && msg.op === 'challenge' && typeof msg.value === 'string' && msg.value.length === 32) {
      p.fileSessions = msg.fileSessions === 1;
      if (p.requestedFiles && !p.fileSessions) return this.end(s, '对方版本尚不支持仅传文件，请先更新 CC Connect。');
      p.phase = 'pending';
      clearTimeout(p.timeout);
      p.timeout = setTimeout(() => this.end(s, '等待共享端确认超时。'), 95000);
      write(p, { op: 'proof', value: msg.value });
      return;
    }
    if (s.role === 'viewer' && p.phase === 'pending') {
      if (msg.op === 'allow') {
        p.filesOnly = msg.mode === 'files';
        if ((p.requestedFiles && !p.filesOnly) || (p.filesOnly && !p.fileSessions)) {
          return this.end(s, '文件会话未获双方确认。');
        }
        p.name = peerName(msg.name); this.connected(s, p); return;
      }
      if (msg.op === 'deny') { this.end(s, '共享端已拒绝请求。'); return; }
    }
    throw new Error('Unexpected signaling message');
  }

  respond(allow, mode = 'screen') {
    const s = this.state;
    const p = s?.peer;
    if (s?.role !== 'host' || p?.phase !== 'pending' || typeof allow !== 'boolean') throw new Error('当前没有等待确认的请求。');
    if (allow) {
      if (!['screen','files'].includes(mode) || (mode === 'files' && !p.fileSessions) || (p.requestedFiles && mode !== 'files')) {
        throw new Error('文件会话未获双方确认。');
      }
      p.filesOnly = mode === 'files';
      write(p, { op: 'allow', name: s.name, ...(p.filesOnly && {mode:'files'}) });
      this.connected(s, p);
    }
    else {
      write(p, { op: 'deny' });
      this.end(s, '已拒绝连接请求。', true, p.ws);
    }
  }

  connected(s, p) {
    clearTimeout(s.expires);
    clearTimeout(p.timeout);
    p.phase = 'active';
    if (p.managedWan) p.ws.active = true;
    this.emit('event', { type: 'connected', role: s.role, name: p.name, managedWan: p.managedWan,
      ...(p.filesOnly && {mode:'files'}) });
  }

  async getManagedIceServers(renew = false) {
    const peer = this.state?.peer;
    if (peer?.phase !== 'active' || !peer.managedWan) return [];
    // One short-lived grant per approved endpoint, scoped to this session.
    if (renew && peer.ws.iceExpiresAt && peer.ws.iceExpiresAt - Date.now() <= 35000) peer.iceGrant = null;
    peer.iceGrant ??= peer.ws.ice();
    const servers = await peer.iceGrant;
    if (peer.ws.iceUnavailable) peer.iceGrant = null;
    return this.state?.peer === peer ? servers : [];
  }

  get managedIceExpiresAt() {
    return this.state?.peer?.ws?.iceExpiresAt || 0;
  }

  get managedIceUnavailable() {
    return this.state?.peer?.ws?.iceUnavailable === true;
  }

  signal(payload) {
    const p = this.state?.peer;
    if (p?.phase !== 'active' || !isSignal(payload,p.filesOnly)) throw new Error('连接尚未就绪或信令无效。');
    write(p, { op: 'signal', payload });
  }

  end(s, reason, notify = true, graceful = null) {
    if (this.state !== s) return;
    this.state = null;
    clearTimeout(s.expires);
    if (s.peer) clearTimeout(s.peer.timeout);
    for (const ws of s.sockets) {
      if (ws === graceful) ws.close();
      else ws.terminate();
    }
    s.wss?.close();
    s.server?.close();
    for (const socket of s.rawSockets) {
      // Allow a queued authenticated rejection to flush before closing its TLS socket.
      if (graceful) { const timer = setTimeout(() => socket.destroy(), 500); timer.unref(); }
      else socket.destroy();
    }
    if (notify) this.emit('event', { type: 'closed', reason });
  }

  stop() {
    if (this.state) this.end(this.state, '连接已结束。');
  }
}

module.exports = { PairingNetwork };
