// All authorization decisions use the primary D1 binding; clients keep only the raw session token.
import { periodAt } from './usage-provider.js';
import { closeSessionRelay, revokeAccountRelay, usageAdmin } from './usage.js';

const TOKEN = /^[A-Za-z0-9_-]{43}$/;
const INVITE_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
const SHORT_INVITE = /^[2-9A-HJ-NP-Z]{8}$/i;
const USERNAME = /^[a-z0-9][a-z0-9_.-]{2,39}$/i;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const DAY = 86_400_000;
const encoder = new TextEncoder();
const authHeaders = {'cache-control':'no-store','x-content-type-options':'nosniff','referrer-policy':'no-referrer'};
const SCHEME = 'pbkdf2-sha256-100000-dk192-sha256-v1';
const DUMMY_SALT = 'XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX';
export const authError = (status, error) => Response.json({error},{status,headers:authHeaders});
const json = (status, fields) => Response.json(fields,{status,headers:authHeaders});
const empty = () => new Response(null,{status:204,headers:authHeaders});
const seconds = ms => Math.floor(ms/1000);
const hex = bytes => Array.from(new Uint8Array(bytes), value => value.toString(16).padStart(2,'0')).join('');

export async function fingerprint(value) {
  return hex(await crypto.subtle.digest('SHA-256', typeof value === 'string' ? encoder.encode(value) : value));
}

function secret() {
  return btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32)))).replaceAll('+','-').replaceAll('/','_').replace(/=+$/,'');
}

function registrationInvite(value) {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (TOKEN.test(text)) return text;
  const compact = text.replace(/[\s-]/g,'');
  return SHORT_INVITE.test(compact) ? compact.toUpperCase() : null;
}

function equalDigest(left, right) {
  if (typeof right !== 'string' || left.length !== 64 || right.length !== 64) return false;
  let delta = 0;
  for (let i = 0; i < 64; i++) delta |= left.charCodeAt(i) ^ right.charCodeAt(i);
  return delta === 0;
}

async function passwordDigest(password,salt) {
  const key = await crypto.subtle.importKey('raw',encoder.encode(password),'PBKDF2',false,['deriveBits']);
  // Workers caps one PBKDF2 call at 100,000 iterations. Derive six full SHA-256
  // blocks and hash all of them, so verification requires all 600,000 PRF evaluations.
  const bytes = await crypto.subtle.deriveBits({name:'PBKDF2',hash:'SHA-256',iterations:100_000,salt:encoder.encode(salt)},key,192*8);
  return fingerprint(bytes);
}

export async function jsonBody(request) {
  if (request.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json') return null;
  if (Number(request.headers.get('content-length') || '0') > 8192) return null;
  const reader = request.body?.getReader();
  if (!reader) return null;
  const decoder = new TextDecoder('utf-8',{fatal:true});
  let size = 0, raw = '';
  try {
    for (;;) {
      const {done,value} = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 8192) { await reader.cancel(); return null; }
      raw += decoder.decode(value,{stream:true});
    }
    const data = JSON.parse(raw + decoder.decode());
    return data && typeof data === 'object' && !Array.isArray(data) ? data : null;
  } catch { return null; }
}

function userFields(data) {
  if (typeof data?.username !== 'string' || !USERNAME.test(data.username) ||
      typeof data.password !== 'string' || data.password.length < 12 || data.password.length > 128) return null;
  return {username:data.username.toLowerCase(),password:data.password};
}

function profile(row) {
  return {id:row.id,username:row.username,role:row.role,status:row.status,createdAt:seconds(row.created)};
}

// Only the platform-provided address is considered. Fixed windows and an indexed expiry
// let the service discard source and username fingerprints without storing addresses.
export async function rate(db, key, max, now, window = 15*60_000) {
  const epoch = Math.floor(now/window);
  const bucket = await fingerprint('auth-limit|' + key + '|' + epoch);
  const result = await db.prepare(`INSERT INTO auth_rate(bucket,attempts,expires)
    VALUES(?,1,?) ON CONFLICT(bucket) DO UPDATE SET attempts=attempts+1 WHERE attempts<?`)
    .bind(bucket,(epoch+1)*window,max).run();
  return result.meta.changes > 0;
}

async function entryAllowed(request,db,kind,username,now) {
  await db.prepare('DELETE FROM auth_rate WHERE bucket IN (SELECT bucket FROM auth_rate WHERE expires<=? LIMIT 32)').bind(now).run();
  const source = request.headers.get('CF-Connecting-IP') || 'unknown';
  if (!await rate(db,'ip|'+kind+'|'+source,kind === 'login' ? 30 : 12,now)) return false;
  if (!await rate(db,'global|'+kind,kind === 'login' ? 1500 : 250,now,60_000)) return false;
  return kind !== 'login' || rate(db,'username|'+username,12,now);
}

function authorization(request) {
  const match = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(request.headers.get('authorization') || '');
  return match?.[1];
}

export async function authenticate(db, raw, now = Date.now()) {
  if (typeof raw !== 'string' || !TOKEN.test(raw)) return null;
  const digest = await fingerprint(raw);
  const row = await db.prepare(`SELECT a.id,a.username,a.status,a.role,a.created,s.expires
    FROM account_sessions s JOIN accounts a ON a.id=s.account WHERE s.digest=? AND s.expires>?`).bind(digest,now).first();
  return row ? {...row,digest} : null;
}

export function accessError(actor) {
  if (!actor) return authError(401,'account_required');
  if (actor.status === 'approved') return null;
  return authError(403,'account_' + (['pending','suspended','revoked'].includes(actor.status) ? actor.status : 'suspended'));
}

async function createAccount(request, env, kind, now) {
  const data = await jsonBody(request);
  const fields = userFields(data);
  if (!fields) return authError(400,'invalid_request');
  const db = env.DB;
  if (!await entryAllowed(request,db,kind,fields.username,now)) return authError(429,'rate_limited');
  const setup = kind === 'bootstrap';
  const input = setup ? data.bootstrap : registrationInvite(data.invite);
  const reject = () => authError(403,'registration_unavailable');
  if (typeof input !== 'string' || (setup && !TOKEN.test(input))) return reject();
  const digest = await fingerprint(input);
  if (setup) {
    if (!equalDigest(digest,env.CC_ADMIN_BOOTSTRAP_SHA256) ||
        await db.prepare('SELECT singleton FROM admin_setup WHERE singleton=1').first()) return reject();
  } else if (!await db.prepare('SELECT digest FROM account_invites WHERE digest=? AND expires>?').bind(digest,now).first()) return reject();

  const salt = secret(), hash = await passwordDigest(fields.password,salt), id = crypto.randomUUID();
  const status = setup ? 'approved' : 'pending';
  const eligible = setup ? 'NOT EXISTS(SELECT 1 FROM admin_setup WHERE singleton=1)' :
    'EXISTS(SELECT 1 FROM account_invites WHERE digest=? AND expires>?)';
  const insert = db.prepare(`INSERT OR IGNORE INTO accounts(id,username,role,status,salt,password_hash,password_scheme,invite,created)
    SELECT ?,?,?,?,?,?,?,?,? WHERE `+eligible)
    .bind(id,fields.username,setup ? 'admin' : 'member',status,salt,hash,SCHEME,setup ? ':bootstrap:' : digest,now,...(setup ? [] : [digest,Date.now()]));
  const finish = setup ? db.prepare('INSERT OR IGNORE INTO admin_setup(singleton,admin,created) SELECT 1,id,? FROM accounts WHERE id=?').bind(now,id) :
    db.prepare('DELETE FROM account_invites WHERE digest=? AND EXISTS(SELECT 1 FROM accounts WHERE id=? AND invite=?)').bind(digest,id,digest);
  const [created] = await db.batch([insert,finish]);
  return created.meta.changes ? json(201,{status}) : reject();
}

async function login(request,env,now) {
  const fields = userFields(await jsonBody(request));
  if (!fields) return authError(400,'invalid_request');
  const db = env.DB;
  if (!await entryAllowed(request,db,'login',fields.username,now)) return authError(429,'rate_limited');
  const row = await db.prepare('SELECT * FROM accounts WHERE username=?').bind(fields.username).first();
  const digest = await passwordDigest(fields.password,row?.salt || DUMMY_SALT);
  if (!equalDigest(digest,row?.password_hash || '0'.repeat(64)) || row?.password_scheme !== SCHEME) return authError(401,'invalid_credentials');
  if (!['approved','pending'].includes(row.status)) return accessError(row);
  const raw = secret(), expires = now + 7*DAY;
  const [, issued] = await db.batch([
    db.prepare('DELETE FROM account_sessions WHERE digest IN (SELECT digest FROM account_sessions WHERE expires<=? LIMIT 32)').bind(now),
    db.prepare(`INSERT INTO account_sessions(digest,account,expires) SELECT ?,id,? FROM accounts
      WHERE id=? AND revision=? AND status IN ('approved','pending')
      AND (SELECT count(*) FROM account_sessions WHERE account=? AND expires>?)<32`)
      .bind(await fingerprint(raw),expires,row.id,row.revision,row.id,now)
  ]);
  if (!issued.meta.changes) return authError(429,'session_unavailable');
  return json(200,{token:raw,expiresAt:seconds(expires),account:profile(row)});
}

async function logout(env, actor) {
  // Expire immediately to prevent message draining after logout or suspension.
  const roomScope = 'closed=0 AND (host_session=? OR viewer_session=?)';
  await env.DB.batch([
    env.DB.prepare('DELETE FROM account_sessions WHERE digest=?').bind(actor.digest),
    env.DB.prepare('UPDATE rooms SET closed=1,expires=0 WHERE '+roomScope).bind(actor.digest,actor.digest)
  ]);
  await closeSessionRelay(env,actor.digest);
  return empty();
}

async function invite(env,now) {
  const db = env.DB, expires = now + DAY;
  await db.prepare('DELETE FROM account_invites WHERE expires<=?').bind(now).run();
  for (let attempt = 0; attempt < 3; attempt++) {
    // A 32-character alphabet gives each symbol exactly five random bits.
    const raw = Array.from(crypto.getRandomValues(new Uint8Array(8)), byte => INVITE_ALPHABET[byte & 31]).join('');
    const digest = await fingerprint(raw);
    const result = await db.prepare(`INSERT OR IGNORE INTO account_invites(digest,expires)
      SELECT ?,? WHERE (SELECT count(*) FROM account_invites)<256 AND NOT EXISTS(SELECT 1 FROM accounts WHERE invite=?)`)
      .bind(digest,expires,digest).run();
    if (result.meta.changes) return json(201,{invite:raw.slice(0,4)+'-'+raw.slice(4),expiresAt:seconds(expires)});
    if ((await db.prepare('SELECT count(*) AS total FROM account_invites').first()).total >= 256) {
      return authError(429,'invite_limit');
    }
  }
  return authError(503,'invite_unavailable');
}

async function listAccounts(url,env,now) {
  const cursor = url.searchParams.get('cursor') || '';
  const status = url.searchParams.get('status') || '';
  if ((cursor && !UUID.test(cursor)) || (status && !['pending','approved','suspended','revoked'].includes(status))) {
    return authError(400,'invalid_request');
  }
  const { periodStart } = periodAt(now,env.CC_TURN_BILLING_DAY);
  const {results} = await env.DB.prepare(`SELECT a.id,a.username,a.role,a.status,a.created,
    q.limit_bytes AS budget,m.high_egress AS used,m.checked
    FROM accounts a LEFT JOIN relay_quotas q ON q.scope=a.id
    LEFT JOIN relay_meters m ON m.scope=a.id AND m.period_start=?
    WHERE a.id>? AND (?='' OR a.status=?) ORDER BY a.id LIMIT 51`).bind(periodStart,cursor,status,status).all();
  const accounts = results.slice(0,50).map(row=>({
    ...profile(row),relayBudgetBytes:row.budget ?? 0,relayUsedBytes:row.used ?? null,relayCheckedAt:row.checked ?? null
  }));
  return json(200,{accounts,nextCursor:results.length>50 ? accounts[49].id : null});
}

async function manageAccount(request,env,id,sessionsOnly) {
  const db = env.DB;
  const account = await db.prepare('SELECT id,username,role,status,created FROM accounts WHERE id=?').bind(id).first();
  if (!account) return authError(404,'account_not_found');
  let status;
  if (!sessionsOnly) {
    status = (await jsonBody(request))?.status;
    if (!['approved','suspended','revoked'].includes(status)) return authError(400,'invalid_request');
    if (account.role === 'admin') return authError(403,'admin_protected');
    if (account.status === 'revoked') return authError(409,'account_revoked');
  }
  const tasks = [sessionsOnly ? db.prepare('UPDATE accounts SET revision=revision+1 WHERE id=?').bind(id) :
    db.prepare("UPDATE accounts SET status=?, revision=revision+1 WHERE id=? AND role='member' AND status!='revoked'").bind(status,id)];
  if (sessionsOnly || status !== 'approved') {
    tasks.push(db.prepare('DELETE FROM account_sessions WHERE account=?').bind(id),
      db.prepare('UPDATE rooms SET closed=1,expires=0 WHERE host_account=? OR viewer_account=?').bind(id,id));
  }
  const [updated] = await db.batch(tasks);
  if (!updated.meta.changes) return authError(409,'account_revoked');
  if (sessionsOnly || status !== 'approved') await revokeAccountRelay(env,id);
  return sessionsOnly ? empty() : json(200,{account:profile({...account,status})});
}

export async function accountRoutes(request,env) {
  const url = new URL(request.url), path = url.pathname;
  if (!path.startsWith('/v1/auth/') && !path.startsWith('/v1/admin/')) return null;
  const origin = request.headers.get('origin');
  if (origin && origin !== url.origin) return authError(403,'origin_denied');
  const now = Date.now();
  if (request.method === 'POST') {
    if (path === '/v1/auth/login') return login(request,env,now);
    if (path === '/v1/auth/register' || path === '/v1/auth/bootstrap') return createAccount(request,env,path.split('/').pop(),now);
  }
  const actor = await authenticate(env.DB,authorization(request),now);
  if (!actor) return authError(401,'account_required');
  if (path === '/v1/auth/logout' && request.method === 'POST') return logout(env,actor);
  if (path === '/v1/auth/me' && request.method === 'GET') return json(200,{account:profile(actor),expiresAt:seconds(actor.expires)});
  const denied = accessError(actor);
  if (denied) return denied;
  if (!path.startsWith('/v1/admin/')) return authError(404,'not_found');
  if (actor.role !== 'admin') return authError(403,'admin_required');
  if (path === '/v1/admin/accounts' && request.method === 'GET') return listAccounts(url,env,now);
  if (path === '/v1/admin/invites' && request.method === 'POST') return invite(env,now);
  const target = /^\/v1\/admin\/accounts\/([^/]+)(\/revoke-sessions)?$/.exec(path);
  if (target && UUID.test(target[1])) {
    const sessionsOnly = !!target[2];
    if (request.method === (sessionsOnly ? 'POST' : 'PATCH')) return manageAccount(request,env,target[1],sessionsOnly);
  }
  return await usageAdmin(request,env,actor) || authError(404,'not_found');
}
