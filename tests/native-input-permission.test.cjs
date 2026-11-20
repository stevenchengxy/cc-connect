'use strict'

const {test} = require('node:test')
const assert = require('node:assert/strict')
const {once} = require('node:events')
const {MacInputBridge,WindowsInputBridge} = require('../native/bridge.cjs')

function fixture() {
  const state = {allowed:false, prompts:0, starts:0, stops:0, commands:[]}
  const native = {
    access(request) {
      if (!request) return state.allowed
      state.prompts++
      return state.answer?.promise ?? Promise.resolve(state.allowed)
    },
    start(displayId) {
      assert.equal(displayId,123)
      if (!state.allowed) throw Error('control-permission')
      state.starts++
    },
    send(line) {
      if (!state.allowed) throw Error('control-permission')
      state.commands.push(line)
    },
    stop() { state.stops++ }
  }
  const load = () => native
  return {bridge:new MacInputBridge(load),load,native,state}
}

test('Mac diagnostics, manual access and event posting use the same native permission state', async () => {
  const {bridge,load,state} = fixture()
  assert.equal(await MacInputBridge.macAccess({},false,load),'denied')
  assert.equal(await bridge.checkPermission({}),false)
  for (const requestAccess of [false,undefined,'true']) {
    await assert.rejects(bridge.start({id:123},{requestAccess}),/control-permission/)
  }
  assert.equal(state.prompts,0)
  state.answer = Promise.withResolvers()
  const diagnostic = MacInputBridge.macAccess({},true,load)
  const started = bridge.start({id:123},{requestAccess:true})
  assert.equal(state.prompts,1,'The session and the settings query join one pending OS request')
  assert.equal(bridge.send({kind:'reset'}),false)
  state.allowed = true
  state.answer.resolve(true)
  await started
  assert.equal(await diagnostic,'granted')
  assert.equal(await MacInputBridge.macAccess({},true,load),'granted')
  assert.equal(state.prompts,1)
  assert.ok(bridge.send({kind:'reset'}))
  assert.deepEqual(state.commands,['reset'])
  await bridge.stop()
  await bridge.stop()
  assert.equal(state.stops,1)
  assert.equal(bridge.send({kind:'reset'}),false)
})

test('an explicit request cannot grant control if the actual start still fails', async () => {
  const {bridge,state} = fixture()
  state.answer = Promise.withResolvers()
  const started = bridge.start({id:123},{requestAccess:true})
  const denied = assert.rejects(started,/control-permission/)
  state.answer.resolve(true)
  await denied
  assert.equal(bridge.session,null)
  assert.equal(bridge.send({kind:'reset'}),false)
  assert.equal(state.starts,0)
})

test('cancelling or timing out a pending Mac prompt leaves the next session in control', async t => {
  t.mock.timers.enable({apis:['setTimeout']})
  for (const timeout of [false,true]) {
    const {bridge,state,load} = fixture()
    state.answer = Promise.withResolvers()
    const started = bridge.start({id:123},{requestAccess:true})
    const rejected = assert.rejects(started,timeout ? /超时/ : /取消/)
    t.mock.timers.tick(6001)
    assert.equal(bridge.send({kind:'reset'}),false)
    if (timeout) t.mock.timers.tick(114000)
    else await bridge.stop()
    await rejected
    assert.equal(bridge.session,null)
    state.allowed = true
    const next = new MacInputBridge(load)
    await next.start({id:123},{})
    state.answer.resolve(true)
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(state.starts,1)
    assert.equal(state.stops,0)
    assert.equal(bridge.send({kind:'reset'}),false)
    assert.ok(next.send({kind:'reset'}))
    await next.stop()
    assert.equal(state.stops,1)
  }
})

test('revocation detected by the active Mac addon closes the input gate', async () => {
  const {bridge,state} = fixture()
  state.allowed = true
  await bridge.start({id:123},{})
  bridge.recheckAccess()
  assert.deepEqual(state.commands,['check-access'])
  state.allowed = false
  const denied = once(bridge,'error')
  bridge.recheckAccess()
  assert.equal((await denied)[0].message,'control-permission')
  assert.equal(bridge.send({kind:'reset'}),false)
  assert.equal(state.stops,1)
  assert.equal(state.prompts,0)
})

test('a burst of pointer positions keeps the last move, preserves key order and never replays a move after a click', () => {
  const bridge = new WindowsInputBridge()
  const writes = [], callbacks = []
  const stdin = { writable:true, writableLength:0, write(line, callback) {
    writes.push(line.trim())
    if (callback) callbacks.push(callback)
  } }
  bridge.session = {ready:true, child:{stdin}}
  const move = x => bridge.send({kind:'move', x, y:0})
  for (let i = 0; i <= 500; i++) move(i / 500)
  assert.deepEqual(writes, ['move 0.000000 0.000000'])
  callbacks.shift()()
  assert.equal(writes.at(-1), 'move 1.000000 0.000000')
  move(0.2)
  assert.ok(bridge.send({kind:'button', down:true, button:0, x:0.4, y:0}))
  move(0.5)
  move(0.6)
  callbacks.shift()()
  assert.equal(writes.at(-1), 'move 0.500000 0.000000')
  if (['darwin','win32'].includes(process.platform)) {
    assert.ok(bridge.send({kind:'key',code:'KeyA',down:true}))
    assert.equal(writes.at(-2),'move 0.600000 0.000000')
    assert.match(writes.at(-1),/^key /)
  }
})
