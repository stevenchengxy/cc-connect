'use strict'
const assert = require('node:assert/strict')
const {execFileSync, spawn} = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const readline = require('node:readline')
const {once} = require('node:events')
const {Worker} = require('node:worker_threads')
const {setTimeout: delay} = require('node:timers/promises')

const root = path.resolve(__dirname, '..')
const [mode, modulePath] = process.argv.slice(2)
const hosted = mode === '--hosted'
if (process.platform !== 'darwin' || !(mode === '--pid-only' || (hosted && modulePath))) {
  throw Error('Usage on macOS: --pid-only, or --hosted /absolute/path/to/packaged-input.node')
}
if (hosted && !(process.env.GITHUB_ACTIONS === 'true' && process.env.RUNNER_ENVIRONMENT === 'github-hosted' &&
    process.env.RUNNER_OS === 'macOS' && os.userInfo().username === 'runner' && path.isAbsolute(modulePath))) {
  throw Error('Global HID tests may run only on an isolated GitHub-hosted macOS runner')
}

function compilePidOnlyModule(temp, pid) {
  const source = fs.readFileSync(path.join(root, 'native/MacInput.swift'), 'utf8')
  const globalPost = 'event.post(tap: .cghidEventTap)'
  // The temporary test binary can send only to this exact child process. A
  // new posting call in the production source requires explicit review here.
  const directed = source.replaceAll(globalPost, 'event.postToPid(' + pid + ')')
  assert.equal(source.split(globalPost).length - 1, 3)
  assert(!/\.post\s*\(\s*tap\s*:|\bCGEventPost\s*\(/.test(directed), 'A global input call remains in the test copy')
  const swift = path.join(temp, 'MacInput.swift')
  const object = path.join(temp, 'MacInputAddon.o')
  const result = path.join(temp, 'pid-only.node')
  const headers = path.resolve(path.dirname(process.execPath), '../include/node')
  fs.writeFileSync(swift, directed)
  execFileSync('xcrun', ['clang', '-fPIC', '-DNAPI_VERSION=8', '-I' + headers, '-c', path.join(root, 'native/MacInputAddon.c'), '-o', object])
  execFileSync('xcrun', ['swiftc', '-O', '-parse-as-library', '-emit-library', swift, object,
    '-Xlinker', '-undefined', '-Xlinker', 'dynamic_lookup', '-o', result])
  return result
}

async function run() {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-native-input-test-'))
  let window, input
  let targetModule = modulePath
  try {
    if (hosted) {
      input = require(modulePath)
      if (!input.access(false)) {
        console.log('SKIP: this hosted runner has no effective PostEvent grant for the test process. No events were sent.')
        return
      }
    }
    const executable = path.join(temp, 'cc-input-window')
    execFileSync('xcrun', ['swiftc', '-O', path.join(__dirname, 'macos-qa/InputWindow.swift'), '-o', executable])
    window = spawn(executable, hosted ? ['--hosted'] : [], {stdio:['pipe', 'pipe', 'inherit']})
    const events = []
    const lines = readline.createInterface({input:window.stdout})
    lines.on('line', line => events.push(line))
    const waitFor = async expected => {
      for (let i = 0; i < 100; i++) {
        const index = events.findIndex(line => line === expected || line.startsWith(expected + ' '))
        if (index >= 0) return events.splice(index, 1)[0]
        if (window.exitCode !== null) throw Error('Test receiver exited while waiting for ' + expected + ': ' + events.join(', '))
        await delay(50)
      }
      throw Error('Test receiver timed out waiting for ' + expected + ': ' + events.join(', '))
    }
    const ready = (await waitFor('READY')).split(' ')
    const [display, x, y] = ready.slice(1).map(Number)
    assert(Number.isSafeInteger(display) && display > 0 && [x,y].every(n => n > 0 && n < 1))
    if (!hosted) {
      targetModule = compilePidOnlyModule(temp, window.pid)
      input = require(targetModule)
      if (!input.access(false)) {
        console.log('SKIP: the test process has no effective PostEvent permission. No events were sent.')
        return
      }
    }
    async function verifyDestination() {
      if (window.exitCode !== null || window.signalCode !== null) throw Error('Test receiver is no longer running')
      if (hosted) {
        window.stdin.write('focus\n')
        await waitFor('FOCUSED')
      }
    }
    await verifyDestination()
    input.start(display)
    input.send('check-access')
    input.send(`button 0 1 ${x} ${y}`)
    await waitFor('MOUSE_DOWN')
    // An AppKit button may consume mouse-up in its own tracking loop. Do
    // not wait for another main-loop focus acknowledgement inside that loop.
    input.send(`button 0 0 ${x} ${y}`)
    await waitFor(hosted ? 'BUTTON' : 'MOUSE_UP')
    await verifyDestination()
    input.send('key 0 1')
    await waitFor('KEY_DOWN')
    input.send('key 0 0')
    await waitFor('KEY_UP')
    if (hosted) {
      await waitFor('TEXT')
    } else {
      // A disconnect must release only this session's pressed inputs.
      input.send(`button 0 1 ${x} ${y}`)
      await waitFor('MOUSE_DOWN')
      input.send('key 0 1')
      await waitFor('KEY_DOWN')
      input.stop()
      await waitFor('MOUSE_UP')
      await waitFor('KEY_UP')
      input.stop()
      assert.throws(() => input.send('check-access'), /尚未启动/)

      // Terminating a JS environment must also run the native cleanup hook.
      const worker = new Worker(`
        const {parentPort, workerData} = require('node:worker_threads')
        const input = require(workerData.module)
        input.start(workerData.display)
        input.send('button 0 1 0.5 0.5')
        input.send('key 0 1')
        parentPort.on('message', () => {})
        parentPort.postMessage('held')
      `, {eval:true, workerData:{module:targetModule, display}})
      try {
        await once(worker, 'message')
        await waitFor('MOUSE_DOWN')
        await waitFor('KEY_DOWN')
      } finally { await worker.terminate() }
      await waitFor('MOUSE_UP')
      await waitFor('KEY_UP')
    }
    console.log(hosted
      ? 'PASS: the packaged input module clicked the test button and typed a into its text field via global HID on the isolated runner.'
      : 'PASS: a background receiver received real macOS click and A key events. Explicit stop and JS environment cleanup both released held inputs.')
  } finally {
    try { input?.stop() } finally {
      window?.stdin.end()
      window?.kill()
      fs.rmSync(temp, {recursive:true, force:true})
    }
  }
}

run().catch(error => { console.error(error.message); process.exitCode = 1 })
