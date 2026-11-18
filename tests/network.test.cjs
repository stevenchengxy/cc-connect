'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomBytes, generateKeyPairSync, createHash } = require('node:crypto');
const https = require('node:https');
const tls = require('node:tls');
const forge = require('node-forge');
const { PairingNetwork } = require('../src/network.cjs');
const { createRelay } = require('../relay/server.cjs');

function next(net, type) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { net.off('event', receive); reject(new Error('Timed out waiting for ' + type)); }, 3000);
    const receive = event => {
      if (event.type !== type) return;
      net.off('event', receive);
      clearTimeout(timer);
      resolve(event);
    };
    net.on('event', receive);
  });
}

function change(invite, fields) {
  const spec = JSON.parse(Buffer.from(invite.slice(4), 'base64url').toString());
  return 'RD1.' + Buffer.from(JSON.stringify({ ...spec, ...fields })).toString('base64url');
}

async function roundTrip(t, config) {
  const host = new PairingNetwork();
  const viewer = new PairingNetwork();
  t.after(() => { viewer.stop(); host.stop(); });
  const { invite } = await host.host({ name: '共享端', ...config });
  const request = next(host, 'request');
  await viewer.join({ invite, name: '控制端', relayUrl: config.relayUrl });
  assert.equal((await request).name, '控制端');
  assert.throws(() => viewer.signal({ type: 'candidate', candidate: null }), /尚未就绪/);
  const approved = next(viewer, 'connected');
  host.respond(true);
  assert.deepEqual(await approved, { type: 'connected', role: 'viewer', name: '共享端', managedWan: false });
  const offer = { type: 'offer', sdp: 'v=0\r\n' };
  const incoming = next(viewer, 'signal');
  host.signal(offer);
  assert.deepEqual((await incoming).payload, offer);
  const candidate = { type: 'candidate', candidate: null };
  const response = next(host, 'signal');
  viewer.signal(candidate);
  assert.deepEqual((await response).payload, candidate);
  const closed = next(host, 'closed');
  viewer.stop();
  await closed;
  assert.throws(() => host.signal(candidate), /尚未就绪/);
}

test('pinned direct transport authorizes one session and forwards both signal directions', async t => {
  await roundTrip(t, { address: '127.0.0.1' });
});

test('wrong pin, expired invite and wrong key leave the host free to decline a valid viewer', async t => {
  const host = new PairingNetwork();
  const viewer = new PairingNetwork();
  const second = new PairingNetwork();
  t.after(() => { host.stop(); viewer.stop(); second.stop(); });
  const { invite } = await host.host({ address: '127.0.0.1' });
  let requests = 0;
  host.on('event', e => { if (e.type === 'request') requests++; });
  await assert.rejects(viewer.join({ invite: change(invite, { pin: randomBytes(32).toString('base64url') }) }), /验证/);
  await assert.rejects(viewer.join({ invite: change(invite, { exp: Date.now() - 1 }) }), /过期/);
  const failed = next(viewer, 'closed');
  await viewer.join({ invite: change(invite, { key: randomBytes(32).toString('base64url') }) });
  await failed;
  assert.equal(requests, 0);
  const request = next(host, 'request');
  await viewer.join({ invite, name: 'guest' });
  await request;
  await assert.rejects(second.join({ invite, name: 'second' }), /连接/);
  assert.equal(requests, 1);
  const denied = next(viewer, 'closed');
  host.respond(false);
  assert.match((await denied).reason, /拒绝/);
});

test('a configured, TLS-verified relay forwards encrypted signaling and enforces a local URL match', async t => {
  const keys = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' }
  });
  const cert = forge.pki.createCertificate();
  cert.publicKey = forge.pki.publicKeyFromPem(keys.publicKey);
  cert.serialNumber = '01' + randomBytes(8).toString('hex');
  cert.validity.notBefore = new Date(Date.now() - 60000);
  cert.validity.notAfter = new Date(Date.now() + 60000);
  const name = [{ name: 'commonName', value: 'localhost' }];
  cert.setSubject(name);
  cert.setIssuer(name);
  cert.setExtensions([{ name: 'subjectAltName', altNames: [{ type: 7, ip: '127.0.0.1' }] }]);
  cert.sign(forge.pki.privateKeyFromPem(keys.privateKey), forge.md.sha256.create());
  const pem = forge.pki.certificateToPem(cert);
  const server = https.createServer({ key: keys.privateKey, cert: pem });
  const relay = createRelay(server);
  t.after(() => { relay.close(); server.close(); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const relayUrl = 'wss://127.0.0.1:' + server.address().port + '/pair';
  const host = new PairingNetwork();
  await assert.rejects(host.host({ relayUrl }), /信令/);
  const oldTrust = tls.getCACertificates('default');
  tls.setDefaultCACertificates([...oldTrust, pem]);
  t.after(() => tls.setDefaultCACertificates(oldTrust));
  const { invite } = await host.host({ relayUrl });
  t.after(() => host.stop());
  const viewer = new PairingNetwork();
  await assert.rejects(viewer.join({ invite }), /两端配置相同/);
  await assert.rejects(viewer.join({ invite, relayUrl: 'wss://example.invalid/pair' }), /两端配置相同/);
  host.stop();
  await roundTrip(t, { relayUrl });
});

function managedFixture() {
  const rooms = new Map();
  const attempts = [];
  let loseFirstWriteAck = true;
  const fetchImpl = async (url, { method, headers, body }) => {
    const [, , , id, role, resource, sequence] = new URL(url).pathname.split('/');
    const token = headers.authorization;
    const result = (status, bytes = null) => new Response(bytes, { status });
    const proof = headers['x-viewer-proof'];
    let room = rooms.get(id);
    attempts.push({ method, role, resource, sequence, ciphertext: body });
    if (role === 'host' && method === 'POST' && !room) {
      room = { host: token, proof, closed: false, hostPackets: [], viewerPackets: [] };
      rooms.set(id, room);
      return result(201);
    }
    if (!room) return result(404);
    if (method === 'POST' && role === 'viewer') {
      if (createHash('sha256').update(proof).digest('hex') !== room.proof) return result(403);
      if (room.viewer && token !== room.viewer) return result(409);
      room.viewer = token;
      return result(201);
    }
    if (room[role] !== token) return result(403);
    if (method === 'GET' && resource === 'ice') {
      return Response.json({ iceServers: [{
        urls: ['turn:turn.example:3478?transport=udp', 'https://example.invalid/', 'turn:bad.example:123456'],
        username: 'short-lived', credential: 'fixture'
      }] });
    }
    if (method === 'PUT' && !room.closed) {
      const index = Number(sequence) - 1;
      const packets = room[role + 'Packets'];
      if (packets[index]) assert.deepEqual(packets[index], body);
      packets[index] = body;
      if (loseFirstWriteAck) { loseFirstWriteAck = false; return result(503); }
      return result(204);
    }
    if (method === 'DELETE') { room.closed = true; return result(204); }
    const packets = role === 'host' ? room.viewerPackets : room.hostPackets;
    const message = packets[Number(sequence) - 1];
    if (message) return result(200, message);
    return result(room.closed ? 410 : 204);
  };
  return { managedUrl: 'https://relay.example/v1', fetchImpl, attempts };
}

test('managed pairing reaches the approved peer when every LAN address is unreachable', async t => {
  const fixture = managedFixture();
  const host = new PairingNetwork(fixture);
  const viewer = new PairingNetwork(fixture);
  const duplicate = new PairingNetwork(fixture);
  t.after(() => { viewer.stop(); host.stop(); duplicate.stop(); });
  const { invite, internetAvailable } = await host.host({ address: '127.0.0.1' });
  assert.equal(internetAvailable, true);
  const inaccessible = change(invite, { port: 1 });
  const request = next(host, 'request');
  await viewer.join({ invite: inaccessible, name: 'wan-viewer' });
  assert.equal((await request).name, 'wan-viewer');
  assert.deepEqual(await host.getManagedIceServers(), []);
  assert.deepEqual(await viewer.getManagedIceServers(), []);
  assert.throws(() => viewer.signal({ type: 'candidate', candidate: null }), /尚未就绪/);
  await assert.rejects(duplicate.join({ invite: inaccessible }), /已被使用/);
  const connected = next(viewer, 'connected');
  host.respond(true);
  assert.equal((await connected).managedWan, true);
  const grants = await Promise.all([viewer.getManagedIceServers(), viewer.getManagedIceServers()]);
  assert.deepEqual(grants[0], [{urls:['turn:turn.example:3478?transport=udp'], username:'short-lived', credential:'fixture'}]);
  assert.deepEqual(grants[1], grants[0]);
  assert.equal(fixture.attempts.filter(item => item.resource === 'ice').length, 1);
  const received = next(host, 'signal');
  const offer = { type: 'offer', sdp: 'private-sdp' };
  viewer.signal(offer);
  assert.deepEqual((await received).payload, offer);
  assert(!fixture.attempts.some(item => item.ciphertext?.includes('private-sdp')));
  assert(fixture.attempts.filter(item => item.method === 'PUT' && item.role === 'viewer' && item.sequence === '1').length > 1);
  const disconnected = next(host, 'closed');
  viewer.stop();
  await disconnected;
});

test('hybrid invites prefer pinned LAN and keep the direct session after closing the managed route', async t => {
  const fixture = managedFixture();
  const host = new PairingNetwork(fixture);
  const viewer = new PairingNetwork(fixture);
  t.after(() => { viewer.stop(); host.stop(); });
  const { invite, internetAvailable } = await host.host({ address: '127.0.0.1' });
  assert.equal(internetAvailable, true);
  const request = next(host, 'request');
  await viewer.join({ invite });
  await request;
  const allowed = next(viewer, 'connected');
  host.respond(true);
  assert.equal((await allowed).managedWan, false);
  assert(!fixture.attempts.some(item => item.role === 'viewer'));
  const received = next(host, 'signal');
  viewer.signal({ type: 'candidate', candidate: null });
  await received;
});

test('managed service failure produces a usable invite compatible with LAN-only clients', async t => {
  const host = new PairingNetwork({ managedUrl: 'https://relay.example/v1', fetchImpl: async () => { throw new Error('offline'); } });
  const viewer = new PairingNetwork();
  t.after(() => { viewer.stop(); host.stop(); });
  const { invite, internetAvailable } = await host.host({ address: '127.0.0.1' });
  assert.equal(internetAvailable, false);
  const spec = JSON.parse(Buffer.from(invite.slice(4), 'base64url'));
  assert.equal(spec.managed, undefined);
  const request = next(host, 'request');
  await viewer.join({ invite });
  await request;
  const rejected = next(viewer, 'closed');
  host.respond(false);
  assert.match((await rejected).reason, /拒绝/);
});

test('public registration errors distinguish access denial, invite state and overloaded service', async () => {
  const key = randomBytes(32).toString('base64url');
  const invite = 'RD1.' + Buffer.from(JSON.stringify({key, exp: Date.now() + 60000, managed: 1})).toString('base64url');
  for (const [status, headers, expected] of [
    [403, {'content-type': 'text/html'}, /拒绝了此次网络访问/],
    [403, {}, /配对码验证失败/], [404, {}, /找不到/],
    [409, {}, /已被使用/], [410, {}, /结束或过期/], [429, {}, /暂时繁忙/]
  ]) {
    const network = new PairingNetwork({
      managedUrl: 'https://pair.example/v1', fetchImpl: async () => new Response(null, {status, headers})
    });
    await assert.rejects(network.join({invite}), expected);
    assert.equal(network.state, null);
  }
});

test('configured TURN failure can recover, while no configured TURN is a normal empty result', async () => {
  const {Mailbox} = require('../src/managed-mailbox.cjs');
  let attempts = 0;
  const statuses = [503, 503, 200, 204];
  const mailbox = new Mailbox('https://pair.example/v1', 'host', randomBytes(32), async () => {
    const status = statuses[attempts++];
    return status === 200 ? Response.json({iceServers: [{urls:'turn:relay.example:3478', username:'u', credential:'v'}]})
      : new Response(null, {status});
  });
  mailbox.readyState = 1;
  mailbox.active = true;
  const network = new PairingNetwork();
  network.state = {peer: {ws:mailbox, phase:'active', managedWan:true}};
  assert.deepEqual(await network.getManagedIceServers(), []);
  assert.equal(network.managedIceUnavailable, true);
  assert.equal((await network.getManagedIceServers()).length, 1);
  assert.equal(network.managedIceUnavailable, false);
  assert.deepEqual(await mailbox.ice(), []);
  assert.equal(mailbox.iceUnavailable, false);
});

test('approved-account desktop enrolls both roles only via the official API and rejects legacy invitations', async t => {
  const fixture = managedFixture();
  const tokens = {host:randomBytes(32).toString('base64url'), viewer:randomBytes(32).toString('base64url')};
  const calls = [];
  const get = role => new PairingNetwork({...fixture, accountOnly:true, accountToken:tokens[role], fetchImpl: (url, options) => {
    assert.equal(new URL(url).origin,'https://relay.example');
    assert.equal(options.headers['x-cc-session'],tokens[role]);
    assert.equal(options.redirect,'error');
    calls.push(role);
    return fixture.fetchImpl(url,options);
  }});
  assert.throws(()=>new PairingNetwork({...fixture,accountOnly:true}),/登录/);
  const host=get('host'), viewer=get('viewer');
  t.after(()=>{host.stop(); viewer.stop();});
  const {invite} = await host.host({relayUrl:'wss://ignored.invalid',address:'127.0.0.1'});
  const spec=JSON.parse(Buffer.from(invite.slice(4),'base64url'));
  assert.deepEqual(Object.keys(spec).sort(),['account','exp','key','managed']);
  assert(!Object.values(spec).includes(tokens.host)); assert(!host.state.server);
  await assert.rejects(viewer.join({invite:change(invite,{account:undefined})}),/两端升级/);
  const request=next(host,'request');
  await viewer.join({invite,name:'Approved'});
  await request;
  const accepted=next(viewer,'connected');
  host.respond(true); assert.equal((await accepted).managedWan,true);
  assert(calls.includes('viewer'));
  const blocked = new PairingNetwork({...fixture,accountOnly:true,accountToken:tokens.host,fetchImpl:async () =>
    Response.json({error:'account_suspended'},{status:403})});
  await assert.rejects(blocked.host({address:'127.0.0.1'}),/已停用/);
  assert.equal(blocked.state,null);
});

test('managed relay grants refresh before expiry and disappear when renewal is denied', async () => {
  const {Mailbox} = require('../src/managed-mailbox.cjs');
  const time=Date.now(); let calls=0;
  const ws = new Mailbox('https://pair.example/v1','host',randomBytes(32),async () => {
    calls++;
    return calls === 1 ? Response.json({iceServers:[{urls:'turn:relay.example',username:'u',credential:'v'}], expiresAt:time+120000})
      : Response.json({error:'relay_quota_exhausted'},{status:403});
  },randomBytes(32).toString('base64url'));
  ws.readyState=1; ws.active=true;
  const net=new PairingNetwork();net.state={peer:{ws,phase:'active',managedWan:true}};
  assert.equal((await net.getManagedIceServers()).length,1);
  assert.equal((await net.getManagedIceServers(true)).length,1);
  assert.equal(calls,1);
  ws.iceExpiresAt=Date.now()+25000;
  assert.deepEqual(await net.getManagedIceServers(true),[]);
  assert.equal(net.managedIceUnavailable,true);
  assert.equal(net.managedIceExpiresAt,0);
});
