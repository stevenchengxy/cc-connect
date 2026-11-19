'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { randomBytes, createHmac, createCipheriv, createDecipheriv } = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { DeviceCodes, normalizeDeviceCode } = require('../src/device-code.cjs');

const secret = () => randomBytes(32).toString('base64url');
function room() {
  const key = randomBytes(32);
  const spec = {key:key.toString('base64url'),exp:Date.now()+600000,account:1,managed:1};
  return {room:createHmac('sha256',key).update('rd1-managed-room').digest('base64url'),
    hostToken:secret(),invite:'RD1.'+Buffer.from(JSON.stringify(spec)).toString('base64url')};
}

async function setup(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(),'cc-device-test-'));
  t.after(() => fs.rm(directory,{recursive:true,force:true}));
  const storageKey = randomBytes(32), session = secret();
  const f = {directory,session,records:new Map(),requests:[],locked:false};
  f.storage = {
    isAsyncEncryptionAvailable:async () => !f.locked,
    getSelectedStorageBackend:()=>'gnome_libsecret',
    async encryptStringAsync(value) {
      if (f.failEncrypt) throw Error('disk key unavailable');
      const nonce = randomBytes(12), cipher=createCipheriv('aes-256-gcm',storageKey,nonce);
      const bytes=Buffer.concat([cipher.update(value),cipher.final()]);
      return Buffer.concat([nonce,cipher.getAuthTag(),bytes]);
    },
    async decryptStringAsync(bytes) {
      const cipher=createDecipheriv('aes-256-gcm',storageKey,bytes.subarray(0,12));
      cipher.setAuthTag(bytes.subarray(12,28));
      return {result:Buffer.concat([cipher.update(bytes.subarray(28)),cipher.final()]).toString()};
    }
  };
  const fetchImpl = async (url, opts) => {
    assert.equal(opts.cache,'no-store');
    assert.equal(opts.redirect,'error');
    assert.equal(opts.credentials,'omit');
    assert(opts.signal);
    opts.signal.throwIfAborted();
    assert.equal(opts.headers['x-cc-session'],session);
    const match=/^https:\/\/pair\.example\/v1\/devices\/([A-Za-z0-9_-]{43})(\/publish)?$/.exec(url);
    assert(match);
    const alias=match[1], stored=f.records.get(alias);
    f.requests.push({alias,method:opts.method,authorization:opts.headers.authorization,body:opts.body});
    if (f.reply) return f.reply();
    if (opts.method==='GET') {
      assert(!match[2]);
      assert(!opts.headers.authorization);
      return stored?.envelope ? Response.json({envelope:stored.envelope}) : new Response(null,{status:404});
    }
    const management=opts.headers.authorization.slice(7);
    assert.match(management,/^[A-Za-z0-9_-]{43}$/);
    if (stored && stored.management!==management) return new Response(null,{status:403});
    if (opts.method==='POST') {
      assert(match[2]);
      if (stored?.retired) return new Response(null,{status:410});
      const {room,envelope}=JSON.parse(opts.body);
      if (stored?.room === room && stored.envelope !== envelope) return new Response(null,{status:409});
      f.records.set(alias,{management,room,envelope});
      f.onPublish?.();
    } else {
      assert.equal(opts.method,'DELETE');
      assert(!match[2]);
      f.records.set(alias,{management,retired:true});
      f.onRevoke?.();
    }
    return new Response(null,{status:204});
  };
  f.open=() => new DeviceCodes({directory,storage:f.storage,base:'https://pair.example/v1',fetchImpl,platform:'linux'});
  return f;
}

test('fixed codes are distinct from temporary codes and only canonicalize the supported alphabet', () => {
  assert.equal(normalizeDeviceCode(' cc-abcd efgh-wxyz '),'ABCDEFGHWXYZ');
  assert.equal(normalizeDeviceCode('CCABCDEFGHWXYZ'),'ABCDEFGHWXYZ');
  for (const value of [null,'ABCD-EFGH-WXYZ','CC-0BCD-EFGH-WXYZ','CC-ABCD-EFGH-WXYI','RD1.payload','CC-ſBCD-EFGH-WXYZ']) {
    assert.equal(normalizeDeviceCode(value),null);
  }
});

test('one stable code for concurrent reads and process restarts, isolated per account and protected by the credential store', async t => {
  const f=await setup(t);
  const codes=await Promise.all(Array.from({length:12},(_,i)=>f.open().get(i%2?'member.a':'MEMBER.A')));
  assert.equal(new Set(codes).size,1);
  const old=codes[0], other=await f.open().get('member.b');
  assert.notEqual(old,other);
  assert.equal(await f.open().get('member.a'),old);
  const names=await fs.readdir(f.directory);
  assert.equal(names.length,2);
  for (const name of names) {
    const file=path.join(f.directory,name),bytes=await fs.readFile(file);
    assert(!name.includes('member'));
    assert(!bytes.includes(normalizeDeviceCode(old)));
    if (process.platform!=='win32') assert.equal((await fs.stat(file)).mode&0o777,0o600);
  }
  f.locked=true;
  await assert.rejects(f.open().get('member.a'),/安全凭据/);
  f.locked=false;
  f.storage.getSelectedStorageBackend=()=>'basic_text';
  await assert.rejects(f.open().get('member.a'),/安全凭据/);
  f.storage.getSelectedStorageBackend=()=>'kwallet6';
  // An account record copied over a different account's file must not grant the same identity.
  await fs.copyFile(path.join(f.directory,names[0]),path.join(f.directory,names[1]));
  const states=await Promise.allSettled([f.open().get('member.a'),f.open().get('member.b')]);
  assert.equal(states.filter(s=>s.status==='rejected').length,1);
  assert.equal(f.requests.length,0);
});

test('only an encrypted temporary invitation leaves the host; alias swapping and tampering fail authentication', async t => {
  const f=await setup(t), host=f.open(), viewer=f.open(), grant=room();
  const code=await host.publish('member.a',f.session,grant);
  const first=f.requests.at(-1), body=JSON.parse(first.body);
  assert.deepEqual(Object.keys(body).sort(),['envelope','hostToken','room']);
  assert.equal(body.hostToken,grant.hostToken);
  assert.equal(body.room,grant.room);
  assert(!first.body.includes(grant.invite));
  assert(!JSON.stringify(first).includes(normalizeDeviceCode(code)));
  assert.notEqual(first.authorization,'Bearer '+f.session);
  assert.notEqual(first.authorization,'Bearer '+grant.hostToken);
  assert.notEqual(first.authorization,'Bearer '+first.alias);
  assert.equal(await host.publish('member.a',f.session,grant),code);
  assert.deepEqual(f.requests.at(-1),first);
  assert.equal(await viewer.resolve(code.toLowerCase(),f.session),grant.invite);
  assert(!f.requests.at(-1).authorization);
  const nextGrant=room();
  assert.equal(await host.publish('member.a',f.session,nextGrant),code);
  assert.notDeepEqual(Buffer.from(JSON.parse(f.requests.at(-1).body).envelope,'base64url').subarray(0,12),
    Buffer.from(body.envelope,'base64url').subarray(0,12));
  const second=await host.publish('member.b',f.session,room());
  const other=f.requests.at(-1);
  assert.notEqual(first.alias,other.alias);
  assert.notEqual(first.authorization,other.authorization);
  f.records.get(other.alias).envelope=body.envelope;
  await assert.rejects(viewer.resolve(second,f.session),/格式无效/);
  const bytes=Buffer.from(body.envelope,'base64url'); bytes[0]^=32;
  f.records.get(first.alias).envelope=bytes.toString('base64url');
  await assert.rejects(viewer.resolve(code,f.session),/格式无效/);
  const count=f.requests.length;
  await assert.rejects(host.publish('member.a',f.session,{...grant,room:secret()}),/格式无效/);
  await assert.rejects(host.publish('member.a',f.session,{...grant,invite:'not RD1'}),/格式无效/);
  await assert.rejects(host.resolve(code,'bad'),/登录/);
  assert.equal(f.requests.length,count);
});

test('lost revoke response or secure-store commit can be retried across restart without a resurrected old code', async t => {
  const f=await setup(t), client=f.open(), grant=room();
  const code=await client.publish('member.a',f.session,grant);
  const first=f.requests.at(-1);
  f.onRevoke=()=>{throw Error('ack lost')};
  await assert.rejects(client.rotate('member.a',f.session),/网络/);
  assert.equal(await f.open().get('member.a'),code);
  await assert.rejects(f.open().resolve(code,f.session),/未开启/);
  f.onRevoke=()=>{f.failEncrypt=true;};
  await assert.rejects(f.open().rotate('member.a',f.session),/安全凭据/);
  assert.equal(await f.open().get('member.a'),code);
  f.onRevoke=null; f.failEncrypt=false;
  const newCode=await f.open().publish('member.a',f.session,grant);
  assert.notEqual(newCode,code); assert.equal(await f.open().get('member.a'),newCode);
  assert.equal(f.requests.filter(r=>r.method==='DELETE'&&r.alias===first.alias).length,3);
  assert.equal(f.requests.filter(r=>r.method==='DELETE').every(r=>r.authorization===first.authorization),true);
  assert.equal(await f.open().resolve(newCode,f.session),grant.invite);
  await assert.rejects(f.open().resolve(code,f.session),/未开启/);
});

test('an acknowledged-but-lost publish retries with identical credentials, room and ciphertext', async t => {
  const f=await setup(t), client=f.open(), grant=room();
  f.onPublish=()=>{ f.onPublish=null; throw Error('ack lost'); };
  const code=await client.publish('member.a',f.session,grant);
  assert.equal(f.requests.length,2);
  assert.deepEqual(f.requests[0],f.requests[1]);
  assert.equal(await client.resolve(code,f.session),grant.invite);
  f.reply=()=>new Response(null,{status:429});
  await assert.rejects(client.publish('member.a',f.session,grant),e=>e.status===429);
  assert.equal(f.requests.length,4);
});

test('auth, rate limits, aborts and HTTP failures propagate without forgetting the old code', async t => {
  const f=await setup(t), client=f.open(), code=await client.get('member.a');
  f.reply=()=>new Response(null,{status:429});
  await assert.rejects(client.resolve(code,f.session),e=>e.status===429 && /频繁/.test(e.message));
  f.reply=()=>Response.json({error:'account_suspended'},{status:403});
  await assert.rejects(client.resolve(code,f.session),/账号已停用/);
  f.reply=()=>new Response(null,{status:404});
  await assert.rejects(client.rotate('member.a',f.session),e=>e.status===404);
  assert.equal(await client.get('member.a'),code);
  f.reply=()=>new Response(null,{status:409});
  await assert.rejects(client.rotate('member.a',f.session),e=>e.status===409 && /结束当前/.test(e.message));
  const revokes=f.requests.filter(r=>r.method==='DELETE').length;
  f.reply=null;
  assert.equal(await f.open().publish('member.a',f.session,room()),code);
  assert.equal(f.requests.filter(r=>r.method==='DELETE').length,revokes);
  await assert.rejects(client.resolve(code,f.session,AbortSignal.abort()),/连接已结束/);
});

test('desktop envelope and host-room credentials interoperate with the actual worker and migration', async t => {
  const {database, approvedSession} = await import('../pairing-site/test/fixture.js');
  const {default:worker} = await import('../pairing-site/worker/index.js');
  const {Mailbox} = require('../src/managed-mailbox.cjs');
  const f=await setup(t), db=database(t), host=approvedSession(db), viewer=approvedSession(db);
  const base='https://pair.example/v1';
  const fetchImpl=(url,init)=>worker.fetch(new Request(url,init),db);
  const desktop=()=>new DeviceCodes({base,directory:f.directory,storage:f.storage,fetchImpl});
  const grant=room(), key=JSON.parse(Buffer.from(grant.invite.slice(4),'base64url')).key;
  const mailbox=new Mailbox(base,'host',Buffer.from(key,'base64url'),fetchImpl,host.session);
  await mailbox.register();
  grant.hostToken=mailbox.authorization.slice(7);
  const code=await desktop().publish('qa.host',host.session,grant);
  assert.equal(await desktop().resolve(code,viewer.session),grant.invite);
  const next=await desktop().rotate('qa.host',host.session);
  assert.notEqual(next,code);
  await assert.rejects(desktop().resolve(code,viewer.session),e=>e.status===404);
});
