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

test('viewer guesses share an account limit across rooms, valid invitations and network changes', async t => {
  t.mock.timers.enable({apis:['Date'], now:Date.now()});
  const db = database(t), room = fixture(db);
  assert.equal((await room.send('host','POST')).status,201);
  const address = ip => new Request('https://example.test/v1/rooms/' + room.id + '/viewer', {
    method:'POST', headers:{authorization:'Bearer ' + room.viewerToken, 'x-cc-session':room.members.viewer.session,
      'x-viewer-proof':room.proof, 'cf-connecting-ip':ip}
  });
  const missing = fixture(db,room.members);
  const misses = await Promise.all(Array.from({length:15}, () => missing.send('viewer','POST')));
  assert(misses.every(response => response.status === 404));
  assert.equal((await worker.fetch(address('198.51.100.9'),db)).status,429);
  t.mock.timers.tick(60_000);
  assert.equal((await worker.fetch(address('198.51.100.9'),db)).status,201);
});

test('viewer lookup limits also cover multiple approved accounts on one source address', async t => {
  t.mock.timers.enable({apis:['Date'], now:Date.now()});
  const db = database(t);
  for (let account = 0; account < 6; account++) {
    const missing = fixture(db);
    for (let attempt = 0; attempt < 15; attempt++) assert.equal((await missing.send('viewer','POST')).status,404);
  }
  const valid = fixture(db);
  assert.equal((await valid.send('host','POST')).status,201);
  assert.equal((await valid.send('viewer','POST')).status,429);
});

test('an authenticated invitation distinguishes early closure, prior use and expiry', async t => {
  const db = database(t);
  const closed = fixture(db);
  await closed.send('host','POST');
  await closed.send('host','DELETE');
  const early = await closed.send('viewer','POST');
  assert.equal(early.status, 410);
  assert.equal(early.headers.get('x-cc-invite-state'), 'closed');
  const invalidProof = await closed.send('viewer','POST',null,token(),null,token());
  assert.equal(invalidProof.status, 403);
  assert.equal(invalidProof.headers.get('x-cc-invite-state'), null);

  const used = fixture(db);
  await used.send('host','POST');
  await used.send('viewer','POST');
  await used.send('viewer','DELETE');
  assert.equal((await used.send('viewer','POST')).headers.get('x-cc-invite-state'), 'used');

  const expired = fixture(db);
  await expired.send('host','POST');
  db.handle.prepare('UPDATE rooms SET expires=0 WHERE id=?').run(expired.id);
  assert.equal((await expired.send('viewer','POST')).headers.get('x-cc-invite-state'), 'expired');
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

test('next pull acknowledges only previously served packets and keeps duplicate writes idempotent', async t => {
  const db=database(t), r=fixture(db), packet=randomBytes(160), other=randomBytes(160);
  await r.send('host','POST');await r.send('viewer','POST');
  await r.send('host','PUT',1,undefined,packet);
  // A speculative read ahead must not destroy a packet that was never delivered.
  assert.equal((await r.send('viewer','GET',2)).status,204);
  assert.deepEqual(Buffer.from(await (await r.send('viewer','GET',1)).arrayBuffer()),packet);
  assert.deepEqual(Buffer.from(await (await r.send('viewer','GET',1)).arrayBuffer()),packet);
  assert.equal((await r.send('viewer','GET',2,r.hostToken)).status,410);
  assert.equal(db.handle.prepare('SELECT size FROM messages WHERE room=? AND sender=? AND seq=1').get(r.id,'host').size,packet.length);
  await r.send('viewer','GET',2);
  assert.equal(db.handle.prepare('SELECT length(bytes) AS n FROM messages WHERE room=? AND sender=? AND seq=1').get(r.id,'host').n,0);
  assert.equal((await r.send('viewer','GET',1)).status,410);
  const retry = await Promise.all([
    r.send('host','PUT',1,undefined,packet), r.send('host','PUT',1,undefined,other),
    r.send('host','PUT',2,undefined,other), r.send('host','PUT',2,undefined,other)
  ]);
  assert.deepEqual(retry.map(resp=>resp.status),[204,409,204,204]);
  assert.deepEqual(Buffer.from(await (await r.send('viewer','GET',2)).arrayBuffer()),other);
});

test('long bidirectional sessions reclaim delivered ciphertext across large cumulative byte and sequence counts', async t => {
  const db=database(t),r=fixture(db), packet=randomBytes(4096);
  await r.send('host','POST');await r.send('viewer','POST');
  db.handle.prepare('UPDATE rooms SET created=? WHERE id=?').run(Date.now()-10*3600000,r.id);
  for (let seq=1;seq<=1200;seq++) {
    for (const role of ['host','viewer']) {
      assert.equal((await r.send(role,'PUT',seq,undefined,packet)).status,204);
      const response=await r.send(role==='host'?'viewer':'host','GET',seq);
      assert.equal(response.status,200);assert.equal((await response.arrayBuffer()).byteLength,packet.length);
    }
  }
  await r.send('host','GET',1201);await r.send('viewer','GET',1201);
  const totals=db.handle.prepare('SELECT sender,count(*) AS receipts,sum(length(bytes)) AS live FROM messages GROUP BY sender').all();
  assert(totals.every(row=>row.live===0 && row.receipts===1200));
  assert.equal((await r.send('host','PUT',17,undefined,packet)).status,204);
});

test('limits unacknowledged data, write rate and absolute work without allowing out-of-order or duplicate admission', async t => {
  const db=database(t),r=fixture(db), packet=randomBytes(80);
  await r.send('host','POST');await r.send('viewer','POST');
  db.handle.prepare('UPDATE rooms SET created=? WHERE id=?').run(Date.now()-5*3600000,r.id);
  for (let seq=1;seq<=512;seq++) assert.equal((await r.send('host','PUT',seq,undefined,packet)).status,204);
  assert.equal((await r.send('host','PUT',513,undefined,packet)).status,409);
  await r.send('viewer','GET',1);await r.send('viewer','GET',2);
  assert.equal((await r.send('host','PUT',513,undefined,packet)).status,204);
  db.handle.prepare('UPDATE rooms SET created=? WHERE id=?').run(Date.now(),r.id);
  assert.equal((await r.send('host','PUT',514,undefined,packet)).status,429);
  const large=randomBytes(160*1024);
  for (let i=1;i<=12;i++) assert.equal((await r.send('viewer','PUT',i,undefined,large)).status,204);
  assert.equal((await r.send('viewer','PUT',13,undefined,large)).status,409);
  await r.send('host','GET',1);await r.send('host','GET',2);
  assert.equal((await r.send('viewer','PUT',13,undefined,large)).status,204);
  assert.equal((await r.send('viewer','PUT',16385,undefined,packet)).status,429);
  assert.equal((await r.send('viewer','GET',16385)).status,204);
});
