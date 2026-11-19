import assert from 'node:assert/strict';
import { test } from 'node:test';
import worker from '../worker/index.js';
import { approvedSession, database, fixture, sha, token } from './fixture.js';

const endpoint = (env, alias, method, session, manager, body) => {
  const url = 'https://example.test/v1/devices/' + alias + (method === 'POST' ? '/publish' : '');
  const headers = { 'content-type':'application/json', ...(session && {'x-cc-session':session}),
    ...(manager && {authorization:'Bearer ' + manager}) };
  return worker.fetch(new Request(url,{method,headers,body:body && JSON.stringify(body)}),env);
};
async function setup(t) {
  const env = database(t);
  const room = fixture(env);
  assert.equal((await room.send('host','POST')).status,201);
  const alias = token(), manager = token(), envelope = token();
  const {host,viewer} = room.members;
  const body = {room:room.id,hostToken:room.hostToken,envelope};
  return {env,room,alias,manager,envelope,host,viewer,body,
    publish:(data = body, key = manager, actor = host.session) => endpoint(env,alias,'POST',actor,key,data),
    read:(actor = viewer.session) => endpoint(env,alias,'GET',actor),
    retire:(key = manager,actor = host.session) => endpoint(env,alias,'DELETE',actor,key)};
}

test('device lookup returns only its encrypted envelope and never claims a room or issues a relay grant', async t => {
  const {env,room,manager,envelope,body,publish,read} = await setup(t);
  assert.equal((await read()).status,404);
  assert.equal((await publish()).status,201);
  assert.equal((await publish()).status,200);
  assert.equal((await publish({...body,envelope:token()})).status,409);
  for (let i = 0; i < 2; i++) {
    const response = await read();
    assert.equal(response.status,200);
    assert.equal(response.headers.get('cache-control'),'no-store');
    assert.deepEqual(await response.json(),{envelope});
  }
  assert.equal(env.handle.prepare('SELECT viewer FROM rooms').get().viewer,null);
  for (const table of ['turn_grants','relay_leases','messages']) {
    assert.equal(env.handle.prepare('SELECT count(*) AS n FROM '+table).get().n,0);
  }
  const binding = env.handle.prepare('SELECT * FROM device_aliases').get();
  assert.equal(binding.manager_digest,sha(manager));
  for (const secret of [manager,room.hostToken,room.proof,room.members.host.session]) {
    assert(!Object.values(binding).includes(secret));
  }
  assert.equal((await room.send('viewer','POST')).status,201);
  assert.equal((await read()).status,404);
  assert.equal((await publish()).status,200, 'retry after a lost publication acknowledgement');
});

test('a management credential, the authorized owner and the actual waiting host are each required', async t => {
  const {env,room,alias,host,viewer,body,manager,publish,retire} = await setup(t);
  const differentSession = token();
  env.handle.prepare('INSERT INTO account_sessions(digest,account,expires) VALUES(?,?,?)')
    .run(sha(differentSession),host.id,Date.now()+60000);
  for (const invalid of [
    publish({...body,hostToken:token()}),publish(body,manager,differentSession),publish(body,manager,viewer.session)
  ]) assert.equal((await invalid).status,403);
  assert.equal(env.handle.prepare('SELECT count(*) AS n FROM device_aliases').get().n,0);
  assert.equal((await publish()).status,201);
  assert.equal((await publish(body,token())).status,403);
  assert.equal((await retire(token())).status,403);
  assert.equal((await retire(manager,viewer.session)).status,403);
  assert.equal((await endpoint(env,token(),'POST',host.session,manager,body)).status,409, 'one room may have one locator');
  assert.equal((await endpoint(env,alias,'DELETE',host.session)).status,401);
  assert.equal(env.handle.prepare('SELECT closed FROM rooms WHERE id=?').get(room.id).closed,0);
  assert.equal((await retire(manager,differentSession)).status,204, 'the same owner can rotate after signing back in');
});

test('rebinding a live alias is exclusive and cannot disturb an existing session', async t => {
  const {env,room,body,publish,read,retire} = await setup(t);
  const second = fixture(env,room.members);
  await second.send('host','POST');
  const next = {room:second.id,hostToken:second.hostToken,envelope:token()};
  env.handle.prepare('UPDATE rooms SET created=created-1000 WHERE id=?').run(room.id);
  await publish(body);
  await room.send('viewer','POST');
  const conflicts = await Promise.all([retire(),publish(next)]);
  assert.deepEqual(conflicts.map(r=>r.status),[409,409]);
  assert.equal(env.handle.prepare('SELECT closed FROM rooms WHERE id=?').get(room.id).closed,0);
  assert.equal((await read()).status,404);
  await room.send('host','DELETE');
  assert.equal((await publish(next)).status,200);
  assert.equal((await publish(body)).status,409);
  await room.send('host','DELETE');
  assert.deepEqual(await (await read()).json(),{envelope:next.envelope});
});

test('a restart atomically replaces an unclaimed older room even if the old host lost its DELETE', async t => {
  const {env,room,body,publish,read} = await setup(t);
  const delayed = fixture(env,room.members), newer = fixture(env,room.members);
  await delayed.send('host','POST'); await newer.send('host','POST');
  const oldest = Date.now()-3000;
  const created = env.handle.prepare('UPDATE rooms SET created=? WHERE id=?');
  created.run(oldest,delayed.id); created.run(oldest+1000,room.id); created.run(oldest+2000,newer.id);
  const next = {room:newer.id,hostToken:newer.hostToken,envelope:token()};
  const late = {room:delayed.id,hostToken:delayed.hostToken,envelope:token()};
  await publish(body);
  assert.equal((await publish(late)).status,409);
  assert.equal((await publish(next)).status,200);
  assert.equal((await room.send('viewer','POST')).status,410);
  assert.deepEqual(await (await read()).json(),{envelope:next.envelope});
  assert.equal((await publish(body)).status,409);
  await newer.send('host','DELETE');
  env.handle.prepare('DELETE FROM rooms WHERE id=?').run(newer.id);
  // The delayed room still has a valid host bearer and no viewer. The
  // watermark prevents it from reviving the superseded invitation.
  assert.equal((await publish(late)).status,409);
  assert.equal((await read()).status,404);
});

test('two installations racing for an unbound locator cannot both become its owner', async t => {
  const {env,alias,host,body,publish} = await setup(t);
  const second = fixture(env,{host,viewer:approvedSession(env)});
  await second.send('host','POST');
  const other = {room:second.id,hostToken:second.hostToken,envelope:token()};
  const results = await Promise.all([publish(body),endpoint(env,alias,'POST',host.session,token(),other)]);
  assert.deepEqual(results.map(r=>r.status).sort(),[201,403]);
});

test('a renewed room restricts alias lookup and enrollment to the authenticated viewer account', async t => {
  const {env,room,viewer,host,publish,read} = await setup(t);
  const other = approvedSession(env);
  const restarted = fixture(env,room.members);
  const headers = {'x-cc-sharing':'continuous-v1','x-cc-viewer-account':viewer.id};
  const register = h => restarted.send('host','POST',undefined,undefined,null,undefined,host.session,h);
  assert.equal((await register({...headers,'x-cc-viewer-account':''})).status,400);
  const created = await register(headers);
  assert.equal(created.status,201);
  assert.equal(created.headers.get('x-cc-sharing'),'continuous-v1');
  assert.equal((await register(headers)).status,200);
  assert.equal((await register({'x-cc-sharing':'continuous-v1'})).status,409,'an existing room cannot be widened');
  assert.equal((await publish({room:restarted.id,hostToken:restarted.hostToken,envelope:token()})).status,201);
  assert.equal((await read(other.session)).status,404);
  assert.equal((await read(viewer.session)).status,200);
  const claim = (session,h) => restarted.send('viewer','POST',undefined,undefined,null,undefined,session,h);
  // Even a copied decrypted envelope and a forged account header cannot join.
  assert.equal((await claim(other.session,headers)).status,404);
  const freshLogin = token();
  env.handle.prepare('INSERT INTO account_sessions(digest,account,expires) VALUES(?,?,?)')
    .run(sha(freshLogin),viewer.id,Date.now()+60000);
  assert.equal((await claim(freshLogin)).status,201);
  assert.equal((await claim(other.session)).status,404);
  const bytes = new Uint8Array(100);
  assert.equal((await restarted.send('viewer','PUT',1,undefined,bytes,undefined,freshLogin,
    {'x-cc-viewer-account':other.id})).status,204);
  const peer = await restarted.send('host','GET',1);
  assert.equal(peer.status,200);
  assert.equal(peer.headers.get('x-cc-viewer-account'),viewer.id);
  const intruder = await restarted.send('host','GET',1,undefined,null,undefined,other.session);
  assert.equal(intruder.headers.get('x-cc-viewer-account'),null);
  assert.equal(intruder.status,410);
});

test('rotation closes an unclaimed room, releases its envelope and permanently retires the locator', async t => {
  const {env,room,alias,host,body,manager,publish,read,retire} = await setup(t);
  await publish();
  const old = await read();
  assert.equal(old.status,200);
  assert.equal((await retire()).status,204);
  assert.equal((await retire()).status,204);
  assert.equal((await room.send('viewer','POST')).status,410, 'previously resolved envelope cannot join after rotation');
  assert.equal((await publish()).status,410);
  assert.equal((await read()).status,404);
  const row = env.handle.prepare('SELECT room,envelope,retired FROM device_aliases WHERE alias=?').get(alias);
  assert.equal(row.room,null); assert.equal(row.envelope,null); assert.equal(row.retired,1);
  const unused = token();
  assert.equal((await endpoint(env,unused,'DELETE',host.session,manager)).status,204);
  assert.equal((await endpoint(env,unused,'POST',host.session,manager,body)).status,410);
});

test('expired or revoked host rooms become unresolvable without any client cleanup', async t => {
  const {env,room,host,viewer,alias,manager,publish,read} = await setup(t);
  env.handle.prepare('UPDATE rooms SET created=created-1000 WHERE id=?').run(room.id);
  await publish();
  env.handle.prepare('UPDATE rooms SET expires=0 WHERE id=?').run(room.id);
  assert.equal((await read()).status,404);
  const second = fixture(env,room.members);
  await second.send('host','POST');
  assert.equal(env.handle.prepare('SELECT room FROM device_aliases WHERE alias=?').get(alias).room,null);
  assert.equal((await publish({room:second.id,hostToken:second.hostToken,envelope:token()})).status,200);
  env.handle.prepare("UPDATE accounts SET status='suspended' WHERE id=?").run(host.id);
  assert.equal((await read()).status,404);
  assert.equal((await endpoint(env,alias,'DELETE',host.session,manager)).status,403);
  env.handle.prepare("UPDATE accounts SET status='pending' WHERE id=?").run(viewer.id);
  assert.equal((await read()).status,403);
  assert.equal((await read('')).status,401);
});

test('locator requests reject oversized ciphertext and enforce the same read limit for missing and live aliases', async t => {
  const {env,alias,body,host,viewer,manager,publish} = await setup(t);
  for (const input of [{...body,envelope:'RD1.'+token()},{...body,envelope:'a'.repeat(9000)},
    {...body,hostToken:manager},{...body,room:alias},{...body,hostToken:host.session}]) {
    assert.equal((await publish(input)).status,400);
  }
  await publish();
  for (let i = 0; i < 30; i++) {
    const exists = i % 2 === 0;
    assert.equal((await endpoint(env,exists ? alias : token(),'GET',viewer.session)).status,exists ? 200 : 404);
  }
  assert.equal((await endpoint(env,alias,'GET',viewer.session)).status,429);
  const spareAccount = approvedSession(env);
  assert.equal((await endpoint(env,alias,'GET',spareAccount.session)).status,200);
});
