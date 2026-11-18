const fs = require('node:fs/promises')
const fsSync = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const https = require('node:https')
const { createHash, verify, createPublicKey } = require('node:crypto')
const { execFile, spawn } = require('node:child_process')
const { promisify } = require('node:util')

const FEED_URL = 'https://cc-connect-desktop.stevenchengxy19.chatgpt.site/updates/latest.json'
const MAX_FILE = 1024 * 1024 * 1024
const MAX_JSON = 128 * 1024
const RELEASE_PREFIX = '/stevenchengxy/cc-connect/releases/download/'
const exec = promisify(execFile)
const messages = {
  busy: '更新任务正在进行，请稍候。',
  network: '无法获取更新，请检查网络后重试。',
  invalid: '更新信息验证失败，请稍后重试。',
  rollback: '此更新版本早于已检查的版本，已取消更新。',
  unsupported: '此系统暂不支持应用内更新。',
  integrity: '更新文件校验失败，请重新下载。',
  download: '更新下载失败，请检查网络和可用磁盘空间后重试。',
  cancelled: '更新已取消。',
  connection: '请先结束远程连接，再安装更新。',
  location: '请先将 CC Connect 移到「应用程序」文件夹，再安装更新。',
  permission: '当前账户无法更新此应用，请检查「应用程序」文件夹的写入权限。',
  install: '安装更新失败，原应用已保留。请重试或下载安装包。',
  previous: '上次更新未能完成，已保留原应用。请重新下载更新。',
  notReady: '请先下载并验证更新。'
}
class UpdateError extends Error {
  constructor(code) { super(messages[code]); this.code = code }
}
const fail = code => { throw new UpdateError(code) }

function versionParts(version) {
  if (typeof version !== 'string' || version.length > 80) fail('invalid')
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/.exec(version)
  if (!match) fail('invalid')
  const main = match.slice(1, 4).map(Number)
  const pre = match[4]?.split('.') || []
  if (main.some(n => !Number.isSafeInteger(n)) || pre.some(p => /^\d+$/.test(p) && (p.length > 1 && p[0] === '0'))) fail('invalid')
  return { main, pre }
}
function compareVersions(left, right) {
  const a = versionParts(left), b = versionParts(right)
  for (let i = 0; i < 3; i++) if (a.main[i] !== b.main[i]) return Math.sign(a.main[i] - b.main[i])
  if (!a.pre.length || !b.pre.length) return Math.sign(b.pre.length - a.pre.length)
  for (let i = 0; i < Math.max(a.pre.length, b.pre.length); i++) {
    if (a.pre[i] === undefined) return -1
    if (b.pre[i] === undefined) return 1
    if (a.pre[i] === b.pre[i]) continue
    const numericA = /^\d+$/.test(a.pre[i]), numericB = /^\d+$/.test(b.pre[i])
    if (numericA && numericB) return BigInt(a.pre[i]) > BigInt(b.pre[i]) ? 1 : -1
    if (numericA !== numericB) return numericA ? -1 : 1
    return a.pre[i] > b.pre[i] ? 1 : -1
  }
  return 0
}
function secureURL(value) {
  let url
  try { url = new URL(value) } catch { fail('invalid') }
  if (url.protocol !== 'https:' || url.username || url.password || url.hash || (url.port && url.port !== '443')) fail('invalid')
  return url
}
function assetURL(value, version) {
  const url = secureURL(value)
  const site = new URL(FEED_URL)
  const github = url.hostname === 'github.com' && url.pathname.startsWith(RELEASE_PREFIX + 'v' + version + '/')
  const hosted = url.origin === site.origin && /^\/downloads\/[A-Za-z0-9._-]+$/.test(url.pathname)
  if ((!github && !hosted) || url.search || /%2f|%5c|%2e/i.test(url.pathname)) fail('invalid')
  return url.href
}
function redirectURL(value, initial) {
  const url = secureURL(value)
  const source = new URL(initial)
  if (source.hostname !== 'github.com') fail('network')
  const ownRelease = url.hostname === 'github.com' && url.pathname.startsWith(RELEASE_PREFIX)
  if (!ownRelease && !['release-assets.githubusercontent.com', 'objects.githubusercontent.com'].includes(url.hostname)) fail('network')
  return url.href
}
function decodeBase64(value, limit) {
  if (typeof value !== 'string' || value.length > limit * 2 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) fail('invalid')
  const buffer = Buffer.from(value, 'base64')
  if (!buffer.length || buffer.length > limit || buffer.toString('base64') !== value) fail('invalid')
  return buffer
}
function verifyManifest(envelope, publicKey) {
  if (!envelope || typeof envelope !== 'object') fail('invalid')
  const bytes = decodeBase64(envelope.payload, MAX_JSON)
  const signature = decodeBase64(envelope.signature, 64)
  const key = createPublicKey(publicKey)
  if (key.asymmetricKeyType !== 'ed25519' || signature.length !== 64 || !verify(null, bytes, key, signature)) fail('invalid')
  let manifest
  try { manifest = JSON.parse(bytes.toString('utf8')) } catch { fail('invalid') }
  versionParts(manifest?.version)
  if (!manifest.files || typeof manifest.files !== 'object') fail('invalid')
  for (const platform of ['mac', 'windows']) {
    const file = manifest.files[platform]
    if (!file || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,150}$/.test(file.name) ||
        !file.name.endsWith(platform === 'mac' ? '.dmg' : '.exe') ||
        !Number.isSafeInteger(file.size) || file.size < 1 || file.size > MAX_FILE ||
        !/^[a-f0-9]{64}$/.test(file.sha256) || !Array.isArray(file.parts) || !file.parts.length || file.parts.length > 256) fail('invalid')
    let total = 0
    for (const part of file.parts) {
      if (!part || !Number.isSafeInteger(part.size) || part.size < 1 || part.size > MAX_FILE || !/^[a-f0-9]{64}$/.test(part.sha256)) fail('invalid')
      part.url = assetURL(part.url, manifest.version)
      total += part.size
    }
    if (total !== file.size) fail('invalid')
  }
  return manifest
}
function requestHTTPS(url, { signal }) {
  return new Promise((resolve, reject) => {
    const request = https.get(url, { signal, maxHeaderSize: 16384, headers: { 'Accept-Encoding': 'identity', 'User-Agent': 'CC-Connect-Updater' } }, resolve)
    request.setTimeout(25000, () => request.destroy(new UpdateError('network')))
    request.on('error', reject)
  })
}
async function responseFor(url, signal, request, allowRedirects) {
  let next = url
  for (let count = 0; count <= 5; count++) {
    signal.throwIfAborted()
    const response = await request(next, { signal })
    if ([301, 302, 303, 307, 308].includes(response.statusCode)) {
      const location = response.headers.location
      response.destroy()
      if (!allowRedirects || count === 5 || !location) fail('network')
      next = redirectURL(new URL(location, next).href, url)
      continue
    }
    if (response.statusCode !== 200 || (response.headers['content-encoding'] && response.headers['content-encoding'] !== 'identity')) {
      response.destroy()
      fail('network')
    }
    return response
  }
}
async function hashFile(filename, signal) {
  const hash = createHash('sha256')
  let size = 0
  for await (const buffer of fsSync.createReadStream(filename)) { signal?.throwIfAborted(); size += buffer.length; hash.update(buffer) }
  return { size, sha256: hash.digest('hex') }
}
async function assertFile(filename, expected, signal) {
  const stat = await fs.lstat(filename)
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== expected.size) fail('integrity')
  const actual = await hashFile(filename, signal)
  if (actual.size !== expected.size || actual.sha256 !== expected.sha256) fail('integrity')
}
async function launchDetached(command, args) {
  const child = spawn(command, args, { detached: true, windowsHide: true, stdio: 'ignore' })
  await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject) })
  child.unref()
}

class Updater {
  constructor({ app, emit = () => {}, canInstall = () => false, request = requestHTTPS, publicKey, platform = process.platform }) {
    this.app = app
    this.emit = emit
    this.canInstall = canInstall
    this.request = request
    this.publicKey = publicKey
    this.platform = platform
    this.root = path.join(app.getPath('userData'), 'updates')
    this.state = { phase: 'idle', currentVersion: app.getVersion() }
    this.highestVersion = app.getVersion()
    try {
      const recorded = JSON.parse(fsSync.readFileSync(path.join(this.root, 'highest-version.json'), 'utf8')).version
      if (compareVersions(recorded, this.highestVersion) > 0) this.highestVersion = recorded
    } catch { /* A first launch has no persisted version floor. */ }
    this.manifest = null
    this.ready = null
    this.operation = null
    this.controller = null
    const resultFile = path.join(this.root, 'install-result.json')
    try {
      const result = JSON.parse(fsSync.readFileSync(resultFile, 'utf8'))
      if (result.ok === false) this.state = { ...this.state, phase: 'error', code: 'previous', message: messages.previous }
      fsSync.unlinkSync(resultFile)
    } catch { /* A missing completion marker is the normal first launch. */ }
  }
  getState() { return { ...this.state } }
  setState(phase, details = {}) {
    this.state = { phase, currentVersion: this.app.getVersion(), ...details }
    this.emit(this.getState())
    return this.getState()
  }
  run(phase, task) {
    if (this.operation) return Promise.reject(new UpdateError('busy'))
    this.controller = new AbortController()
    const signal = this.controller.signal
    this.setState(phase, { version: this.manifest?.version })
    this.operation = Promise.resolve().then(() => task(signal)).catch(error => {
      const code = signal.aborted ? 'cancelled' : error instanceof UpdateError ? error.code :
        ['EACCES', 'EPERM', 'EROFS'].includes(error.code) ? 'permission' : phase === 'downloading' ? 'download' : phase === 'installing' ? 'install' : 'network'
      this.setState('error', { code, message: messages[code], version: this.manifest?.version })
      throw new UpdateError(code)
    }).finally(() => { this.operation = null; this.controller = null })
    return this.operation
  }
  cancel() { this.controller?.abort() }
  check() {
    return this.run('checking', async signal => {
      if (!['darwin', 'win32'].includes(this.platform)) fail('unsupported')
      const response = await responseFor(FEED_URL, signal, this.request, false)
      const buffers = []
      let total = 0
      for await (const data of response) {
        total += data.length
        if (total > MAX_JSON) { response.destroy(); fail('invalid') }
        buffers.push(data)
      }
      signal.throwIfAborted()
      let envelope
      try { envelope = JSON.parse(Buffer.concat(buffers).toString('utf8')) } catch { fail('invalid') }
      const publicKey = this.publicKey || await fs.readFile(path.join(__dirname, 'update-public-key.pem'), 'utf8')
      const manifest = verifyManifest(envelope, publicKey)
      const comparison = compareVersions(manifest.version, this.app.getVersion())
      if (comparison < 0 || compareVersions(manifest.version, this.highestVersion) < 0) fail('rollback')
      if (comparison === 0) return this.setState('current')
      await fs.mkdir(this.root, { recursive: true, mode: 0o700 })
      const recorded = path.join(this.root, 'highest-version.json')
      await fs.writeFile(recorded + '.tmp', JSON.stringify({ version: manifest.version }), { mode: 0o600 })
      await fs.rename(recorded + '.tmp', recorded)
      this.highestVersion = manifest.version
      if (this.ready && this.manifest?.version === manifest.version &&
          this.fileFor(manifest).sha256 === this.fileFor(this.manifest).sha256) {
        this.manifest = manifest
        return this.setState('ready', { version: manifest.version })
      }
      if (this.ready) { await fs.rm(this.ready.directory, { recursive: true, force: true }); this.ready = null }
      this.manifest = manifest
      return this.setState('available', { version: manifest.version, total: this.fileFor(manifest).size })
    })
  }
  fileFor(manifest) { return manifest.files[this.platform === 'darwin' ? 'mac' : 'windows'] }
  download() {
    return this.run('downloading', async signal => {
      if (!this.manifest || compareVersions(this.manifest.version, this.app.getVersion()) <= 0) fail('notReady')
      if (this.ready) return this.setState('ready', { version: this.manifest.version })
      const file = this.fileFor(this.manifest)
      await fs.mkdir(this.root, { recursive: true, mode: 0o700 })
      const directory = await fs.mkdtemp(path.join(this.root, 'download-'))
      const filename = path.join(directory, file.name)
      let output
      let offset = 0, lastProgress = 0
      try {
        output = await fs.open(filename, 'wx', 0o600)
        for (const part of file.parts) {
          let complete = false
          for (let attempt = 0; attempt < 3 && !complete; attempt++) {
            signal.throwIfAborted()
            await output.truncate(offset)
            const hash = createHash('sha256')
            let received = 0
            try {
              const response = await responseFor(part.url, signal, this.request, true)
              const declared = response.headers['content-length']
              if (declared !== undefined && Number(declared) !== part.size) { response.destroy(); fail('integrity') }
              for await (const data of response) {
                signal.throwIfAborted()
                if (received + data.length > part.size) { response.destroy(); fail('integrity') }
                let written = 0
                while (written < data.length) {
                  const result = await output.write(data, written, data.length - written, offset + received + written)
                  if (result.bytesWritten === 0) fail('download')
                  written += result.bytesWritten
                }
                received += data.length
                hash.update(data)
                if (Date.now() - lastProgress > 100) {
                  lastProgress = Date.now()
                  this.setState('downloading', { version: this.manifest.version, downloaded: offset + received, total: file.size, progress: (offset + received) / file.size })
                }
              }
              if (received !== part.size || hash.digest('hex') !== part.sha256) fail('integrity')
              complete = true
            } catch (error) {
              if (signal.aborted || attempt === 2 || ['ENOSPC', 'EACCES', 'EPERM'].includes(error.code)) throw error
            }
          }
          offset += part.size
        }
        await output.sync()
        await output.close()
        signal.throwIfAborted()
        await assertFile(filename, file, signal)
        this.ready = { directory, filename }
        return this.setState('ready', { version: this.manifest.version, downloaded: file.size, total: file.size, progress: 1 })
      } catch (error) {
        await output?.close().catch(() => {})
        await fs.rm(directory, { recursive: true, force: true })
        throw error
      }
    })
  }
  install() {
    return this.run('installing', async signal => {
      if (!this.ready || !this.manifest || compareVersions(this.manifest.version, this.app.getVersion()) <= 0) fail('notReady')
      if (!this.canInstall()) fail('connection')
      if (!this.app.isPackaged) fail('location')
      try {
        await assertFile(this.ready.filename, this.fileFor(this.manifest), signal)
      } catch (error) {
        if (error.code === 'integrity' || ['ENOENT', 'ENOTDIR'].includes(error.code)) {
          const directory = this.ready.directory
          this.ready = null
          await fs.rm(directory, { recursive: true, force: true })
          fail('integrity')
        }
        throw error
      }
      signal.throwIfAborted()
      if (this.platform === 'darwin') await this.installMac(signal)
      else if (this.platform === 'win32') {
        if (!this.canInstall()) fail('connection')
        await launchDetached(this.ready.filename, ['/S', '--updated', '--force-run'])
      } else fail('unsupported')
      // The caller quits only after handoff succeeds. cancel() on before-quit
      // aborts pending requests without deleting files used by the installer.
      return this.getState()
    })
  }
  async installMac(signal) {
    const target = path.resolve(path.dirname(this.app.getPath('exe')), '../..')
    const allowed = ['/Applications/CC Connect.app', path.join(os.homedir(), 'Applications', 'CC Connect.app')]
    if (!allowed.includes(target) || await fs.realpath(target) !== target) fail('location')
    await fs.access(path.dirname(target), fsSync.constants.W_OK | fsSync.constants.X_OK)
    const staging = await fs.mkdtemp(path.join(path.dirname(target), '.cc-connect-update-'))
    const nextApp = path.join(staging, 'CC Connect.app')
    const mount = path.join(this.ready.directory, 'mount')
    const command = (name, args, timeout = 60000) => exec(name, args, { signal, timeout, maxBuffer: MAX_JSON })
    let mounted = false, handedOff = false
    try {
      await fs.mkdir(mount, { recursive: true })
      const result = await command('/usr/bin/hdiutil', ['attach', '-readonly', '-nobrowse', '-noautoopen', '-plist', '-mountpoint', mount, this.ready.filename])
      mounted = true
      const plist = path.join(this.ready.directory, 'mount.plist')
      await fs.writeFile(plist, result.stdout, { mode: 0o600 })
      const decoded = JSON.parse((await command('/usr/bin/plutil', ['-convert', 'json', '-o', '-', plist])).stdout)
      if (!decoded['system-entities']?.some(item => item['mount-point'] === mount)) fail('install')
      const source = path.join(mount, 'CC Connect.app')
      const stat = await fs.lstat(source)
      if (!stat.isDirectory() || stat.isSymbolicLink()) fail('install')
      const bundle = path.join(source, 'Contents', 'Info.plist')
      const identifier = (await command('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleIdentifier', bundle])).stdout.trim()
      const version = (await command('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleShortVersionString', bundle])).stdout.trim()
      if (identifier !== 'app.jianping.desktop' || version !== this.manifest.version) fail('install')
      await command('/usr/bin/codesign', ['--verify', '--deep', '--strict', source])
      await command('/usr/bin/ditto', [source, nextApp], 180000)
      await command('/usr/bin/codesign', ['--verify', '--deep', '--strict', nextApp])
      await exec('/usr/bin/hdiutil', ['detach', mount], { timeout: 30000, maxBuffer: MAX_JSON })
      mounted = false
      const script = path.join(staging, 'install.sh')
      await fs.copyFile(path.join(process.resourcesPath, 'install-update-mac.sh'), script)
      await fs.chmod(script, 0o700)
      signal.throwIfAborted()
      if (!this.canInstall()) fail('connection')
      await launchDetached('/bin/sh', [script, String(process.pid), target, staging, this.app.getVersion(), this.manifest.version, path.join(this.root, 'install-result.json')])
      handedOff = true
    } finally {
      if (mounted || signal.aborted) await exec('/usr/bin/hdiutil', ['detach', mount], { timeout: 30000, maxBuffer: MAX_JSON }).catch(() => {})
      if (!handedOff) await fs.rm(staging, { recursive: true, force: true })
    }
  }
}

module.exports = { Updater, verifyManifest, compareVersions, messages }
