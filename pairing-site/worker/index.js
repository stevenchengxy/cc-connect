import { accessError, accountRoutes, authenticate, fingerprint, rate } from './auth.js';
import { closeRoomRelay, managedIce, inspectRelayIfDue } from './usage.js';
import { deviceRoutes } from './device-alias.js';
import { liveSession, membersLive } from './membership.js';

// Only invitation-key holders can complete the endpoint-to-endpoint challenge.
// This service routes their opaque signaling packets and never receives the key.
const WAIT_MS = 10 * 60_000;
const SESSION_MS = 12 * 60 * 60_000;
const DRAIN_MS = 90_000;
const MAX_PACKET = 160 * 1024;
const MAX_DIRECTION_BYTES = 2 * 1024 * 1024;
const MAX_PENDING = 512;
const MAX_SEQ = 16_384;
const DIGEST_BYTES = 64; // SHA-256 stored as lowercase hex.
const PACKETS_PER_MINUTE = 32;
const TOKEN = /^[A-Za-z0-9_-]{43}$/;
const HEX_DIGEST = /^[0-9a-f]{64}$/;
const PATH = /^\/v1\/rooms\/([A-Za-z0-9_-]{43})\/(host|viewer)(?:\/(?:messages\/([1-9]\d{0,4})|(ice)))?$/;
const headers = { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' };

function reply(status, body = null) {
  return new Response(body, { status, headers: body ? { ...headers, 'content-type': 'application/octet-stream' } : headers });
}

// Caller and both role owners must still have a current, approved login.
// Checking this inside the SQL mutation also covers logout during a slow PUT.
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
  // Apply admission limits before looking up the room, so successful guesses
  // cannot be distinguished from failures after the requester reaches its limit.
  const source = request.headers.get('cf-connecting-ip') || 'local';
  await db.prepare('DELETE FROM auth_rate WHERE bucket IN (SELECT bucket FROM auth_rate WHERE expires<=? LIMIT 8)').bind(now).run();
  if (!await rate(db, 'pair-viewer-account|' + actor.id, 15, now, 60_000) ||
      !await rate(db, 'pair-viewer-ip|' + source, 90, now, 60_000)) return reply(429);
  const enrollment = await fingerprint(proof);
  const room = await db.prepare(`SELECT enrollment,viewer,viewer_account,viewer_session,closed,created,expires FROM rooms r WHERE id=? AND ${membersLive}`).bind(id).first();
  if (!room) return reply(404);
  if (room.enrollment !== enrollment) return reply(403);
  if (room.closed || room.expires <= now) {
    let state = 'expired';
    if (room.viewer) state = 'used';
    else if (room.closed && room.created + WAIT_MS > now) state = 'closed';
    return new Response(null, { status: 410, headers: { ...headers, 'x-cc-invite-state': state } });
  }
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
  const db = env.DB;
  // Every shipped client requests N+1 after receiving the complete body of N.
  // A repeated GET N still receives the same ciphertext if a response was lost.
  const row = await db.prepare(`SELECT r.closed,r.expires,m.bytes,m.size,m.served,
    prev.served AS prev_served,prev.size AS prev_size,inspection.expires AS next_check FROM rooms r
    LEFT JOIN messages m ON m.room=r.id AND m.sender=? AND m.seq=?
    LEFT JOIN messages prev ON prev.room=r.id AND prev.sender=? AND prev.seq=?
    LEFT JOIN auth_rate inspection ON inspection.bucket='relay-inspection' WHERE r.id=? AND ${membership(role)}`)
    .bind(sender, seq, sender, seq-1, id, token, actor.id, actor.digest).first();
  if (!row || row.expires <= now) return reply(410);
  if (ctx && !row.closed && (row.next_check ?? 0)<=now) ctx.waitUntil(inspectRelayIfDue(env));
  const live = `EXISTS(SELECT 1 FROM rooms r WHERE id=? AND ${membership(role)} AND expires>?)`;
  const auth = [id, token, actor.id, actor.digest, Date.now()];
  const changes = [];
  if (row.prev_served && row.prev_size > 0) {
    changes.push(db.prepare(`UPDATE messages SET bytes=x'',size=0 WHERE room=? AND sender=? AND seq=?
      AND served=1 AND size>0 AND ${live}`).bind(id,sender,seq-1,...auth));
  }
  if (row.size > 0 && !row.served) {
    changes.push(db.prepare(`UPDATE messages SET served=1 WHERE room=? AND sender=? AND seq=?
      AND size>0 AND ${live}`).bind(id,sender,seq,...auth));
  }
  if (changes.length) {
    const results = await db.batch(changes);
    if (row.size > 0 && !row.served && !results.at(-1).meta.changes) return reply(410);
  }
  if (row.size > 0) return reply(200, new Uint8Array(row.bytes));
  return reply(row.closed || row.size === 0 ? 410 : 204);
}

async function submit(db, request, id, role, token, seq, now, actor) {
  if (request.headers.get('content-type')?.split(';')[0].toLowerCase() !== 'application/octet-stream') return reply(415);
  const room = await db.prepare(`SELECT closed,expires,created FROM rooms r WHERE id=? AND ${membership(role)}`).bind(id, token, actor.id, actor.digest).first();
  if (!room || room.closed || room.expires <= now) return reply(410);
  // Keep the original burst allowance and grow the lifetime work allowance at
  // a bounded rate for long media sessions. Replays stay at their existing seq.
  const budget = MAX_PENDING + Math.floor(Math.max(0,now-room.created) * PACKETS_PER_MINUTE / 60_000);
  if (seq > budget) return reply(429);
  const bytes = await boundedBytes(request, MAX_PACKET, 50);
  if (!bytes) return reply(413);
  const digest = await fingerprint(bytes);
  // The INSERT atomically enforces ordering, total bytes and the room lifetime.
  const result = await db.prepare(`INSERT OR IGNORE INTO messages(room,sender,seq,bytes,size,digest)
    SELECT ?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM rooms r WHERE id=? AND ${membership(role)} AND expires>? AND closed=0 AND viewer IS NOT NULL)
    AND ?=(SELECT coalesce(max(seq),0)+1 FROM messages WHERE room=? AND sender=?)
    AND EXISTS(SELECT 1 FROM (SELECT count(*) AS pending,coalesce(sum(size),0) AS outstanding
      FROM messages WHERE room=? AND sender=? AND size>0) WHERE pending<? AND outstanding+?<=?)`)
    .bind(id, role, seq, bytes.buffer, bytes.length, digest, id, token, actor.id, actor.digest, Date.now(), seq, id, role,
      id, role, MAX_PENDING, bytes.length + seq*DIGEST_BYTES, MAX_DIRECTION_BYTES).run();
  if (result.meta.changes > 0) return reply(204);
  const old = await db.prepare(`SELECT m.digest FROM messages m JOIN rooms r ON r.id=m.room
    WHERE m.room=? AND m.sender=? AND m.seq=? AND r.closed=0 AND r.expires>? AND ${membership(role)}`)
    .bind(id, role, seq, Date.now(), token, actor.id, actor.digest).first();
  return reply(old?.digest === digest ? 204 : 409);
}

async function handle(request, env, ctx) {
  const url = new URL(request.url);
  if (request.method === 'GET' && url.pathname === '/health') {
    await env.DB.prepare('SELECT EXISTS(SELECT 1 FROM admin_setup), EXISTS(SELECT 1 FROM device_aliases)').first();
    return Response.json({ service:'cc-connect-pair', protocol:1, deviceCodes:true }, {headers});
  }
  const accountResponse = await accountRoutes(request,env);
  if (accountResponse) return accountResponse;
  if (url.pathname.startsWith('/v1/devices/')) return deviceRoutes(request,url,env.DB);
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
  // An idle reader can acknowledge the final allowed packet and keep the room alive.
  if (seq > MAX_SEQ + (request.method === 'GET' ? 1 : 0)) return reply(429);
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
