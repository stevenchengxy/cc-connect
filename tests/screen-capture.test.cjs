'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const { ScreenCapture, ScreenChoices, screenSelectionError } = require('../src/screen-capture.cjs')

const source = { id: 'screen:1:0', display_id: '24', name: 'Display name' }

test('explicit diagnostics enumerate screens without thumbnails and expose only a count and status', async () => {
  const capture = new ScreenCapture({ platform: 'darwin', systemVersion: '26.2',
    getPermission: kind => { assert.equal(kind, 'screen'); return 'granted' },
    getSources: async options => {
      assert.deepEqual(options, { types: ['screen'], thumbnailSize: { width: 0, height: 0 } })
      return [source]
    } })
  const result = await capture.inspect(true)
  assert.deepEqual(result.report, { permission: 'granted', screenCount: 1, errorCode: null, canUseSystemPicker: true })
})

test('unconfirmed permission does not open a broad OS prompt when an incoming request arrives', async () => {
  for (const [permission, errorCode] of [['denied', 'preflight-denied'], ['not-determined', 'permission-pending']]) {
    let current = permission
    let calls = 0
    const capture = new ScreenCapture({ platform: 'darwin', systemVersion: '14.7',
      getPermission: () => current, getSources: async () => { calls++; current = 'granted'; return [source] } })
    assert.deepEqual((await capture.inspect()).report, { permission, errorCode, canUseSystemPicker: false, screenCount: 0 })
    assert.equal(calls, 0)
    assert.equal((await capture.inspect(true)).report.screenCount, 1)
    assert.equal(calls, 1)
  }
})

test('classifies a completed or failed enumeration by the new permission decision', async () => {
  for (const [permission, errorCode] of [['granted', 'source-unavailable'], ['unknown', 'source-unavailable'],
    ['denied', 'permission-denied'], ['not-determined', 'permission-pending'], ['restricted', 'permission-restricted']]) {
    let current = 'granted'
    const capture = new ScreenCapture({ platform: 'darwin', systemVersion: '15.0',
      getPermission: () => current, getSources: async () => { current = permission; throw new Error('Failed to get sources') } })
    assert.deepEqual((await capture.inspect()).report, {
      permission, errorCode, screenCount: 0, canUseSystemPicker: permission !== 'restricted'
    })
  }
})

test('empty sources and managed policy have distinct results', async () => {
  const capture = new ScreenCapture({ platform: 'darwin', systemVersion: '15', getPermission: () => 'granted',
    getSources: async () => [] })
  assert.equal((await capture.inspect()).report.errorCode, 'no-displays')
  let reads = 0
  const restricted = new ScreenCapture({ platform: 'darwin', systemVersion: '26', getPermission: () => 'restricted',
    getSources: async () => { reads++; return [source] } })
  assert.deepEqual((await restricted.inspect(true)).report, { permission: 'restricted', errorCode: 'permission-restricted',
    screenCount: 0, canUseSystemPicker: false })
  assert.equal(reads, 0)
})

test('explicit successful system enumeration is kept when preflight is stale, without authorizing a revoked selection', async () => {
  const capture = new ScreenCapture({ platform:'darwin', systemVersion:'26', getPermission:() => 'denied',
    getSources:async () => [source] })
  const checked = await capture.inspect(true)
  assert.equal(checked.report.permission, 'denied')
  assert.equal(checked.report.errorCode, null)
  assert.deepEqual(checked.sources, [source])
  assert.equal(screenSelectionError('denied', checked.report.permission), null)
  assert.equal(screenSelectionError('denied', 'granted'), 'permission-denied')
  assert.equal(screenSelectionError('restricted', checked.report.permission), 'permission-restricted')
  assert.equal((await capture.inspect(false)).report.errorCode, 'preflight-denied')
})

test('a persistent macOS preflight and a failed listing cannot identify a fresh user denial', async () => {
  for (const permission of ['denied', 'not-determined']) {
    for (const getSources of [async () => [], async () => { throw new Error('Failed to get sources') }]) {
      const capture = new ScreenCapture({platform:'darwin', systemVersion:'26.2',
        getPermission:() => permission, getSources})
      assert.deepEqual((await capture.inspect(true)).report, {
        permission, screenCount:0, errorCode:'preflight-unconfirmed', canUseSystemPicker:true
      })
    }
  }
})

test('a new denial during enumeration or a Windows denial invalidates returned sources', async () => {
  for (const [platform, initialPermission] of [['darwin', 'granted'], ['darwin', 'not-determined'], ['win32', 'denied']]) {
    let permission = initialPermission
    const capture = new ScreenCapture({ platform, systemVersion: '26', getPermission: () => permission,
      getSources: async () => { permission = 'denied'; return [source] } })
    const result = await capture.inspect(true)
    assert.equal(result.report.errorCode, 'permission-denied')
    assert.equal(result.sources.length, 0)
  }
})

test('approval uses the enumerated source and matches the current display only if the topology still agrees', () => {
  const display = { id: 24, label: 'Main' }
  const unknown = { id: 'screen:2:0', display_id: '', name: 'Unmapped' }
  const choices = new ScreenChoices([source, unknown], [display], 24, 12)
  assert.deepEqual(choices.options[0], { id: source.id, displayId:'24', name: 'Main', primary: true })
  assert.equal(choices.options[1].displayId, '')
  const currentDisplay = { ...display, bounds: { x: 0, y: 0, width: 1920, height: 1080 } }
  assert.deepEqual(choices.select(source.id, [currentDisplay], 12), { source, display: currentDisplay })
  assert.deepEqual(choices.select(unknown.id, [currentDisplay], 12), { source: unknown, display: undefined })
  assert.throws(() => choices.select(source.id, [], 12), /source-unavailable/)
  assert.throws(() => choices.select(unknown.id, [display], 13), /source-unavailable/)
  assert.throws(() => choices.select('screen:other', [display], 12), /source-unavailable/)
})
