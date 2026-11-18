import assert from 'node:assert/strict';
import { test } from 'node:test';
import worker from '../worker/index.js';
import { approvedSession, database, fixture, sha, token } from './fixture.js';

function api(env) {
  return (method,path,data,session,extra={}) => worker.fetch(new Request('https://example.test/v1/'+path,{
    method,headers:{'Content-Type':'application/json',...(session ? {authorization:'Bearer '+session} : {}),...extra},
    body:data === undefined ? undefined : JSON.stringify(data)
  }),env);
}

async function setup(t) {
  const env = database(t), call = api(env), bootstrap = token();
  env.CC_ADMIN_BOOTSTRAP_SHA256 = sha(bootstrap);
  const admin = {username:'Supervisor',password:token()};
  assert.equal((await call('POST','auth/bootstrap',{...admin,bootstrap})).status,201);
  const result = await (await call('POST','auth/login',admin)).json();
  return {env,call,bootstrap,admin,result};
}

test('bootstrap is preprovisioned, once-only, generic on failure, with no client-supplied role', async t => {
  const env = database(t), call = api(env), bootstrap = token(), user = {username:'Owner',password:token(),bootstrap};
  assert.equal((await call('POST','auth/bootstrap',user)).status,403);
  env.CC_ADMIN_BOOTSTRAP_SHA256 = sha(bootstrap);
  const created = await Promise.all([call('POST','auth/bootstrap',user), call('POST','auth/bootstrap',{...user,username:'OtherOwner'})]);
  assert.deepEqual(created.map(r=>r.status).sort(),[201,403]);
  env.CC_ADMIN_BOOTSTRAP_SHA256=sha(token());
  assert.equal((await call('POST','auth/bootstrap',user)).status,403);
  assert.equal(env.handle.prepare("SELECT count(*) AS n FROM accounts WHERE role='admin'").get().n,1);
  assert.equal((await call('POST','auth/login',user,undefined,{Origin:'https://external.test'})).status,403);
  const bad = await call('POST','auth/login',{username:'owner',password:'incorrect12345'});
  const unknown = await call('POST','auth/login',{username:'unknown',password:'incorrect12345'});
  assert.equal(bad.status,401); assert.deepEqual(await bad.json(),await unknown.json());
});

test('single-use invites require approval, revocation closes both roles and prevents reactivation', async t => {
  const {env,call,result} = await setup(t), admin = result.token;
  const {invite,expiresAt} = await (await call('POST','admin/invites',undefined,admin)).json();
  assert.ok(expiresAt > Date.now()/1000 && expiresAt < Date.now()/1000+86401);
  const password = token(), request = username => ({username,password,invite,role:'admin',status:'approved'});
  const registrations = await Promise.all([call('POST','auth/register',request('Member.A')),call('POST','auth/register',request('Member.B'))]);
  assert.deepEqual(registrations.map(r=>r.status).sort(),[201,403]);
  const username = registrations[0].status===201 ? 'Member.A' : 'Member.B';
  const login = await (await call('POST','auth/login',{username,password})).json();
  assert.equal(login.account.role,'member'); assert.equal(login.account.status,'pending');
  assert.equal((await call('GET','auth/me',undefined,login.token)).status,200);
  assert.equal((await call('GET','admin/accounts',undefined,login.token)).status,403);
  const room = fixture(env,{host:{id:login.account.id,session:login.token},viewer:approvedSession(env)});
  assert.equal((await room.send('host','POST')).status,403);
  const target='admin/accounts/'+login.account.id;
  assert.equal((await call('PATCH',target,{status:'approved'},admin)).status,200);
  assert.equal((await room.send('host','POST')).status,201);
  assert.equal((await room.send('viewer','POST')).status,201);
  assert.equal((await room.send('viewer','GET',1)).status,204);
  const accounts=await (await call('GET','admin/accounts',undefined,admin)).json();
  assert.ok(accounts.accounts.some(a=>a.id===login.account.id && a.status==='approved'));
  assert.ok(accounts.accounts.every(a=>!('password_hash' in a) && !('salt' in a)));
  assert.equal((await call('PATCH','admin/accounts/'+result.account.id,{status:'revoked'},admin)).status,403);
  assert.equal((await call('PATCH',target,{status:'suspended'},admin)).status,200);
  assert.equal((await room.send('host','GET',1)).status,401);
  assert.equal((await room.send('viewer','GET',1)).status,410);
  const suspended=await call('POST','auth/login',{username,password}); assert.equal(suspended.status,403);
  assert.deepEqual(await suspended.json(),{error:'account_suspended'});
  assert.equal((await call('PATCH',target,{status:'approved'},admin)).status,200);
  const fresh=await (await call('POST','auth/login',{username,password})).json();
  assert.equal((await call('POST',target+'/revoke-sessions',undefined,admin)).status,204);
  assert.equal((await call('GET','auth/me',undefined,fresh.token)).status,401);
  assert.equal((await call('PATCH',target,{status:'revoked'},admin)).status,200);
  assert.equal((await call('PATCH',target,{status:'approved'},admin)).status,409);
  const revoked=await call('POST','auth/login',{username,password}); assert.equal(revoked.status,403);
  assert.deepEqual(await revoked.json(),{error:'account_revoked'});
});

test('logout invalidates an enrolled pair, including peer access to buffered messages', async t => {
  const env = database(t), room=fixture(env), call=api(env);
  assert.equal((await room.send('host','POST')).status,201);
  assert.equal((await room.send('viewer','POST')).status,201);
  const packet=new Uint8Array(100);
  assert.equal((await room.send('host','PUT',1,undefined,packet)).status,204);
  assert.equal((await call('POST','auth/logout',undefined,room.members.host.session)).status,204);
  assert.equal((await room.send('host','GET',1)).status,401);
  assert.equal((await room.send('viewer','GET',1)).status,410);
});

test('throttles invalid login attempts consistently across distributed sources for one username', async t => {
  const env = database(t), call=api(env);
  for (let i=0;i<12;i++) assert.equal((await call('POST','auth/login',{username:'test.user',password:'invalid-password'},undefined,{'CF-Connecting-IP':'192.0.2.'+(i+1)})).status,401);
  const blocked=await call('POST','auth/login',{username:'TEST.USER',password:'invalid-password'},undefined,{'CF-Connecting-IP':'192.0.2.250'});
  assert.equal(blocked.status,429); assert.deepEqual(await blocked.json(),{error:'rate_limited'});
});
