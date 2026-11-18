import {accountPattern, readTurnUsage, issueTurn, revokeTurn, verifyKeyOwner, issuerConfigured, meterDiagnostic} from './usage-provider.js';

const headers = {'cache-control':'no-store','x-content-type-options':'nosniff'};
const reply = (status, data) => data === undefined ? new Response(null,{status,headers}) : Response.json(data,{status,headers});
const defaults = {mode:'off', limit_bytes:0, max_concurrent:0, revision:0};
const limit = value => value - Math.ceil(value / 10); // stop issuing at 90% of either budget
const REVOCATION_BATCH = 20;
const ACTIVE = "state IN ('issuing','active','revoking')";
// Each stored account row is one cumulative high-water mark per billing period.
// These accounts are part of the provider's global aggregate, so the two views
// overlap and must never be added together.
const attributedHighWater = `(SELECT coalesce(sum(a.high_egress),0) FROM relay_meters a
  WHERE a.period_start=gm.period_start AND a.scope!='global')`;
const globalBudgetUse = `max(gm.high_egress,${attributedHighWater})`;

async function globalMeter(db,period) {
  const row=await db.prepare(`SELECT gm.high_egress, gm.ever_reported, ${attributedHighWater} AS attributed
    FROM relay_meters gm WHERE gm.scope='global' AND gm.period_start=?`).bind(period).first();
  if (!row || ![row.high_egress,row.attributed].every(n=>Number.isSafeInteger(n)&&n>=0)) throw Error('Incomplete global meter');
  return {...row,budgetEgressBytes:Math.max(row.high_egress,row.attributed)};
}

async function quota(db, scope) {
  return await db.prepare('SELECT * FROM relay_quotas WHERE scope=?').bind(scope).first() || defaults;
}
async function meter(env, scope) {
  const m = await readTurnUsage(env,scope);
  const db = env.DB;
  await db.prepare(`INSERT INTO relay_meters(scope,period_start,checked,high_egress,ever_reported) VALUES(?,?,?,?,?)
    ON CONFLICT(scope,period_start) DO UPDATE SET checked=max(checked,excluded.checked),
    high_egress=max(high_egress,excluded.high_egress),ever_reported=max(ever_reported,excluded.ever_reported)`)
    .bind(scope,m.periodStart,m.checkedAt,m.egressBytes,Number(m.hasRecords)).run();
  const row = scope==='global' ? await globalMeter(db,m.periodStart)
    : await db.prepare('SELECT high_egress,ever_reported FROM relay_meters WHERE scope=? AND period_start=?')
    .bind(scope,m.periodStart).first();
  if (!row || (!m.hasRecords && row.ever_reported)) throw Error('Incomplete meter');
  return {...m, highWaterEgressBytes:row.high_egress, budgetEgressBytes:row.budgetEgressBytes ?? row.high_egress,
    ...(scope==='global' ? {attributedHighWaterEgressBytes:row.attributed} : {})};
}

function matching(scope, id) {
  if (scope === 'global') return {where:'1=1',args:[]};
  if (scope === 'room') return {where:'room=?',args:[id]};
  if (scope === 'session') return {where:'room IN (SELECT id FROM rooms WHERE host_session=? OR viewer_session=?)',args:[id,id]};
  if (scope === 'memberRooms') return {
    where:'(account=? OR room IN (SELECT id FROM rooms WHERE host_account=? OR viewer_account=?))',
    args:[id,id,id]
  };
  return {where:'account=?',args:[id]};
}

// Never delete an unconfirmed revocation or serve its cached password. A failed
// provider call remains retryable until the credential's own short TTL expires.
async function revokeMatching(env, scope, id) {
  const {where,args} = matching(scope,id), now = Date.now(), db = env.DB;
  await db.prepare(`UPDATE relay_leases SET state='revoking',payload=NULL WHERE ${where}
    AND state IN ('issuing','active') AND expires>?`).bind(...args,now).run();
  const {results} = await db.prepare(`SELECT id,key_id,username FROM relay_leases WHERE ${where}
    AND state='revoking' AND username IS NOT NULL AND expires>? LIMIT ?`).bind(...args,now,REVOCATION_BATCH).all();
  await retryRevocations(env,results);
}
async function retryRevocations(env, rows) {
  for (let i=0;i<rows.length;i+=4) {
    await Promise.all(rows.slice(i,i+4).map(async row=>{
      try {
        await revokeTurn(env,row.key_id,row.username);
        await env.DB.prepare("UPDATE relay_leases SET state='revoked',username=NULL,payload=NULL WHERE id=?").bind(row.id).run();
      } catch { /* Keep the revocation for reconciliation. */ }
    }));
  }
}
export const revokeAccountRelay = (env,id) => revokeMatching(env,'memberRooms',id);
export const closeRoomRelay = (env,id) => revokeMatching(env,'room',id);
export const closeSessionRelay = (env,digest) => revokeMatching(env,'session',digest);

function liveRoom(role) {
  // The caller authenticates the mailbox token as well. At delivery, both
  // accounts, their bound login sessions, and this participant must still match.
  return `EXISTS(SELECT 1 FROM rooms r JOIN accounts h ON h.id=r.host_account
    JOIN accounts v ON v.id=r.viewer_account JOIN account_sessions hs ON hs.digest=r.host_session AND hs.account=h.id
    JOIN account_sessions vs ON vs.digest=r.viewer_session AND vs.account=v.id
    WHERE r.id=? AND r.${role}_account=? AND r.closed=0 AND r.viewer IS NOT NULL AND r.expires>?
    AND h.status='approved' AND v.status='approved' AND hs.expires>? AND vs.expires>?)`;
}
function allowedPolicy() {
  return `EXISTS(SELECT 1 FROM relay_quotas g JOIN relay_quotas u ON u.scope=?
    JOIN relay_meters gm ON gm.scope=g.scope AND gm.period_start=? JOIN relay_meters um ON um.scope=u.scope AND um.period_start=gm.period_start
    WHERE g.scope='global' AND g.mode='protected' AND g.revision=? AND u.revision=?
    AND g.max_concurrent>0 AND u.max_concurrent>0 AND ${globalBudgetUse}<? AND um.high_egress<? AND gm.checked>=? AND um.checked>=?
    AND NOT EXISTS(SELECT 1 FROM relay_leases WHERE state='revoking' AND expires>?))`;
}

export async function managedIce(env,{accountId,roomId,role,roomExpiresAt}) {
  if (!accountPattern.test(accountId) || !/^[A-Za-z0-9_-]{43}$/.test(roomId || '') ||
      !['host','viewer'].includes(role) || !Number.isSafeInteger(roomExpiresAt)) return reply(403);
  const db = env.DB;
  const [global, user] = await Promise.all([quota(db,'global'),quota(db,accountId)]);
  if (global.mode !== 'protected') return reply(204);
  if (!issuerConfigured(env)) return reply(503);
  const now = Date.now(), roomArgs = t => [roomId,accountId,t,t,t];
  if (!await db.prepare('SELECT 1 WHERE '+liveRoom(role)).bind(...roomArgs(now)).first()) return reply(403);
  if (limit(global.limit_bytes)<=0 || limit(user.limit_bytes)<=0 || !global.max_concurrent || !user.max_concurrent) return reply(403);
  // Limit the read path as well: each refresh performs multiple provider reads.
  // Actor and room checks run first, before any account can consume these limits.
  for (const [bucket,max] of [['relay-room:'+roomId+':'+role,5],['relay-account:'+accountId,10],['relay-total',20]]) {
    const allowed=await db.prepare(`INSERT INTO auth_rate(bucket,attempts,expires) VALUES(?,1,?)
      ON CONFLICT(bucket) DO UPDATE SET attempts=CASE WHEN expires<=? THEN 1 ELSE attempts+1 END,
      expires=CASE WHEN expires<=? THEN excluded.expires ELSE expires END WHERE expires<=? OR attempts<?`)
      .bind(bucket,now+60000,now,now,now,max).run();
    if (!allowed.meta.changes) return reply(429);
  }
  await db.prepare('DELETE FROM relay_leases WHERE id IN (SELECT id FROM relay_leases WHERE expires<? LIMIT 32)').bind(now-60000).run();
  // Pre-account versions could mint untagged Cloudflare credentials. Wait for
  // any such grants to expire before allowing this installation to issue more.
  if (await db.prepare('SELECT 1 FROM turn_grants WHERE payload IS NOT NULL AND expires>? LIMIT 1').bind(now).first()) return reply(503);
  const observations = await Promise.allSettled([meter(env,'global'),meter(env,accountId),verifyKeyOwner(env)]);
  if (observations[0].status !== 'fulfilled' || observations[2].status !== 'fulfilled') {
    await revokeMatching(env,'global'); return reply(503);
  }
  if (observations[1].status !== 'fulfilled') { await revokeMatching(env,'account',accountId); return reply(503); }
  const [g,u] = observations.map(o=>o.value);
  if (g.periodStart !== u.periodStart) return reply(503);
  // The individual and provider queries run concurrently. Re-read the durable
  // total after both finish, including this participant's newly observed bytes.
  if ((await globalMeter(db,g.periodStart)).budgetEgressBytes >= limit(global.limit_bytes)) {
    await revokeMatching(env,'global'); return reply(403);
  }
  if (u.budgetEgressBytes >= limit(user.limit_bytes)) { await revokeMatching(env,'account',accountId); return reply(403); }
  const pending = await db.prepare("SELECT id,key_id,username FROM relay_leases WHERE state='revoking' AND username IS NOT NULL AND expires>? LIMIT 4")
    .bind(Date.now()).all();
  await retryRevocations(env,pending.results);
  const policyArgs = t => [accountId,g.periodStart,global.revision,user.revision,limit(global.limit_bytes),limit(user.limit_bytes),t-15000,t-15000,t];
  const entryTime = Date.now();
  const cache = await db.prepare(`SELECT payload FROM relay_leases WHERE room=? AND role=? AND account=? AND state='active'
    AND key_id=? AND expires>? AND ${liveRoom(role)} AND ${allowedPolicy()} ORDER BY expires DESC LIMIT 1`)
    .bind(roomId,role,accountId,env.CC_CF_TURN_KEY_ID,entryTime+35000,...roomArgs(entryTime),...policyArgs(entryTime)).first();
  if (cache) return reply(200,JSON.parse(cache.payload));
  const ttl = Math.min(120,Math.floor((Math.min(Date.parse(g.periodEnd),roomExpiresAt)-entryTime)/1000));
  if (ttl<5) return reply(403);
  const id = crypto.randomUUID(), expiresAt = entryTime+ttl*1000;
  // Count logical participants (a 35s credential handover may briefly overlap).
  // Reservations, failed/unknown provider calls and revocations count as live.
  // The same statement also bounds the number of new credentials in one minute.
  const count = `SELECT count(*) FROM (SELECT room,role FROM relay_leases WHERE ${ACTIVE} AND expires>?
    AND NOT(room=? AND role=?)`;
  const inserted = await db.prepare(`INSERT INTO relay_leases(id,room,role,account,key_id,created,expires,state)
    SELECT ?,?,?,?,?,?,?,'issuing' WHERE ${liveRoom(role)} AND ${allowedPolicy()}
    AND NOT EXISTS(SELECT 1 FROM relay_leases WHERE room=? AND role=? AND ${ACTIVE} AND expires>?
      AND (state!='active' OR expires>? OR created>?))
    AND (${count} GROUP BY room,role))<? AND (${count} AND account=? GROUP BY room,role))<?
    AND (SELECT count(*) FROM relay_leases WHERE created>?)<? AND (SELECT count(*) FROM relay_leases WHERE account=? AND created>?)<?`)
    .bind(id,roomId,role,accountId,env.CC_CF_TURN_KEY_ID,entryTime,expiresAt,...roomArgs(entryTime),...policyArgs(entryTime),
      roomId,role,entryTime,entryTime+35000,entryTime-5000,
      entryTime,roomId,role,global.max_concurrent,entryTime,roomId,role,accountId,user.max_concurrent,
      entryTime-60000,global.max_concurrent*2,accountId,entryTime-60000,user.max_concurrent*2).run();
  if (!inserted.meta.changes) return reply(429);
  let servers;
  try { servers = await issueTurn(env,accountId,ttl); }
  catch { return reply(503); } // Keep the reservation until expiry, including ambiguous timeouts.
  const result = {expiresAt,iceServers:servers}, username = servers[0].username, done = Date.now();
  try {
    const stored = await db.prepare(`UPDATE relay_leases SET state='active',username=?,payload=? WHERE id=? AND state='issuing'
      AND expires>? AND ${liveRoom(role)} AND ${allowedPolicy()}`).bind(username,JSON.stringify(result),id,done,...roomArgs(done),...policyArgs(done)).run();
    if (stored.meta.changes) return reply(200,result);
  } catch { /* Never hand out a grant before its durable record exists. */ }
  try { await db.prepare("UPDATE relay_leases SET state='revoking',username=?,payload=NULL WHERE id=?").bind(username,id).run(); }
  finally { await retryRevocations(env,[{id,key_id:env.CC_CF_TURN_KEY_ID,username}]); }
  return reply(403);
}

async function activeCount(db,scope) {
  const {where,args} = matching(scope === 'global' ? 'global' : 'account',scope);
  const row = await db.prepare(`SELECT count(*) AS n FROM (SELECT room,role FROM relay_leases
    WHERE ${ACTIVE} AND expires>? AND ${where} GROUP BY room,role)`).bind(Date.now(),...args).first();
  return row.n;
}
async function usageView(env,scope,enforce = true) {
  const [policy, global, activeGrants] = await Promise.all([quota(env.DB,scope),quota(env.DB,'global'),activeCount(env.DB,scope)]);
  let usage = null, diagnostic;
  try { usage = await meter(env,scope); }
  catch (error) { diagnostic = meterDiagnostic(error); }
  if (enforce && activeGrants && (!usage || usage.budgetEgressBytes >= limit(policy.limit_bytes))) {
    await revokeMatching(env,scope === 'global' ? 'global' : 'account',scope);
  }
  return {scope,mode:global.mode,limitBytes:policy.limit_bytes,maxConcurrent:policy.max_concurrent,
    stopAtBytes:limit(policy.limit_bytes),meterStatus:usage ? 'ok':'unavailable',usage,activeGrants,
    ...(diagnostic ? {meterDiagnostic:diagnostic} : {})};
}
async function smallJSON(request) {
  if (request.headers.get('content-type')?.split(';')[0] !== 'application/json' || !request.body) return null;
  const reader = request.body.getReader(), decoder = new TextDecoder();
  let size=0, value='';
  for (;;) {
    const {value:bytes,done}=await reader.read();
    if (done) break;
    size+=bytes.length;
    if (size>2048) { await reader.cancel(); return null; }
    value+=decoder.decode(bytes,{stream:true});
  }
  try { return JSON.parse(value+decoder.decode()); } catch { return null; }
}

export async function usageAdmin(request,env,actor) {
  const url = new URL(request.url);
  const patch = /^\/v1\/admin\/quotas\/([^/]+)$/.exec(url.pathname);
  if (url.pathname!=='/v1/admin/usage' && !patch) return null;
  const db=env.DB;
  if (!actor || actor.role!=='admin' || actor.status!=='approved' || !accountPattern.test(actor.id) ||
      !await db.prepare("SELECT 1 FROM accounts WHERE id=? AND role='admin' AND status='approved'").bind(actor.id).first()) return reply(403);
  const scope=patch ? patch[1] : (url.searchParams.get('accountId') ?? 'global');
  if (scope!=='global' && !accountPattern.test(scope)) return reply(400);
  if (scope!=='global' && !await db.prepare('SELECT 1 FROM accounts WHERE id=?').bind(scope).first()) return reply(404);
  if (!patch) {
    if (request.method!=='GET') return reply(405);
    return reply(200,await usageView(env,scope));
  }
  if (request.method!=='PATCH') return reply(405);
  const body=await smallJSON(request);
  if (!body || typeof body!=='object' || Array.isArray(body) || !Object.keys(body).length ||
      Object.keys(body).some(k=>!['limitBytes','maxConcurrent','mode'].includes(k)) ||
      ('mode' in body && (scope!=='global' || !['off','protected'].includes(body.mode)))) return reply(400);
  const prev=await quota(db,scope);
  const bytes='limitBytes' in body ? body.limitBytes : prev.limit_bytes;
  const concurrency='maxConcurrent' in body ? body.maxConcurrent : prev.max_concurrent;
  const mode=body.mode ?? prev.mode;
  if (!Number.isSafeInteger(bytes) || bytes<0 || bytes>1_000_000_000_000 || !Number.isInteger(concurrency) ||
      concurrency<0 || concurrency>(scope==='global' ? 16:8)) return reply(400);
  if (scope==='global' && mode==='protected') {
    if (limit(bytes)<=0 || !concurrency) return reply(400);
    if (prev.mode!=='protected' || bytes>prev.limit_bytes || concurrency>prev.max_concurrent) {
      if (!issuerConfigured(env)) return reply(503,{error:'relay_unavailable',meterDiagnostic:{stage:'turn_issuer',reason:'binding'}});
      try {
        const [observed]=await Promise.all([meter(env,'global'),verifyKeyOwner(env)]);
        if (observed.budgetEgressBytes>=limit(bytes)) return reply(409);
      } catch (error) { return reply(503,{error:'relay_unavailable',meterDiagnostic:meterDiagnostic(error)}); }
    }
  }
  const saved=await db.prepare(`INSERT INTO relay_quotas(scope,mode,limit_bytes,max_concurrent,revision)
    SELECT ?,?,?,?,1 WHERE EXISTS(SELECT 1 FROM accounts WHERE id=? AND role='admin' AND status='approved')
    ON CONFLICT(scope) DO UPDATE SET mode=excluded.mode,limit_bytes=excluded.limit_bytes,
    max_concurrent=excluded.max_concurrent,revision=revision+1 WHERE revision=?`)
    .bind(scope,mode,bytes,concurrency,actor.id,prev.revision).run();
  if (!saved.meta.changes) return reply(409);
  if (mode==='off' && scope==='global' || bytes<prev.limit_bytes || concurrency<prev.max_concurrent) {
    await revokeMatching(env,scope==='global'?'global':'account',scope);
  }
  return reply(200,await usageView(env,scope,false));
}

export async function reconcileRelayUsage(env) {
  const db=env.DB, now=Date.now();
  await db.batch([
    db.prepare('DELETE FROM relay_leases WHERE id IN (SELECT id FROM relay_leases WHERE expires<? LIMIT 256)').bind(now-60000),
    db.prepare('DELETE FROM relay_meters WHERE period_start<?').bind(new Date(now-100*86400000).toISOString()),
    db.prepare('DELETE FROM relay_days WHERE day<?').bind(new Date(now-100*86400000).toISOString().slice(0,10))
  ]);
  const {results:active}=await db.prepare(`SELECT l.account FROM relay_leases l LEFT JOIN relay_meters m ON m.scope=l.account
    WHERE ${ACTIVE} AND expires>? GROUP BY l.account ORDER BY coalesce(max(m.checked),0) ASC LIMIT 4`).bind(now).all();
  if (!active.length) return;
  const g=await quota(db,'global');
  if (g.mode!=='protected' || !g.max_concurrent) return revokeMatching(env,'global');
  let period;
  try {
    const [global]=await Promise.all([meter(env,'global'),verifyKeyOwner(env)]);
    period=global.periodStart;
    if (global.budgetEgressBytes>=limit(g.limit_bytes)) return revokeMatching(env,'global');
  } catch { return revokeMatching(env,'global'); }
  const {results:pending}=await db.prepare("SELECT id,key_id,username FROM relay_leases WHERE state='revoking' AND username IS NOT NULL AND expires>? LIMIT ?")
    .bind(now,REVOCATION_BATCH).all();
  await retryRevocations(env,pending);
  for (const {account} of active) {
    const status=await db.prepare('SELECT status FROM accounts WHERE id=?').bind(account).first();
    if (status?.status!=='approved') await revokeAccountRelay(env,account);
    else await usageView(env,account);
  }
  if ((await globalMeter(db,period)).budgetEgressBytes>=limit(g.limit_bytes)) await revokeMatching(env,'global');
}

// The timer and authenticated polling share one durable lease across isolates.
// An interrupted check becomes eligible again after one minute.
export async function inspectRelayIfDue(env) {
  const now=Date.now();
  const result=await env.DB.prepare(`INSERT INTO auth_rate(bucket,attempts,expires) VALUES('relay-inspection',1,?)
    ON CONFLICT(bucket) DO UPDATE SET attempts=1,expires=excluded.expires WHERE expires<=?`).bind(now+60000,now).run();
  if (result.meta.changes) await reconcileRelayUsage(env);
}
