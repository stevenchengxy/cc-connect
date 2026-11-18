import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash, createHmac, randomBytes } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import worker from '../worker/index.js';

function database(t) {
  const sql = new DatabaseSync(':memory:');
  const dir = new URL('../drizzle/', import.meta.url);
  sql.exec('PRAGMA foreign_keys=ON');
  for (const file of readdirSync(dir).filter(f => f.endsWith('.sql')).sort()) sql.exec(readFileSync(new URL(file,dir),'utf8'));
  t.after(() => sql.close());
  const statement = (text, values = []) => ({
    bind(...args) { return statement(text, args.map(v => v instanceof ArrayBuffer ? new Uint8Array(v) : v)); },
    first() { return sql.prepare(text).get(...values) || null; },
    run() { return { meta: sql.prepare(text).run(...values) }; }
  });
  return { handle: sql, DB: { prepare: statement, batch(stmts) {
    sql.exec('BEGIN');
    try { const rows = stmts.map(s => s.run()); sql.exec('COMMIT'); return rows; }
    catch (error) { sql.exec('ROLLBACK'); throw error; }
  } } };
}
const token = () => randomBytes(32).toString('base64url');
const sha = s => createHash('sha256').update(s).digest('hex');
function fixture(db) {
  const id = token(), proof = token(), hostToken = token(), viewerToken = token();
  const send = (role, method, seq, bearer = role === 'host' ? hostToken : viewerToken, body = null, enrollment = role === 'host' ? sha(proof) : proof) => worker.fetch(new Request(
    `https://example.test/v1/rooms/${id}/${role}` + (seq ? `/messages/${seq}` : ''),
    {method, headers: {authorization:`Bearer ${bearer}`,'x-viewer-proof':enrollment,'content-type':'application/octet-stream'}, body}
  ), db);
  return { id, send, hostToken, viewerToken, proof };
}

test('room enrollment requires invitation proof and concurrent readers cannot take a role', async t => {
  const db = database(t);
  const { send } = fixture(db);
  assert.equal((await send('viewer','POST')).status,404);
  assert.equal((await send('host','POST')).status,201);
  assert.equal((await send('host','POST')).status,200);
  assert.equal((await send('host','POST',null,token())).status,409);
  assert.equal((await send('viewer','POST',null,token(),null,token())).status,403);
  assert.equal((await send('viewer','POST')).status,201);
  assert.equal((await send('viewer','POST')).status,200);
  assert.equal((await send('viewer','POST',null,token())).status,409);
  assert.equal((await send('viewer','GET',1,token())).status,410);
});

test('encrypted packets preserve order and idempotency, drain before closing, then expire', async t => {
  const db = database(t);
  const { send,id } = fixture(db);
  const packet = randomBytes(64);
  await send('host','POST'); await send('viewer','POST');
  assert.equal((await send('host','PUT',2,undefined,packet)).status,409);
  assert.equal((await send('host','PUT',1,undefined,packet)).status,204);
  assert.equal((await send('host','PUT',1,undefined,packet)).status,204);
  assert.equal((await send('host','PUT',1,undefined,randomBytes(64))).status,409);
  assert.equal((await send('viewer','GET',2)).status,204);
  assert.equal((await send('host','GET',1)).status,204);
  assert.equal((await send('viewer','PUT',1,undefined,randomBytes(200*1024))).status,413);
  assert.equal((await send('host','DELETE')).status,204);
  assert.deepEqual(Buffer.from(await (await send('viewer','GET',1)).arrayBuffer()),packet);
  assert.equal((await send('viewer','GET',2)).status,410);
  db.handle.prepare('UPDATE rooms SET expires=0 WHERE id=?').run(id);
  assert.equal((await send('viewer','GET',1)).status,410);
  await fixture(db).send('host','POST');
  assert.equal(db.handle.prepare('SELECT count(*) AS n FROM messages').get().n,0);
});

test('host admission enforces the per-source limit with repeatable retries', async t => {
  const db = database(t);
  for (let i=0;i<12;i++) assert.equal((await fixture(db).send('host','POST')).status,201);
  assert.equal((await fixture(db).send('host','POST')).status,429);
});

test('only enrolled members receive bounded coturn REST credentials', async t => {
  const db = database(t);
  const { id, send, hostToken, viewerToken } = fixture(db);
  const ice = (role, bearer, room = id) => worker.fetch(new Request(`https://example.test/v1/rooms/${room}/${role}/ice`, {headers:{authorization:'Bearer '+bearer}}), db);
  await send('host','POST');
  assert.equal((await ice('host',hostToken)).status,403);
  await send('viewer','POST');
  assert.equal((await ice('viewer',hostToken)).status,403);
  assert.equal((await ice('host',hostToken,token())).status,403);
  assert.equal((await ice('viewer',viewerToken)).status,204);
  db.CC_TURN_SECRET = token();
  db.CC_TURN_URLS = JSON.stringify(['turn:relay.example.net:3478?transport=udp','turns:relay.example.net:443?transport=tcp']);
  const {iceServers, expiresAt} = await (await ice('viewer',viewerToken)).json();
  const {urls,username,credential} = iceServers[0];
  assert.ok(expiresAt > Date.now() && expiresAt <= Date.now() + 3_600_000);
  assert.equal(Number(username.split(':')[0]),expiresAt/1000);
  assert.deepEqual(urls, JSON.parse(db.CC_TURN_URLS));
  assert.equal(credential, createHmac('sha1',db.CC_TURN_SECRET).update(username).digest('base64'));
  assert.ok(!(await (await ice('host',hostToken)).text()).includes(db.CC_TURN_SECRET));
  db.CC_TURN_URLS = '["https://not-a-turn.example/"]';
  assert.equal((await ice('viewer',viewerToken)).status,503);
  db.handle.prepare('UPDATE rooms SET expires=0 WHERE id=?').run(id);
  assert.equal((await ice('viewer',viewerToken)).status,403);
});
