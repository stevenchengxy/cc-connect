import { accessError, accountRoutes, authenticate, fingerprint } from './auth.js';
import { closeRoomRelay, managedIce, inspectRelayIfDue } from './usage.js';

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

// Caller and both role owners must still have a current, approved login.
// Checking this inside the SQL mutation also covers logout during a slow PUT.
const liveSession = (account,session) => `EXISTS(SELECT 1 FROM account_sessions s
  JOIN accounts a ON a.id=s.account WHERE s.digest=${session} AND s.account=${account}
  AND s.expires>(julianday('now')-2440587.5)*86400000 AND a.status='approved')`;
const membersLive = liveSession('r.host_account','r.host_session') +
  ' AND (r.viewer IS NULL OR '+liveSession('r.viewer_account','r.viewer_session')+')';
const membership = role => `r.${role}=? AND r.${role}_account=? AND r.${role}_session=? AND ${membersLive}`;

async function register(db, request, id, role, token, now, actor) {
  const proof = request.headers.get('x-viewer-proof') || '';
  if (role === 'host') {
    if (!HEX_DIGEST.test(proof)) return reply(400);
    // Retain only a daily fingerprint of the platform-supplied source IP for admission limits.
    const source = await fingerprint(`${Math.floor(now / 86400000)}|${request.headers.get('cf-connecting-ip') || 'local'}`);
    const [, created] = await db.batch([
      db.prepare('DELETE FROM rooms WHERE id IN (SELECT id FROM rooms WHERE expires <= ? ORDER BY expires LIMIT 8)').bind(now),
      db.prepare(`INSERT OR IGNORE INTO rooms(id,host,enrollment,source,created,expires,host_account,host_session)
        SELECT ?,?,?,?,?,?,?,? WHERE ${liveSession('?','?')} AND (SELECT count(*) FROM rooms WHERE closed=0 AND expires>?) < 256
        AND (SELECT count(*) FROM rooms WHERE source=? AND created>?) < 12`)
        .bind(id, token, proof, source, now, now + WAIT_MS, actor.id, actor.digest, actor.digest, actor.id, now, source, now - 60_000)
    ]);
    if (created.meta.changes > 0) return reply(201);
    const room = await db.prepare(`SELECT host,host_account,host_session,enrollment,closed,expires,
      (${membersLive}) AS live FROM rooms r WHERE id=?`).bind(id).first();
    if (!room) return reply(429);
    if (room.closed || room.expires <= now || !room.live) return reply(410);
    return reply(room.host === token && room.host_account === actor.id && room.host_session === actor.digest && room.enrollment === proof ? 200 : 409);
  }
  if (!TOKEN.test(proof)) return reply(400);
  const enrollment = await fingerprint(proof);
  const room = await db.prepare(`SELECT enrollment,viewer,viewer_account,viewer_session,closed,expires FROM rooms r WHERE id=? AND ${membersLive}`).bind(id).first();
  if (!room) return reply(404);
  if (room.enrollment !== enrollment) return reply(403);
  if (room.closed || room.expires <= now) return reply(410);
  if (room.viewer) return reply(room.viewer === token && room.viewer_account === actor.id && room.viewer_session === actor.digest ? 200 : 409);
  const result = await db.prepare(`UPDATE rooms AS r SET viewer=?, expires=?, viewer_account=?, viewer_session=? WHERE id=? AND enrollment=?
      AND viewer IS NULL AND closed=0 AND expires>? AND ${membersLive} AND ${liveSession('?','?')}`)
    .bind(token, now + SESSION_MS, actor.id, actor.digest, id, enrollment, now, actor.digest, actor.id).run();
  return reply(result.meta.changes ? 201 : 409);
}

async function boundedBytes(request, limit, minimum) {
  const declared = request.headers.get('content-length');
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > limit)) return null;
  const reader = request.body?.getReader();
  if (!reader) return null;
  const chunks = [];
  let size = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) { await reader.cancel(); return null; }
    chunks.push(value);
  }
  if (size < minimum) return null;
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes;
}

async function receive(env, ctx, id, role, token, seq, now, actor) {
  const sender = role === 'host' ? 'viewer' : 'host';
  // The role is limited to a fixed enum by PATH. One indexed read per idle poll.
  const row = await env.DB.prepare(`SELECT r.${role} AS auth,r.closed,r.expires,m.bytes,inspection.expires AS next_check FROM rooms r
    LEFT JOIN messages m ON m.room=r.id AND m.sender=? AND m.seq=?
    LEFT JOIN auth_rate inspection ON inspection.bucket='relay-inspection' WHERE r.id=? AND ${membership(role)}`)
    .bind(sender, seq, id, token, actor.id, actor.digest).first();
  if (!row || row.expires <= now) return reply(410);
  if (ctx && !row.closed && (row.next_check ?? 0)<=now) ctx.waitUntil(inspectRelayIfDue(env));
  if (row.bytes != null) return reply(200, new Uint8Array(row.bytes));
  return reply(row.closed ? 410 : 204);
}

async function submit(db, request, id, role, token, seq, now, actor) {
  if (request.headers.get('content-type')?.split(';')[0].toLowerCase() !== 'application/octet-stream') return reply(415);
  const room = await db.prepare(`SELECT closed,expires FROM rooms r WHERE id=? AND ${membership(role)}`).bind(id, token, actor.id, actor.digest).first();
  if (!room || room.closed || room.expires <= now) return reply(410);
  const bytes = await boundedBytes(request, MAX_PACKET, 50);
  if (!bytes) return reply(413);
  const digest = await fingerprint(bytes);
  // The INSERT atomically enforces ordering, total bytes and the room lifetime.
  const result = await db.prepare(`INSERT OR IGNORE INTO messages(room,sender,seq,bytes,size,digest)
    SELECT ?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM rooms r WHERE id=? AND ${membership(role)} AND expires>? AND closed=0 AND viewer IS NOT NULL)
    AND ?=(SELECT coalesce(max(seq),0)+1 FROM messages WHERE room=? AND sender=?)
    AND ?+(SELECT coalesce(sum(size),0) FROM messages WHERE room=? AND sender=?)<=?`)
    .bind(id, role, seq, bytes.buffer, bytes.length, digest, id, token, actor.id, actor.digest, Date.now(), seq, id, role, bytes.length, id, role, MAX_DIRECTION_BYTES).run();
  if (result.meta.changes > 0) return reply(204);
  const old = await db.prepare('SELECT digest FROM messages WHERE room=? AND sender=? AND seq=?').bind(id, role, seq).first();
  return reply(old?.digest === digest ? 204 : 409);
}

async function handle(request, env, ctx) {
  const url = new URL(request.url);
  if (request.method === 'GET' && url.pathname === '/health') {
    await env.DB.prepare('SELECT singleton FROM admin_setup LIMIT 1').first();
    return Response.json({ service: 'cc-connect-pair', protocol: 1 }, { headers });
  }
  const accountResponse = await accountRoutes(request,env);
  if (accountResponse) return accountResponse;
  const match = PATH.exec(url.pathname);
  if (!match || url.search) return reply(404);
  const [, id, role, sequence, ice] = match;
  const auth = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(request.headers.get('authorization') || '');
  if (!auth) return reply(401);
  const token = await fingerprint(auth[1]);
  const now = Date.now();
  const actor = await authenticate(env.DB,request.headers.get('x-cc-session'),now);
  const denied = accessError(actor);
  if (denied) return denied;
  if (ice) {
    if (request.method !== 'GET') return reply(405);
    const room = await env.DB.prepare(`SELECT expires FROM rooms r WHERE id=? AND ${membership(role)}
      AND viewer IS NOT NULL AND closed=0 AND expires>?`).bind(id,token,actor.id,actor.digest,now).first();
    if (!room) return reply(403);
    return managedIce(env,{accountId:actor.id,roomId:id,role,roomExpiresAt:room.expires});
  }
  if (!sequence) {
    if (request.method === 'POST') return register(env.DB, request, id, role, token, now, actor);
    if (request.method !== 'DELETE') return reply(405);
    const result = await env.DB.prepare(`UPDATE rooms AS r SET closed=1,expires=min(expires,?) WHERE id=? AND ${membership(role)} AND closed=0`)
      .bind(now + DRAIN_MS, id, token, actor.id, actor.digest).run();
    if (result.meta.changes) await closeRoomRelay(env,id);
    return reply(204);
  }
  const seq = Number(sequence);
  if (seq > MAX_SEQ) return reply(429);
  if (request.method === 'GET') return receive(env, ctx, id, role, token, seq, now, actor);
  if (request.method === 'PUT') return submit(env.DB, request, id, role, token, seq, now, actor);
  return reply(405);
}

export default {
  scheduled(controller,env,ctx) {
    ctx.waitUntil(inspectRelayIfDue(env));
  },
  async fetch(request, env, ctx) {
    try { return await handle(request, env, ctx); }
    catch { return reply(503); }
  }
};
