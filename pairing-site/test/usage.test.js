import assert from 'node:assert/strict';
import { test } from 'node:test';
import { database } from './fixture.js';
import { managedIce, usageAdmin, revokeAccountRelay, closeRoomRelay, closeSessionRelay, reconcileRelayUsage } from '../worker/usage.js';
import { accountIdentifier, periodAt, readTurnUsage } from '../worker/usage-provider.js';

function setup(t) {
  const {handle:sql,DB}=database(t);
  const env={DB,CC_CF_ACCOUNT_ID:'a'.repeat(32),CC_CF_TURN_KEY_ID:'b'.repeat(32),
    CC_CF_ANALYTICS_TOKEN:'meter-permission-test-only',CC_CF_TURN_API_TOKEN:'turn-permission-test-only'};
  const admin={id:crypto.randomUUID(),role:'admin',status:'approved'};
  const host=crypto.randomUUID(), viewer=crypto.randomUUID(), room='x'.repeat(43), expires=Date.now()+600000;
  for (const [id,role] of [[admin.id,'admin'],[host,'member'],[viewer,'member']]) {
    sql.prepare('INSERT INTO accounts(id,role,status,username,salt,password_hash,password_scheme,created) VALUES(?,?,?,?,?,?,?,?)')
      .run(id,role,'approved',id,'test','test','test',1);
    sql.prepare('INSERT INTO account_sessions(digest,account,expires) VALUES(?,?,?)').run(id,id,expires);
  }
  function addRoom(id) {
    sql.prepare('INSERT INTO rooms(id,host,enrollment,viewer,source,created,expires,host_account,viewer_account,host_session,viewer_session) VALUES(?,?,?,?,?,?,?,?,?,?,?)')
      .run(id,'h','e','v','s',1,expires,host,viewer,host,viewer);
  }
  addRoom(room);
  const state={global:0,personal:0,records:false,issues:[],revocations:[],queries:[],owner:true,meter:true,revoke:true};
  t.mock.method(globalThis,'fetch',async(url,init)=>{
    assert.equal(init.redirect,'manual');
    if (url==='https://api.cloudflare.com/client/v4/graphql') {
      assert.equal(init.headers.authorization,'Bearer '+env.CC_CF_ANALYTICS_TOKEN);
      const {query}=JSON.parse(init.body);state.queries.push(query);
      if (!state.meter) return Response.json({errors:[{message:'forbidden'}]});
      const egress=query.includes('customIdentifier') ? state.personal:state.global;
      const rows=state.records ? [{sum:{egressBytes:egress,ingressBytes:2}}] : [];
      return Response.json({data:{viewer:{accounts:[{accountTag:env.CC_CF_ACCOUNT_ID,callsTurnUsageAdaptiveGroups:rows}]}}});
    }
    if (url.startsWith('https://api.cloudflare.com/client/v4/accounts/')) {
      assert.equal(init.headers.authorization,'Bearer '+env.CC_CF_ANALYTICS_TOKEN);
      return Response.json({success:true,result:{uid:state.owner ? env.CC_CF_TURN_KEY_ID:'invalid'}});
    }
    assert(url.startsWith('https://rtc.live.cloudflare.com/v1/turn/keys/'+env.CC_CF_TURN_KEY_ID+'/credentials/'));
    assert.equal(init.headers.authorization,'Bearer '+env.CC_CF_TURN_API_TOKEN);
    if (url.endsWith('/revoke')) {
      state.revocations.push(url.split('/').at(-2));
      return new Response(null,{status:state.revoke?204:503});
    }
    assert(url.endsWith('/generate'));
    const data=JSON.parse(init.body);state.issues.push(data);
    const username='credential-'+state.issues.length;
    if (state.onIssue) await state.onIssue();
    return Response.json({iceServers:{urls:['turns:turn.cloudflare.com:443?transport=tcp','turns:untrusted.example:443'],
      username,credential:'ephemeral-test'}},{status:201});
  });
  const grant=(id=host,role='host',roomId=room)=>managedIce(env,{accountId:id,role,roomId,roomExpiresAt:expires});
  const adminRequest=(method,path,data,actor=admin)=>usageAdmin(new Request('https://pair.example/v1/admin/'+path,{
    method,headers:{'content-type':'application/json'},body:data&&JSON.stringify(data)
  }),env,actor);
  const configure=async()=>{
    for (const [id,data] of [['global',{mode:'protected',limitBytes:1000,maxConcurrent:3}],[host,{limitBytes:500,maxConcurrent:1}],[viewer,{limitBytes:500,maxConcurrent:1}]]) {
      assert.equal((await adminRequest('PATCH','quotas/'+id,data)).status,200);
    }
  };
  return {sql,env,state,host,viewer,room,admin,addRoom,grant,configure,adminRequest};
}

test('TURN is off by default and only an approved admin can set positive budgets',async t=>{
  const f=setup(t);
  assert.equal((await f.grant()).status,204);
  assert.equal((await f.adminRequest('PATCH','quotas/global',{mode:'protected',limitBytes:1000,maxConcurrent:2},{id:f.host,role:'admin',status:'approved'})).status,403);
  assert.equal((await f.adminRequest('PATCH','quotas/global',{mode:'protected'})).status,400);
  f.state.owner=false;
  assert.equal((await f.adminRequest('PATCH','quotas/global',{mode:'protected',limitBytes:1000,maxConcurrent:1})).status,503);
  assert.equal(f.state.issues.length,0);
  f.state.owner=true;
  assert.equal((await f.adminRequest('PATCH','quotas/global',{mode:'protected',limitBytes:1000,maxConcurrent:1})).status,200);
  assert.equal((await f.grant()).status,403);
  assert.equal((await f.adminRequest('GET','usage')).status,200);
});
test('each authenticated endpoint receives an attributable grant and independent measured account/global totals',async t=>{
  const f=setup(t);await f.configure();
  assert.equal((await f.grant(f.viewer,'host')).status,403);
  f.state.records=true;f.state.global=240;f.state.personal=50;
  const r=await f.grant(),data=await r.json();
  assert.equal(r.status,200);
  assert(data.expiresAt<=Date.now()+120000 && data.expiresAt>Date.now()+110000);
  assert.deepEqual(data.iceServers[0].urls,['turns:turn.cloudflare.com:443?transport=tcp']);
  const repeat=await f.grant();assert.equal((await repeat.json()).iceServers[0].username,data.iceServers[0].username);
  assert.equal((await f.grant(f.viewer,'viewer')).status,200);
  assert.deepEqual(f.state.issues.map(r=>r.customIdentifier),[accountIdentifier(f.host),accountIdentifier(f.viewer)]);
  assert(f.state.issues.every(r=>r.ttl<=120));
  const g=await (await f.adminRequest('GET','usage')).json(),u=await (await f.adminRequest('GET','usage?accountId='+f.host)).json();
  assert.equal(g.usage.egressBytes,240);assert.equal(u.usage.egressBytes,50);assert.equal(u.usage.hasRecords,true);
  assert.equal(g.activeGrants,2);assert.equal(u.activeGrants,1);
  assert(f.state.queries.some(q=>!q.includes('customIdentifier')));
  assert(f.state.queries.some(q=>q.includes('customIdentifier: "cc-'+f.viewer+'"')));
});
test('concurrent rooms cannot exceed a participant quota and overlapping retries never double-issue',async t=>{
  const f=setup(t);await f.configure();
  const next='y'.repeat(43);f.addRoom(next);
  const responses=await Promise.all([f.grant(),f.grant(),f.grant(f.host,'host',next)]);
  assert(responses.some(r=>r.status===200));assert(responses.some(r=>r.status===429));assert.equal(f.state.issues.length,1);
});
test('outages, decreasing/empty measurements, changing account ownership and authentication fail closed',async t=>{
  const f=setup(t);await f.configure();
  f.state.records=true;f.state.global=40;f.state.personal=30;
  assert.equal((await f.grant()).status,200);
  f.state.records=false;
  assert.equal((await f.grant()).status,503);
  assert.deepEqual(f.state.revocations,['credential-1']);
  assert.equal((await f.adminRequest('GET','usage').then(r=>r.json())).meterStatus,'unavailable');
  f.state.records=true;f.state.global=20;f.state.personal=10;
  assert.equal((await f.adminRequest('GET','usage').then(r=>r.json())).usage.highWaterEgressBytes,40);
  f.state.owner=false;assert.equal((await f.grant()).status,503);
  f.state.owner=true;f.state.meter=false;assert.equal((await f.grant()).status,503);
  f.sql.prepare('UPDATE accounts SET status=? WHERE id=?').run('suspended',f.viewer);
  assert.equal((await f.grant()).status,403);assert.equal(f.state.issues.length,1);
});
test('headroom blocks before quota; revoke failures stay retryable, and emergency off needs no provider response',async t=>{
  const f=setup(t);await f.configure();assert.equal((await f.grant()).status,200);
  f.state.records=true;f.state.personal=450;f.state.global=700;
  f.state.revoke=false;assert.equal((await f.grant()).status,403);
  let row=f.sql.prepare('SELECT * FROM relay_leases').get();assert.equal(row.state,'revoking');assert.equal(row.payload,null);
  f.state.revoke=true;await reconcileRelayUsage(f.env);
  row=f.sql.prepare('SELECT * FROM relay_leases').get();assert.equal(row.state,'revoked');
  f.state.meter=false;
  assert.equal((await f.adminRequest('PATCH','quotas/global',{mode:'off'})).status,200);
  assert.equal((await f.grant()).status,204);
});
test('grant cannot be delivered after a simultaneous consent teardown; account and room hooks cancel grants',async t=>{
  const f=setup(t);await f.configure();
  f.state.onIssue=()=>closeRoomRelay(f.env,f.room);
  assert.equal((await f.grant()).status,403);
  assert.deepEqual(f.state.revocations,['credential-1']);
  f.state.onIssue=null;
  assert.equal((await f.grant(f.viewer,'viewer')).status,200);
  await revokeAccountRelay(f.env,f.viewer);assert.equal(f.state.revocations.length,2);
});
test('explicit period boundary and unavailable analytics inputs are handled without minting credentials',async t=>{
  const f=setup(t);
  assert.deepEqual(periodAt(Date.parse('2025-02-28T00:00Z'),'31'),{periodStart:'2025-02-28T00:00:00.000Z',periodEnd:'2025-03-31T00:00:00.000Z'});
  assert.throws(()=>periodAt(Date.now(),'0'));
  await assert.rejects(readTurnUsage({...f.env,CC_CF_ANALYTICS_TOKEN:''},f.host));
  const zero=await readTurnUsage(f.env,f.host);
  assert.equal(zero.hasRecords,false);assert.equal(zero.egressBytes,0);
});
test('a provider call racing a disable cannot deliver, lowering the global limit can stop ongoing usage',async t=>{
  const f=setup(t);await f.configure();
  f.state.onIssue=()=>f.adminRequest('PATCH','quotas/global',{mode:'off'});
  assert.equal((await f.grant()).status,403);assert.equal(f.state.revocations.length,1);
  f.state.onIssue=null;
  assert.equal((await f.adminRequest('PATCH','quotas/global',{mode:'protected'})).status,200);
  assert.equal((await f.grant()).status,200);
  f.state.records=true;f.state.global=860;
  assert.equal((await f.adminRequest('PATCH','quotas/global',{limitBytes:900})).status,200);
  assert.equal((await f.grant()).status,403);assert.equal(f.state.revocations.length,2);
});
test('early refresh rotates with bounded overlap; logout revokes both members including past rotation',async t=>{
  const f=setup(t);await f.configure();
  assert.equal((await f.grant()).status,200);
  f.sql.prepare('UPDATE relay_leases SET expires=?,created=?').run(Date.now()+30000,Date.now()-90000);
  assert.equal((await f.grant()).status,200);
  assert.equal((await f.grant(f.viewer,'viewer')).status,200);
  await revokeAccountRelay(f.env,f.host);
  assert.deepEqual(f.state.revocations.sort(),['credential-1','credential-2','credential-3']);
});
test('stale unowned grants and rapid meter polls do not enable more credentials',async t=>{
  const f=setup(t);await f.configure();
  f.sql.prepare('INSERT INTO turn_grants(room,role,lease,retry_at,expires,payload) VALUES(?,?,?,?,?,?)')
    .run(f.room,'host','legacy',0,Date.now()+50000,'{}');
  assert.equal((await f.grant()).status,503);
  f.sql.exec('DELETE FROM turn_grants');
  for (let i=0;i<4;i++) assert.equal((await f.grant()).status,200);
  assert.equal((await f.grant()).status,429);
  assert.equal(f.state.issues.length,1);
});
test('smaller provider windows sum every UTC day exactly once and never use missing history as zero',async t=>{
  const f=setup(t), anchor=Date.parse('2026-11-15T12:00Z'), seen=[];
  let stale=false,partial=false;
  t.mock.method(globalThis,'fetch',async(url,options)=>{
    assert.equal(url,'https://api.cloudflare.com/client/v4/graphql');
    const query=JSON.parse(options.body).query,account={accountTag:f.env.CC_CF_ACCOUNT_ID};
    if (query.includes('settings {')) {
      account.settings={callsTurnUsageAdaptiveGroups:{enabled:true,maxDuration:86400,notOlderThan:stale?2*86400:35*86400}};
    } else if (query.includes('d0:callsTurnUsageAdaptiveGroups')) {
      const dates=[...query.matchAll(/(d\d+):callsTurnUsageAdaptiveGroups\(limit:1, filter:\{date_geq:"([\d-]+)",date_leq:"([\d-]+)"/g)];
      for (const [_,alias,start,end] of dates) {
        assert.equal(start,end);seen.push(start);
        if (!partial || start!=='2026-11-15') account[alias]=[{sum:{ingressBytes:1,egressBytes:2}}];
      }
    } else return Response.json({errors:[{message:'range exceeds maximum'}]});
    return Response.json({data:{viewer:{accounts:[account]}}});
  });
  const all=await readTurnUsage(f.env,f.host,anchor);
  assert.equal(all.basis,'daily');assert.equal(all.egressBytes,30);assert.equal(all.ingressBytes,15);
  assert.equal(seen.length,15);assert.equal(new Set(seen).size,15);
  seen.length=0;await readTurnUsage(f.env,f.host,anchor+30000);assert.deepEqual(seen,['2026-11-15']);
  partial=true;await assert.rejects(readTurnUsage(f.env,f.host,anchor+60000));
  stale=true;await assert.rejects(readTurnUsage(f.env,f.viewer,anchor));
});
test('budget ceiling is 1,000 decimal GB for both scopes',async t=>{
  const f=setup(t);
  for (const scope of ['global',f.host]) {
    assert.equal((await f.adminRequest('PATCH','quotas/'+scope,{limitBytes:1e12+1})).status,400);
    assert.equal((await f.adminRequest('PATCH','quotas/'+scope,{limitBytes:1e12})).status,200);
  }
});
test('logout cancels credentials for both endpoints of just that login’s rooms',async t=>{
  const f=setup(t);await f.configure();
  assert.equal((await f.grant()).status,200);
  assert.equal((await f.grant(f.viewer,'viewer')).status,200);
  await closeSessionRelay(f.env,'different-login');
  assert.equal(f.state.revocations.length,0);
  await closeSessionRelay(f.env,f.host);
  assert.equal(f.state.revocations.length,2);
});

test('admin diagnostics show provider status and numeric code without disclosing its body or credential', async t => {
  const f=setup(t), echoedSecret='synthetic-provider-error-detail';
  t.mock.method(globalThis,'fetch',async(url,init)=>{
    assert.equal(init.redirect,'manual');
    return Response.json({errors:[{code:10000,message:echoedSecret}]},{status:403});
  });
  const view=await (await f.adminRequest('GET','usage')).json();
  assert.equal(view.meterStatus,'unavailable');
  assert.deepEqual(view.meterDiagnostic,{stage:'analytics',reason:'http',httpStatus:403,providerCode:10000});
  const enabled=await f.adminRequest('PATCH','quotas/global',{mode:'protected',limitBytes:1000,maxConcurrent:1});
  assert.equal(enabled.status,503);
  const response=await enabled.text();
  assert.ok(!response.includes(echoedSecret) && !response.includes(f.env.CC_CF_ANALYTICS_TOKEN));
  assert.equal((await f.adminRequest('GET','usage',null,{id:f.host,role:'member',status:'approved'})).status,403);
});

test('authenticated provider reads treat redirects as failures and never request the redirect destination', async t => {
  const f=setup(t), observed=[];
  t.mock.method(globalThis,'fetch',async(url,init)=>{
    observed.push(url);assert.equal(init.redirect,'manual');
    return new Response(null,{status:302,headers:{Location:'https://redirect.example.test/'}});
  });
  const view=await (await f.adminRequest('GET','usage')).json();
  assert.deepEqual(view.meterDiagnostic,{stage:'analytics',reason:'http',httpStatus:302});
  assert.deepEqual(observed,['https://api.cloudflare.com/client/v4/graphql']);
  assert.deepEqual((await f.grant()).status,204);
});
