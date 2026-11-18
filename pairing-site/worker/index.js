// Only invitation-key holders can complete the endpoint-to-endpoint challenge.
// This service routes their opaque signaling packets and never receives the key.
const WAIT_MS = 10 * 60_000;
const SESSION_MS = 12 * 60 * 60_000;
const DRAIN_MS = 90_000;
const MAX_PACKET = 160 * 1024;
const MAX_DIRECTION_BYTES = 2 * 1024 * 1024;
const MAX_SEQ = 512;
const TOKEN = /^[A-Za-z0-9_-]{43}$/;
const HEX_DIGEST = /^[0-9a-f]{64}$/;
const PATH = /^\/v1\/rooms\/([A-Za-z0-9_-]{43})\/(host|viewer)(?:\/(?:messages\/([1-9]\d{0,2})|(ice)))?$/;
const headers = { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' };

function reply(status, body = null) {
  return new Response(body, { status, headers: body ? { ...headers, 'content-type': 'application/octet-stream' } : headers });
}

async function fingerprint(value) {
  const bytes = typeof value === 'string' ? new TextEncoder().encode(value) : value;
  const hash = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(hash), n => n.toString(16).padStart(2, '0')).join('');
}

async function register(db, request, id, role, token, now) {
  const proof = request.headers.get('x-viewer-proof') || '';
  if (role === 'host') {
    if (!HEX_DIGEST.test(proof)) return reply(400);
    // Retain only a daily fingerprint of the platform-supplied source IP for admission limits.
    const source = await fingerprint(`${Math.floor(now / 86400000)}|${request.headers.get('cf-connecting-ip') || 'local'}`);
    const [, created] = await db.batch([
      db.prepare('DELETE FROM rooms WHERE id IN (SELECT id FROM rooms WHERE expires <= ? ORDER BY expires LIMIT 8)').bind(now),
      db.prepare(`INSERT OR IGNORE INTO rooms(id,host,enrollment,source,created,expires)
        SELECT ?,?,?,?,?,? WHERE (SELECT count(*) FROM rooms WHERE closed=0 AND expires>?) < 256
        AND (SELECT count(*) FROM rooms WHERE source=? AND created>?) < 12`)
        .bind(id, token, proof, source, now, now + WAIT_MS, now, source, now - 60_000)
    ]);
    if (created.meta.changes > 0) return reply(201);
    const room = await db.prepare('SELECT host,enrollment,closed,expires FROM rooms WHERE id=?').bind(id).first();
    if (!room) return reply(429);
    if (room.closed || room.expires <= now) return reply(410);
    return reply(room.host === token && room.enrollment === proof ? 200 : 409);
  }
  if (!TOKEN.test(proof)) return reply(400);
  const enrollment = await fingerprint(proof);
  const room = await db.prepare('SELECT enrollment,viewer,closed,expires FROM rooms WHERE id=?').bind(id).first();
  if (!room) return reply(404);
  if (room.enrollment !== enrollment) return reply(403);
  if (room.closed || room.expires <= now) return reply(410);
  if (room.viewer) return reply(room.viewer === token ? 200 : 409);
  const result = await db.prepare(`UPDATE rooms SET viewer=?, expires=? WHERE id=? AND enrollment=?
      AND viewer IS NULL AND closed=0 AND expires>?`).bind(token, now + SESSION_MS, id, enrollment, now).run();
  return reply(result.meta.changes ? 201 : 409);
}

async function packetBody(request) {
  const declared = request.headers.get('content-length');
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > MAX_PACKET)) return null;
  const reader = request.body?.getReader();
  if (!reader) return null;
  const chunks = [];
  let size = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_PACKET) { await reader.cancel(); return null; }
    chunks.push(value);
  }
  if (size < 50) return null;
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes;
}

async function receive(db, id, role, token, seq, now) {
  const sender = role === 'host' ? 'viewer' : 'host';
  // The role is limited to a fixed enum by PATH. One indexed read per idle poll.
  const row = await db.prepare(`SELECT r.${role} AS auth,r.closed,r.expires,m.bytes FROM rooms r
    LEFT JOIN messages m ON m.room=r.id AND m.sender=? AND m.seq=? WHERE r.id=? AND r.${role}=?`)
    .bind(sender, seq, id, token).first();
  if (!row || row.expires <= now) return reply(410);
  if (row.bytes != null) return reply(200, new Uint8Array(row.bytes));
  return reply(row.closed ? 410 : 204);
}

async function submit(db, request, id, role, token, seq, now) {
  if (request.headers.get('content-type')?.split(';')[0].toLowerCase() !== 'application/octet-stream') return reply(415);
  const room = await db.prepare(`SELECT closed,expires FROM rooms WHERE id=? AND ${role}=?`).bind(id, token).first();
  if (!room || room.closed || room.expires <= now) return reply(410);
  const bytes = await packetBody(request);
  if (!bytes) return reply(413);
  const digest = await fingerprint(bytes);
  // The INSERT atomically enforces ordering, total bytes and the room lifetime.
  const result = await db.prepare(`INSERT OR IGNORE INTO messages(room,sender,seq,bytes,size,digest)
    SELECT ?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM rooms WHERE id=? AND ${role}=? AND expires>? AND closed=0 AND viewer IS NOT NULL)
    AND ?=(SELECT coalesce(max(seq),0)+1 FROM messages WHERE room=? AND sender=?)
    AND ?+(SELECT coalesce(sum(size),0) FROM messages WHERE room=? AND sender=?)<=?`)
    .bind(id, role, seq, bytes.buffer, bytes.length, digest, id, token, Date.now(), seq, id, role, bytes.length, id, role, MAX_DIRECTION_BYTES).run();
  if (result.meta.changes > 0) return reply(204);
  const old = await db.prepare('SELECT digest FROM messages WHERE room=? AND sender=? AND seq=?').bind(id, role, seq).first();
  return reply(old?.digest === digest ? 204 : 409);
}

function turnURLs(value) {
  const urls = JSON.parse(value);
  if (!Array.isArray(urls) || !urls.length || urls.length > 8) throw Error('Invalid TURN configuration');
  for (const url of urls) {
    if (typeof url !== 'string' || url.length > 512) throw Error('Invalid TURN URL');
    const match = /^(turns?):(\[[a-fA-F0-9:]+\]|[a-zA-Z0-9.-]+)(?::([1-9]\d{0,4}))?(?:\?transport=(udp|tcp))?$/.exec(url);
    if (!match || Number(match[3]) > 65535 || (match[1] === 'turns' && match[4] === 'udp')) throw Error('Invalid TURN URL');
    // The URL parser also validates IPv4/IPv6 literals and hostname syntax.
    new URL('https://' + match[2]);
  }
  return urls;
}

async function iceCredentials(env, id, role, token, now) {
  const room = await env.DB.prepare(`SELECT expires FROM rooms WHERE id=? AND ${role}=? AND viewer IS NOT NULL AND closed=0 AND expires>?`)
    .bind(id, token, now).first();
  if (!room) return reply(403);
  if (!env.CC_TURN_URLS && !env.CC_TURN_SECRET) return reply(204);
  if (typeof env.CC_TURN_SECRET !== 'string' || env.CC_TURN_SECRET.length < 32) return reply(503);
  const urls = turnURLs(env.CC_TURN_URLS);
  // Align credentials to half-hour intervals so repeated requests do not mint new
  // usernames that defeat coturn's per-user allocation quota.
  const window = 30 * 60_000;
  const expiry = Math.floor(Math.min(room.expires, Math.floor(now / window) * window + 2 * window) / 1000);
  const username = expiry + ':cc-' + id.slice(0, 20) + '-' + role;
  const utf8 = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', utf8.encode(env.CC_TURN_SECRET), {name:'HMAC', hash:'SHA-1'}, false, ['sign']);
  const signature = new Uint8Array(await crypto.subtle.sign('HMAC', key, utf8.encode(username)));
  const credential = btoa(String.fromCharCode(...signature));
  return Response.json({ iceServers: [{ urls, username, credential }], expiresAt: expiry * 1000 }, { headers });
}

async function handle(request, env) {
  const url = new URL(request.url);
  if (request.method === 'GET' && url.pathname === '/health') {
    await env.DB.prepare('SELECT 1 FROM rooms LIMIT 1').first();
    return Response.json({ service: 'cc-connect-pair', protocol: 1 }, { headers });
  }
  const match = PATH.exec(url.pathname);
  if (!match || url.search) return reply(404);
  const [, id, role, sequence, ice] = match;
  const auth = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(request.headers.get('authorization') || '');
  if (!auth) return reply(401);
  const token = await fingerprint(auth[1]);
  const now = Date.now();
  if (ice) return request.method === 'GET' ? iceCredentials(env, id, role, token, now) : reply(405);
  if (!sequence) {
    if (request.method === 'POST') return register(env.DB, request, id, role, token, now);
    if (request.method !== 'DELETE') return reply(405);
    await env.DB.prepare(`UPDATE rooms SET closed=1,expires=min(expires,?) WHERE id=? AND ${role}=? AND closed=0`)
      .bind(now + DRAIN_MS, id, token).run();
    return reply(204);
  }
  const seq = Number(sequence);
  if (seq > MAX_SEQ) return reply(429);
  if (request.method === 'GET') return receive(env.DB, id, role, token, seq, now);
  if (request.method === 'PUT') return submit(env.DB, request, id, role, token, seq, now);
  return reply(405);
}

export default {
  async fetch(request, env) {
    try { return await handle(request, env); }
    catch { return reply(503); }
  }
};
