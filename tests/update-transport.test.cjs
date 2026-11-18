const {test} = require('node:test')
const assert = require('node:assert/strict')
const {EventEmitter} = require('node:events')
const {PassThrough} = require('node:stream')
const {systemUpdateTransport} = require('../src/update-transport.cjs')

function fakeNet(start) {
  const attempts = []
  return { attempts, request(options) {
    const req = new EventEmitter()
    req.abort = () => { req.aborted = true }
    req.end = () => queueMicrotask(() => start(req))
    attempts.push({ options, req })
    return req
  } }
}

test('update transport returns redirects to the updater and omits session credentials', async () => {
  const net = fakeNet(req => req.emit('redirect', 302, 'GET', 'https://elsewhere.example/asset'))
  const session = {}
  const request = systemUpdateTransport(net, session)
  const result = await request('https://example.test/start', {signal: new AbortController().signal})
  assert.equal(result.statusCode, 302)
  assert.equal(result.headers.location, 'https://elsewhere.example/asset')
  assert.equal(net.attempts.length, 1)
  assert.equal(net.attempts[0].options.redirect, 'manual')
  assert.equal(net.attempts[0].options.credentials, 'omit')
  assert.equal(net.attempts[0].options.session, session)
  assert(net.attempts[0].req.aborted)
})

test('aborting a streamed update interrupts the body reader', async () => {
  const controller = new AbortController()
  const net = fakeNet(req => {
    const body = new PassThrough()
    body.statusCode = 200
    body.headers = {}
    req.emit('response', body)
    body.write(Buffer.from('partial'))
  })
  const result = await systemUpdateTransport(net, {} )('https://example.test/asset', {signal: controller.signal})
  await assert.rejects(async () => {
    for await (const bytes of result) { assert.equal(bytes.toString(), 'partial'); controller.abort() }
  }, /interrupted/)
  assert(net.attempts[0].req.aborted)
})

test('a stalled update request times out before headers arrive', async () => {
  const net = fakeNet(() => {})
  const keepAlive = setInterval(() => {}, 1000)
  try {
    await assert.rejects(systemUpdateTransport(net, {}, 20)('https://example.test/stalled', {signal:new AbortController().signal}), /interrupted/)
    assert(net.attempts[0].req.aborted)
  } finally { clearInterval(keepAlive) }
})
