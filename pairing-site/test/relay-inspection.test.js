import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../worker/index.js';
import { database, fixture, token } from './fixture.js';

test('only a live, authenticated room can schedule an inspection, with one shared D1 lease for the pollers and cron',async t=>{
  const env=database(t), {id,send,hostToken,viewerToken,members}=fixture(env);
  assert.equal((await send('host','POST')).status,201);
  assert.equal((await send('viewer','POST')).status,201);
  const pending=[];
  const ctx={waitUntil(task){pending.push(task);}};
  const poll=(role,bearer,session)=>worker.fetch(new Request('https://pair.example/v1/rooms/'+id+'/'+role+'/messages/1',{
    headers:{authorization:'Bearer '+bearer,'x-cc-session':session}
  }),env,ctx);
  const expired=id=>env.handle.prepare("INSERT INTO relay_leases(id,room,role,account,key_id,created,expires,state) VALUES(?,?,?,?,?,?,?,?)")
    .run(id,'old','host',members.host.id,'test',0,1,'revoked');
  expired('before');
  assert.equal((await poll('host',hostToken,token())).status,401);
  assert.equal((await poll('host',token(),members.host.session)).status,410);
  assert.equal(pending.length,0);
  const replies=await Promise.all([poll('host',hostToken,members.host.session),poll('viewer',viewerToken,members.viewer.session)]);
  assert.deepEqual(replies.map(r=>r.status),[204,204]);
  await Promise.all(pending.splice(0));
  assert.equal(env.handle.prepare('SELECT count(*) AS n FROM relay_leases').get().n,0);
  expired('after');
  await poll('viewer',viewerToken,members.viewer.session);
  assert.equal(pending.length,0);
  worker.scheduled({},env,ctx);await Promise.all(pending.splice(0));
  assert.equal(env.handle.prepare('SELECT count(*) AS n FROM relay_leases').get().n,1);
  env.handle.prepare("UPDATE auth_rate SET expires=0 WHERE bucket='relay-inspection'").run();
  env.handle.prepare('UPDATE rooms SET closed=1 WHERE id=?').run(id);
  assert.equal((await poll('host',hostToken,members.host.session)).status,410);
  assert.equal(pending.length,0);
  worker.scheduled({},env,ctx);await Promise.all(pending);
  assert.equal(env.handle.prepare('SELECT count(*) AS n FROM relay_leases').get().n,0);
});
