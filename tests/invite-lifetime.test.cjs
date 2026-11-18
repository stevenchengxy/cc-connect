'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { setTimeout: delay } = require('node:timers/promises');
const { PairingNetwork } = require('../src/network.cjs');
const { Mailbox } = require('../src/managed-mailbox.cjs');

test('a transient polling outage keeps the invitation valid through the original consent flow', { timeout: 12000 }, async t => {
  const { database, approvedSession } = await import('../pairing-site/test/fixture.js');
  const { default: worker } = await import('../pairing-site/worker/index.js');
  const env = database(t);
  let reads = 0, deletes = 0;
  const fetchImpl = (url, options) => {
    if (options.method === 'DELETE') deletes++;
    if (options.method === 'GET' && url.endsWith('/host/messages/1')) {
      reads++;
      if (reads === 1) throw new Error('temporary network failure');
      if (reads === 2) return Promise.resolve(new Response(null, { status: 403, headers: { 'content-type':'text/html' } }));
      if (reads === 3) return Promise.resolve(new Response(null, { status: 503 }));
      if (reads === 4) {
        const broken = new ReadableStream({ start(controller) { controller.error(new Error('interrupted response')); } });
        return Promise.resolve(new Response(broken));
      }
    }
    return worker.fetch(new Request(url, options), env);
  };
  const options = { accountOnly: true, managedUrl: 'https://pair.example/v1', fetchImpl };
  const host = new PairingNetwork({ ...options, accountToken: approvedSession(env).session });
  const viewer = new PairingNetwork({ ...options, accountToken: approvedSession(env).session });
  t.after(() => { host.stop(); viewer.stop(); });
  const events = [];
  host.on('event', event => events.push(event.type));
  const request = Promise.withResolvers(), accepted = Promise.withResolvers();
  host.on('event', event => { if (event.type === 'request') request.resolve(); });
  viewer.on('event', event => { if (event.type === 'connected') accepted.resolve(); });

  const { invite } = await host.host();
  await viewer.join({ invite });
  await request.promise;
  assert(reads >= 5);
  assert.equal(deletes, 0);
  assert.deepEqual(events, ['request']);
  assert.equal(host.state.peer.phase, 'pending');
  host.respond(true);
  await accepted.promise;
});

test('a verified request near expiry keeps its separate consent deadline', async () => {
  const network = new PairingNetwork();
  const state = network.begin('host', 'Host', Buffer.alloc(32));
  let inviteExpired = false;
  state.expires = setTimeout(() => { inviteExpired = true; }, 10);
  const peer = { phase: 'proof', challenge: 'verified' };
  try {
    network.receive(state, peer, { op: 'proof', value: 'verified' });
    await delay(30);
    assert.equal(inviteExpired, false);
    assert.equal(peer.phase, 'pending');
  } finally { network.stop(); }
});

test('refusing while offline stops stalled packet delivery and polling after the rejection drain', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let deletes = 0, aborted = 0;
  const writing = Promise.withResolvers();
  const mailbox = new Mailbox('https://pair.example/v1', 'host', Buffer.alloc(32), async (_url, { method, signal }) => {
    if (method === 'DELETE') { deletes++; return new Response(null, { status: 204 }); }
    if (method === 'PUT') writing.resolve();
    return new Promise((_, reject) => signal.addEventListener('abort', () => { aborted++; reject(signal.reason); }, { once: true }));
  });
  mailbox.readyState = 1;
  mailbox.registered = true;
  const polling = mailbox.poll();
  mailbox.send(Buffer.alloc(64));
  await writing.promise;
  mailbox.close();
  mailbox.close();
  assert.throws(() => mailbox.send(Buffer.alloc(64)), /中断/);
  t.mock.timers.tick(6000);
  await Promise.all([polling, mailbox.queue]);
  assert.equal(mailbox.readyState, 3);
  assert.equal(aborted, 2);
  assert.equal(deletes, 1);
  assert.equal(mailbox.bufferedAmount, 0);
});

test('a viewer can recover lost registration acknowledgements with the original enrollment bearer', async () => {
  const tokens = [];
  const mailbox = new Mailbox('https://pair.example/v1','viewer',Buffer.alloc(32),async (_url, { headers, method }) => {
    if (method !== 'POST') return new Response(null, { status: 204 });
    tokens.push(headers.authorization);
    if (tokens.length < 3) throw new Error('response lost after registration');
    return new Response(null, { status: 200 });
  });
  try {
    await mailbox.register();
    assert.equal(mailbox.readyState, 1);
    assert.equal(tokens.length, 3);
    assert.equal(new Set(tokens).size, 1);
  } finally { mailbox.terminate(); }
});

test('host and viewer rate limits return actionable messages without immediate resubmission', async () => {
  for (const [role, message] of [['host', /稍后再生成配对码/], ['viewer', /同一个配对码重试/]]) {
    let requests = 0;
    const mailbox = new Mailbox('https://pair.example/v1',role,Buffer.alloc(32),async () => {
      requests++;
      return new Response(null, { status: 429 });
    });
    await assert.rejects(mailbox.register(), message);
    assert.equal(requests, 1);
  }
});
