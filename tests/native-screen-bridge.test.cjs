'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const { PassThrough } = require('node:stream')
const { setImmediate: tick } = require('node:timers/promises')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const { supportsNativePicker, nativeHelperAvailable, NativeScreenCapture, FrameReader } = require('../native/screen-bridge.cjs')

function header(id = 72, width = 160, height = 90, length = 6) {
  const bytes = Buffer.alloc(16)
  const fields = [id, width, height, length]
  fields.forEach((value, index) => bytes.writeUInt32BE(value, index * 4))
  return bytes
}

function record(marker, id = 72, width = 160, height = 90) {
  return Buffer.concat([header(id, width, height), Buffer.from([255, 216, marker, 0, 255, 217])])
}

function fixture(isRestricted, showCursor = true) {
  const child = new EventEmitter()
  child.stdout = new PassThrough()
  child.stdin = new PassThrough()
  child.kill = () => { setImmediate(() => child.emit('exit', null)); return true }
  const capture = new NativeScreenCapture({ isPackaged: true, resourcesPath: '/bundle/Resources', isRestricted, showCursor,
    spawnProcess(file, args, { stdio }) {
      assert.equal(file, path.join('/bundle/Resources', 'native/bin/CC Connect Screen.app/Contents/MacOS/cc-connect-screen'))
      assert.deepEqual(args, showCursor ? ['--pick-display'] : ['--pick-display','--omit-cursor'])
      assert.deepEqual(stdio, ['pipe', 'pipe', 'ignore'])
      return child
    } })
  return { child, capture }
}

test('controlled native capture omits the video pointer and restores it once on downgrade', async () => {
  const { child, capture } = fixture(undefined, false)
  const selected = capture.start()
  child.stdout.write(record(1))
  await selected
  const commands = []
  child.stdin.on('data', bytes => commands.push(...bytes))
  capture.restoreViewOnlyCursor()
  capture.restoreViewOnlyCursor()
  capture.stop()
  capture.restoreViewOnlyCursor()
  assert.deepEqual(commands, [1])
})

test('only macOS 15.2 and later offers the picker with display identity', () => {
  for (const version of ['15.2', '15.10.1', '26.0', '26']) assert.equal(supportsNativePicker('darwin', version), true)
  for (const version of ['invalid', '14.7.8', '15', '15.1']) assert.equal(supportsNativePicker('darwin', version), false)
  for (const platform of ['linux', 'win32']) assert.equal(supportsNativePicker(platform, '26.0'), false)
})

test('installation capability requires the bundled executable and its app identity', async t => {
  const resourcesPath = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-connect-helper-'))
  t.after(() => fs.rm(resourcesPath, { recursive:true, force:true }))
  const options = { isPackaged:true, resourcesPath }
  assert.equal(nativeHelperAvailable(options), false)
  const contents = path.join(resourcesPath, 'native', 'bin', 'CC Connect Screen.app', 'Contents')
  await fs.mkdir(path.join(contents, 'MacOS'), { recursive:true })
  const executable = path.join(contents, 'MacOS', 'cc-connect-screen')
  await fs.writeFile(executable, '', {mode:0o755})
  assert.equal(nativeHelperAvailable(options), false)
  await fs.writeFile(path.join(contents, 'Info.plist'), '<plist/>')
  assert.equal(nativeHelperAvailable(options), true)
  if (process.platform !== 'win32') {
    await fs.chmod(executable, 0o644)
    assert.equal(nativeHelperAvailable(options), false)
  }
  await fs.unlink(executable)
  await fs.mkdir(executable)
  assert.equal(nativeHelperAvailable(options), false)
})

test('fragmented and coalesced records preserve the OS-selected screen and pixels', () => {
  const frames = []
  const reader = new FrameReader(frame => frames.push(frame))
  const bytes = Buffer.concat([record(1, 73, 1080, 1920), record(2, 73, 1080, 1920)])
  for (const part of [bytes.subarray(0, 1), bytes.subarray(1, 19), bytes.subarray(19)]) reader.write(part)
  assert.deepEqual(frames.map(({ bytes, ...meta }) => [meta, bytes[2]]), [1, 2].map(mark => [{ displayId:73, width:1080, height:1920 }, mark]))
})

test('reject oversized/invalid headers before allocation, bad JPEG markers and display switches', () => {
  for (const invalid of [header(0), header(1, 0), header(1, 1921), header(1, 1081, 1081),
    header(1, 10, 10, 3), header(1, 10, 10, 2097153), Buffer.concat([header(), Buffer.alloc(6)])]) {
    assert.throws(() => new FrameReader(() => {}).write(invalid), /native-picker-failed/)
  }
  for (const next of [record(0, 73), record(0, 72, 100, 90)]) {
    const reader = new FrameReader(() => {})
    reader.write(record(0))
    assert.throws(() => reader.write(next), /native-picker-ended/)
  }
})

test('metadata first, first-frame credit, bounded writes and irrevocable close', async () => {
  const { child, capture } = fixture()
  const delivered = []
  capture.on('frame', frame => delivered.push(frame.bytes[2]))
  const selected = capture.start()
  assert.equal(capture.requestFrame(), false)
  child.stdout.write(Buffer.concat([record(1), record(2), record(3)]))
  assert.deepEqual(await selected, { displayId:72, width:160, height:90 })
  assert.deepEqual(delivered, [])
  assert.equal(child.stdout.isPaused(), true)
  capture.requestFrame()
  assert.deepEqual(delivered, [3])
  assert.equal(capture.requestFrame(), true)
  assert.equal(capture.requestFrame(), false)
  child.stdout.write(Buffer.concat([record(4), record(5), record(6)]))
  await tick()
  assert.deepEqual(delivered, [3, 4])
  capture.requestFrame()
  assert.deepEqual(delivered, [3, 4, 6])
  let reason
  capture.on('ended', code => { reason = code })
  child.emit('exit', 5)
  assert.equal(reason, 'native-picker-ended')
  assert.equal(capture.requestFrame(), false)
  assert.equal(capture.latest, null)
})

test('cancel, unsupported status and spawn failure reject the waiting selection', async () => {
  for (const [code, message] of [[3, /native-picker-cancelled/], [2, /native-picker-unsupported/], [4, /native-picker-failed/]]) {
    const { child, capture } = fixture()
    const selected = capture.start()
    child.emit('exit', code)
    child.emit('close', code)
    await assert.rejects(selected, message)
    assert.equal(capture.requestFrame(), false)
  }
  const capture = new NativeScreenCapture({spawnProcess: () => { throw new Error('ENOENT') }})
  await assert.rejects(capture.start(), /native-picker-failed/)
})

test('closing while the system chooser is open immediately seals the bridge and releases stdin', async () => {
  const { child, capture } = fixture()
  const selected = capture.start()
  let count = 0
  capture.on('ended', () => { count++ })
  capture.stop()
  assert.equal(child.stdin.writableEnded, true)
  child.stdout.write(record(1))
  child.emit('exit', 5)
  assert.equal(count, 1)
  await assert.rejects(selected, /native-picker-cancelled/)
  await assert.rejects(capture.start(), /native-picker-failed/)
})

test('managed policy blocks launch and revokes an idle selected display without another frame or acknowledgement', async t => {
  t.mock.timers.enable({apis:['setInterval']})
  let restricted = true
  const blocked = fixture(() => restricted)
  await assert.rejects(blocked.capture.start(), /permission-restricted/)
  assert.equal(blocked.capture.child, undefined)
  restricted = false
  const {child, capture} = fixture(() => restricted)
  const selected = capture.start()
  child.stdout.write(record(1))
  await selected
  let reason
  capture.on('ended', code => { reason = code })
  restricted = true
  t.mock.timers.tick(1000)
  assert.equal(reason, 'permission-restricted')
  assert.equal(capture.closed, true)
  assert.equal(child.stdin.writableEnded, true)
  assert.equal(capture.requestFrame(), false)
})
