import { accessError, authenticate, fingerprint, jsonBody, rate } from './auth.js';
import { liveSession, membersLive, nowMs } from './membership.js';

const path = /^\/v1\/devices\/([A-Za-z0-9_-]{43})(\/publish)?$/;
const bearer = /^Bearer ([A-Za-z0-9_-]{43})$/;
const token = /^[A-Za-z0-9_-]{43}$/;
const ciphertext = /^[A-Za-z0-9_-]{40,6000}$/;
const headers = {'cache-control':'no-store','x-content-type-options':'nosniff','referrer-policy':'no-referrer'};
const reply = status => new Response(null,{status,headers});
const liveRoom = `r.closed=0 AND r.expires>${nowMs} AND ${membersLive}`;
const signedIn = liveSession('?','?'); // bind session digest, then account ID
const ownedRoom = 'FROM rooms r WHERE r.id=? AND r.host=? AND r.host_account=? AND r.host_session=?';

async function lookup(db,alias,actor) {
  // This lookup does not enroll a viewer, consume an invite or issue TURN.
  const row = await db.prepare(`SELECT d.envelope FROM device_aliases d JOIN rooms r ON r.id=d.room
    WHERE d.alias=? AND d.retired=0 AND d.owner=r.host_account AND r.viewer IS NULL
    AND (r.allowed_viewer IS NULL OR r.allowed_viewer=?) AND ${liveRoom} AND ${signedIn}`)
    .bind(alias,actor.id,actor.digest,actor.id).first();
  return row ? Response.json({envelope:row.envelope},{headers}) : reply(404);
}

async function publish(db,request,alias,manager,actor) {
  const data = await jsonBody(request);
  if (typeof data?.room !== 'string' || !token.test(data.room) ||
      typeof data.hostToken !== 'string' || !token.test(data.hostToken) ||
      typeof data.envelope !== 'string' || !ciphertext.test(data.envelope) ||
      new Set([alias,manager,data.room,data.hostToken,request.headers.get('x-cc-session')]).size !== 5) return reply(400);
  const managerDigest = await fingerprint(manager);
  const host = [data.room,await fingerprint(data.hostToken),actor.id,actor.digest];
  const available = `${ownedRoom} AND ${liveRoom} AND r.viewer IS NULL`;
  const previous = await db.prepare('SELECT room,room_created FROM device_aliases WHERE alias=?').bind(alias).first();
  const previousRoom = previous?.room ?? null;
  // If a previous application's DELETE was lost, replace its waiting room
  // atomically. The compare-and-swap and creation watermark survive cleanup
  // and keep late publications out. A room already claimed is never replaced.
  const [created, rebound] = await db.batch([
    db.prepare(`INSERT OR IGNORE INTO device_aliases(alias,owner,manager_digest,room,envelope,room_created)
      SELECT ?,?,?,r.id,?,r.created ${available}`)
      .bind(alias,actor.id,managerDigest,data.envelope,...host),
    db.prepare(`UPDATE OR IGNORE device_aliases SET room=?,envelope=?,room_created=(SELECT created FROM rooms WHERE id=?)
      WHERE alias=? AND owner=? AND manager_digest=? AND retired=0 AND room IS ? AND room IS NOT ?
      AND NOT EXISTS(SELECT 1 FROM rooms r WHERE r.id=device_aliases.room AND r.viewer IS NOT NULL AND ${liveRoom})
      AND EXISTS(SELECT 1 ${available} AND r.created>device_aliases.room_created)`)
      .bind(data.room,data.envelope,data.room,alias,actor.id,managerDigest,previousRoom,data.room,...host),
    db.prepare(`UPDATE rooms SET closed=1,expires=0 WHERE id=? AND id<>? AND created=? AND host_account=?
      AND viewer IS NULL AND closed=0 AND EXISTS(SELECT 1 FROM device_aliases
      WHERE alias=? AND owner=? AND manager_digest=? AND retired=0 AND room=?)`)
      .bind(previousRoom,data.room,previous?.room_created ?? 0,actor.id,alias,actor.id,managerDigest,data.room)
  ]);
  if (created.meta.changes) return reply(201);
  if (rebound.meta.changes) return reply(200);
  // An identical retry may arrive just after a viewer claimed the published
  // invitation. A changed envelope must never overwrite that publication.
  const old = await db.prepare(`SELECT owner,manager_digest,retired,room,envelope FROM device_aliases WHERE alias=?`).bind(alias).first();
  if (old && (old.owner !== actor.id || old.manager_digest !== managerDigest)) return reply(403);
  if (old?.retired) return reply(410);
  const target = await db.prepare(`SELECT (${liveRoom}) AS live ${ownedRoom}`).bind(...host).first();
  if (!target) return reply(403);
  return reply(target.live && old?.room === data.room && old.envelope === data.envelope ? 200 : 409);
}

async function retire(db,alias,manager,actor) {
  const auth = [alias,actor.id,await fingerprint(manager)];
  const login = [actor.digest,actor.id];
  // Atomic with room registration/claim. If rotation wins, a previously
  // fetched envelope cannot claim the old room. An active call wins with 409.
  const [reserved,, retired] = await db.batch([
    db.prepare(`INSERT OR IGNORE INTO device_aliases(alias,owner,manager_digest,retired)
      SELECT ?,?,?,1 WHERE ${signedIn}`).bind(...auth,...login),
    db.prepare(`UPDATE rooms SET closed=1,expires=0 WHERE viewer IS NULL AND closed=0 AND host_account=?
      AND id=(SELECT room FROM device_aliases WHERE alias=? AND owner=? AND manager_digest=? AND retired=0)
      AND ${signedIn}`).bind(actor.id,...auth,...login),
    db.prepare(`UPDATE device_aliases SET room=NULL,envelope=NULL,retired=1
      WHERE alias=? AND owner=? AND manager_digest=? AND ${signedIn}
      AND NOT EXISTS(SELECT 1 FROM rooms r WHERE r.id=device_aliases.room AND ${liveRoom})`).bind(...auth,...login)
  ]);
  if (reserved.meta.changes || retired.meta.changes) return reply(204);
  const owner = await db.prepare(`SELECT 1 FROM device_aliases WHERE alias=? AND owner=? AND manager_digest=? AND ${signedIn}`)
    .bind(...auth,...login).first();
  return reply(owner ? 409 : 403);
}

export async function deviceRoutes(request,url,db) {
  const match = path.exec(url.pathname);
  if (!match || url.search) return reply(404);
  const [,alias,publishing] = match;
  const reading = request.method === 'GET' && !publishing;
  if (!reading && !(request.method === 'POST' && publishing) && !(request.method === 'DELETE' && !publishing)) return reply(405);
  const session = request.headers.get('x-cc-session');
  const now = Date.now();
  const actor = await authenticate(db,session,now);
  const denied = accessError(actor);
  if (denied) return denied;
  const manager = bearer.exec(request.headers.get('authorization') || '')?.[1];
  if (!reading && !manager) return reply(401);
  if (!reading && new Set([alias,manager,session]).size !== 3) return reply(400);
  const kind = reading ? 'device-lookup' : 'device-manage';
  const ip = request.headers.get('cf-connecting-ip') || 'local';
  await db.prepare('DELETE FROM auth_rate WHERE bucket IN (SELECT bucket FROM auth_rate WHERE expires<=? LIMIT 8)').bind(now).run();
  if (!await rate(db,kind+'-account|'+actor.id,30,now,60_000) ||
      !await rate(db,kind+'-ip|'+ip,120,now,60_000)) return reply(429);
  if (reading) return lookup(db,alias,actor);
  return publishing ? publish(db,request,alias,manager,actor) : retire(db,alias,manager,actor);
}
