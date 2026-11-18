const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const path = require('node:path')
const os = require('node:os')
const http = require('node:http')
const { generateKeyPairSync, createHash, sign } = require('node:crypto')
const { execFile } = require('node:child_process')
const { promisify } = require('node:util')
const { Updater, verifyManifest, compareVersions } = require('../src/updater.cjs')
const exec = promisify(execFile)
const keys = generateKeyPairSync('ed25519')
const publicKey = keys.publicKey.export({ type: 'spki', format: 'pem' })
const digest = data => createHash('sha256').update(data).digest('hex')
const release = 'https://github.com/stevenchengxy/cc-connect/releases/download/'
const payloads = [Buffer.from('first update fragment\n'), Buffer.from('second update fragment\n')]

function manifest(version = '0.3.0', parts = payloads) {
  const contents = Buffer.concat(parts)
  const file = extension => ({
    name: 'CC-Connect-' + version + '.' + extension, size: contents.length, sha256: digest(contents),
    parts: parts.map((data, index) => ({ url: release + 'v' + version + '/asset-' + index + '.part', size: data.length, sha256: digest(data) }))
  })
  return { version, files: { mac: file('dmg'), windows: file('exe') } }
}
function envelope(value) {
  const bytes = Buffer.from(JSON.stringify(value))
  return { payload: bytes.toString('base64'), signature: sign(null, bytes, keys.privateKey).toString('base64') }
}
async function fixture(t, handler, platform = 'darwin') {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-update-test-'))
  const server = http.createServer(handler)
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  const request = (url, { signal }) => new Promise((resolve, reject) => {
    const remote = new URL(url)
    // Production URLs are fully validated before this test-only transport maps
    // them to an isolated loopback server. It never relaxes URL validation.
    const req = http.get({ hostname: '127.0.0.1', port: address.port, path: remote.pathname, signal }, resolve)
    req.on('error', reject)
  })
  const states = []
  const app = { getPath: () => directory, getVersion: () => '0.2.0', isPackaged: true }
  const updater = new Updater({ app, publicKey, request, platform, emit: state => states.push(state), canInstall: () => false })
  assert.equal(updater.getState().phase, 'idle')
  t.after(async () => {
    updater.cancel()
    await updater.operation?.catch(() => {})
    server.closeAllConnections()
    await new Promise(resolve => server.close(resolve))
    await fs.rm(directory, { recursive: true, force: true })
  })
  return { updater, directory, states }
}
function sendJSON(response, value) { response.writeHead(200, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(value)) }

test('signed metadata rejects tampering, unsafe URLs, malformed versions and oversized files', () => {
  const original = manifest()
  assert.equal(verifyManifest(envelope(original), publicKey).version, '0.3.0')
  const tampered = envelope(original)
  tampered.payload = Buffer.from(JSON.stringify(manifest('0.9.0'))).toString('base64')
  assert.throws(() => verifyManifest(tampered, publicKey), /验证失败/)
  for (const unsafe of ['http://github.com/stevenchengxy/cc-connect/releases/download/v0.3.0/x', 'https://attacker.example/file', 'https://github.com/another/repo/releases/download/v0.3.0/x', 'https://user:pass@github.com/stevenchengxy/cc-connect/releases/download/v0.3.0/x']) {
    const modified = manifest(); modified.files.mac.parts[0].url = unsafe
    assert.throws(() => verifyManifest(envelope(modified), publicKey), /验证失败/)
  }
  const oversized = manifest(); oversized.files.mac.size = 1024 * 1024 * 1024 + 1
  assert.throws(() => verifyManifest(envelope(oversized), publicKey), /验证失败/)
  assert.throws(() => compareVersions('01.2.0', '1.0.0'), /验证失败/)
  assert.equal(compareVersions('1.0.0', '1.0.0-rc.2'), 1)
  assert.equal(compareVersions('1.0.0-rc.10', '1.0.0-rc.2'), 1)
  assert.equal(compareVersions('1.0.0+other', '1.0.0'), 0)
})

test('an interrupted part retries at its original offset and preserves validated ready data', async t => {
  const counts = [0, 0]
  const value = manifest()
  const { updater, states } = await fixture(t, (request, response) => {
    if (request.url.endsWith('latest.json')) return sendJSON(response, envelope(value))
    const index = Number(/asset-(\d)/.exec(request.url)[1])
    counts[index]++
    response.writeHead(200, { 'Content-Length': payloads[index].length })
    if (index === 1 && counts[index] === 1) {
      response.write(payloads[index].subarray(0, 5))
      setImmediate(() => response.destroy())
    } else response.end(payloads[index])
  })
  assert.equal((await updater.check()).phase, 'available')
  assert.equal((await updater.download()).phase, 'ready')
  assert.deepEqual(counts, [1, 2])
  assert.deepEqual(await fs.readFile(updater.ready.filename), Buffer.concat(payloads))
  assert(states.some(state => state.phase === 'downloading' && state.total === Buffer.concat(payloads).length))
  assert.equal((await updater.check()).phase, 'ready')
  updater.cancel()
  assert.deepEqual(await fs.readFile(updater.ready.filename), Buffer.concat(payloads))
  await assert.rejects(updater.install(), /先结束远程连接/)
  assert.equal(updater.getState().code, 'connection')
})

test('wrong bytes never become ready and a later explicit retry starts cleanly', async t => {
  let corrupt = true
  const value = manifest()
  const { updater, directory } = await fixture(t, (request, response) => {
    if (request.url.endsWith('latest.json')) return sendJSON(response, envelope(value))
    const index = Number(/asset-(\d)/.exec(request.url)[1])
    const bytes = corrupt ? Buffer.alloc(payloads[index].length, 65) : payloads[index]
    response.end(bytes)
  })
  await updater.check()
  await assert.rejects(updater.download(), /校验失败/)
  assert.equal(updater.ready, null)
  assert.deepEqual(await fs.readdir(path.join(directory, 'updates')), ['highest-version.json'])
  corrupt = false
  await updater.download()
  assert.equal(updater.getState().phase, 'ready')
  assert.deepEqual(await fs.readFile(updater.ready.filename), Buffer.concat(payloads))
})

test('older signed releases are rejected relative to the running and already observed versions', async t => {
  let version = '0.1.0'
  const { updater } = await fixture(t, (_request, response) => sendJSON(response, envelope(manifest(version))))
  await assert.rejects(updater.check(), /早于/)
  version = '0.4.0'
  await updater.check()
  version = '0.3.0'
  await assert.rejects(updater.check(), /早于/)
  assert.equal(updater.manifest.version, '0.4.0')
  const restarted = new Updater({ app: updater.app, request: updater.request, publicKey, platform: 'darwin' })
  await assert.rejects(restarted.check(), /早于/)
})

test('modified or missing staged installers can be downloaded again instead of looping in ready', async t => {
  const { updater } = await fixture(t, (request, response) => {
    if (request.url.endsWith('latest.json')) return sendJSON(response, envelope(manifest()))
    response.end(payloads[Number(/asset-(\d)/.exec(request.url)[1])])
  })
  updater.canInstall = () => true
  await updater.check()
  for (const missing of [false, true]) {
    await updater.download()
    const staged = updater.ready.directory
    if (missing) await fs.unlink(updater.ready.filename)
    else await fs.writeFile(updater.ready.filename, Buffer.alloc(Buffer.concat(payloads).length, 65))
    await assert.rejects(updater.install(), /校验失败/)
    assert.equal(updater.ready, null)
    await assert.rejects(fs.access(staged))
    assert.equal((await updater.check()).phase, 'available')
  }
  assert.equal((await updater.download()).phase, 'ready')
})

test('redirects cannot escape the release hosts and metadata responses are bounded', async t => {
  let oversized = false, requests = 0
  const { updater } = await fixture(t, (request, response) => {
    requests++
    if (request.url.endsWith('latest.json')) {
      if (oversized) return response.end(' '.repeat(128 * 1024 + 1))
      return sendJSON(response, envelope(manifest()))
    }
    response.writeHead(302, { Location: 'https://attacker.example/download' }); response.end()
  })
  await updater.check()
  await assert.rejects(updater.download(), /无法获取更新/)
  assert.equal(requests, 4) // One feed and three bounded download attempts.
  oversized = true
  await assert.rejects(updater.check(), /验证失败/)
})

test('quitting cancels an active stream, cleans partial data and blocks concurrent operations', async t => {
  let began
  const started = new Promise(resolve => { began = resolve })
  const { updater, directory } = await fixture(t, (request, response) => {
    if (request.url.endsWith('latest.json')) return sendJSON(response, envelope(manifest()))
    response.write(payloads[0].subarray(0, 5)); began()
  })
  await updater.check()
  const downloading = updater.download()
  await started
  await assert.rejects(updater.check(), /正在进行/)
  updater.cancel()
  await assert.rejects(downloading, /已取消/)
  assert.equal(updater.getState().code, 'cancelled')
  assert.deepEqual(await fs.readdir(path.join(directory, 'updates')), ['highest-version.json'])
})

for (const failLaunch of [true, false]) test('macOS installer ' + (failLaunch ? 'rolls back a failed launch' : 'replaces and cleans a successful update') + ' using isolated fake bundles', { skip: process.platform === 'win32' }, async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-install-test-'))
  t.after(() => fs.rm(directory, { recursive: true, force: true }))
  const target = path.join(directory, 'CC Connect.app')
  const staging = path.join(directory, '.cc-connect-update-test')
  const nextApp = path.join(staging, 'CC Connect.app')
  const results = path.join(directory, 'updates')
  for (const [bundle, version] of [[target, '0.2.0'], [nextApp, '0.3.0']]) {
    await fs.mkdir(path.join(bundle, 'Contents'), { recursive: true })
    await fs.writeFile(path.join(bundle, 'Contents', 'Info.plist'), version)
  }
  await fs.mkdir(results)
  const plistStub = path.join(directory, 'plist-stub')
  const openStub = path.join(directory, 'open-stub')
  const signatureStub = path.join(directory, 'signature-stub')
  await fs.writeFile(plistStub, '#!/bin/sh\ncase "$2" in *Identifier) printf "app.jianping.desktop\\n" ;; *) /bin/cat "$3";; esac\n', { mode: 0o700 })
  await fs.writeFile(openStub, failLaunch ? '#!/bin/sh\n[ "$(/bin/cat "$2/Contents/Info.plist")" = "0.2.0" ]\n' : '#!/bin/sh\nexit 0\n', { mode: 0o700 })
  await fs.writeFile(signatureStub, '#!/bin/sh\nexit 0\n', { mode: 0o700 })
  let script = await fs.readFile(path.join(__dirname, '..', 'scripts', 'install-update-mac.sh'), 'utf8')
  // Replace only absolute platform tools and the allow-listed install target in
  // this temporary copy. The shipped helper never accepts arbitrary targets.
  script = script.replace("'/Applications/CC Connect.app'", "'" + target + "'")
    .replaceAll('/usr/libexec/PlistBuddy', plistStub).replaceAll('/usr/bin/codesign', signatureStub).replaceAll('/usr/bin/open', openStub)
  const helper = path.join(staging, 'install.sh')
  await fs.writeFile(helper, script)
  const install = exec('/bin/sh', [helper, '99999999', target, staging, '0.2.0', '0.3.0', path.join(results, 'install-result.json')])
  if (failLaunch) await assert.rejects(install)
  else await install
  assert.equal(await fs.readFile(path.join(target, 'Contents', 'Info.plist'), 'utf8'), failLaunch ? '0.2.0' : '0.3.0')
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(results, 'install-result.json'), 'utf8')), { ok: !failLaunch })
  await assert.rejects(fs.access(path.join(directory, '.cc-connect-install.lock')))
  await assert.rejects(fs.access(staging))
})
