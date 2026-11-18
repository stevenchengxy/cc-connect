import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomBytes } from 'node:crypto';
import worker from '../worker/index.js';
import { database, fixture, sha, token } from './fixture.js';

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

test('legacy role bearer and a different signed-in account cannot retrieve ICE or exchange messages', async t => {
  const env = database(t), room = fixture(env);
  const ice = (role, bearer, session) => worker.fetch(new Request(`https://example.test/v1/rooms/${room.id}/${role}/ice`,
    {headers:{authorization:'Bearer '+bearer,...(session ? {'x-cc-session':session} : {})}}),env);
  const host = room.members.host.session, viewer = room.members.viewer.session;
  assert.equal((await room.send('host','POST',null,room.hostToken,null,sha(room.proof),'')).status,401);
  assert.equal((await room.send('host','POST')).status,201);
  assert.equal((await ice('host',room.hostToken,host)).status,403);
  assert.equal((await room.send('viewer','POST')).status,201);
  assert.equal((await ice('host',room.hostToken)).status,401);
  assert.equal((await ice('host',room.hostToken,viewer)).status,403);
  assert.equal((await ice('viewer',room.hostToken,viewer)).status,403);
  assert.equal((await room.send('host','GET',1,room.hostToken,null,sha(room.proof),viewer)).status,410);
  assert.equal((await room.send('host','POST',null,room.hostToken,null,sha(room.proof),viewer)).status,409);
  env.handle.prepare('UPDATE account_sessions SET expires=0 WHERE digest=?').run(sha(host));
  assert.equal((await room.send('viewer','GET',1)).status,410);
  assert.equal((await ice('viewer',room.viewerToken,viewer)).status,403);
});

test('pre-upgrade rooms cannot be claimed with a new account or used for TURN', async t => {
  const env = database(t), room = fixture(env), now = Date.now();
  env.handle.prepare("INSERT INTO rooms(id,host,viewer,enrollment,source,created,expires) VALUES(?,?,?,?,?,?,?)")
    .run(room.id,sha(room.hostToken),sha(room.viewerToken),sha(room.proof),'legacy',now,now+60_000);
  assert.equal((await room.send('host','POST')).status,410);
  assert.equal((await room.send('viewer','POST')).status,404);
  assert.equal((await room.send('host','GET',1)).status,410);
  const ice = await worker.fetch(new Request(`https://example.test/v1/rooms/${room.id}/host/ice`,{
    headers:{authorization:'Bearer '+room.hostToken,'x-cc-session':room.members.host.session}
  }),env);
  assert.equal(ice.status,403);
});
