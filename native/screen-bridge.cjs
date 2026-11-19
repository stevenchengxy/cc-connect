'use strict'

const { EventEmitter } = require('node:events')
const { spawn } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')

function supportsNativePicker(platform, systemVersion) {
  const [major, minor] = String(systemVersion).split('.').map(Number)
  return platform === 'darwin' && (major > 15 || (major === 15 && minor >= 2))
}

function helperExecutable({ isPackaged, resourcesPath }) {
  const root = isPackaged ? path.join(resourcesPath, 'native') : __dirname
  return path.join(root, 'bin', 'CC Connect Screen.app', 'Contents', 'MacOS', 'cc-connect-screen')
}

function nativeHelperAvailable(options) {
  const executable = helperExecutable(options)
  const info = path.join(path.dirname(executable), '..', 'Info.plist')
  try {
    fs.accessSync(executable, fs.constants.X_OK)
    fs.accessSync(info, fs.constants.R_OK)
    return fs.statSync(executable).isFile() && fs.statSync(info).isFile()
  } catch { return false }
}

class FrameReader {
  constructor(onFrame) {
    this.onFrame = onFrame
    this.header = Buffer.alloc(16)
    this.offset = 0
    this.body = null
    this.display = null
  }

  write(chunk) {
    let start = 0
    while (start < chunk.length) {
      const target = this.body || this.header
      const count = Math.min(target.length - this.offset, chunk.length - start)
      chunk.copy(target, this.offset, start, start + count)
      this.offset += count
      start += count
      if (this.offset !== target.length) continue
      this.offset = 0
      if (this.body) {
        const bytes = this.body
        this.body = null
        if (bytes.readUInt16BE() !== 0xffd8 || bytes.readUInt16BE(bytes.length - 2) !== 0xffd9) {
          throw new Error('native-picker-failed')
        }
        this.onFrame({ ...this.display, bytes })
        continue
      }
      const displayId = target.readUInt32BE(0)
      const width = target.readUInt32BE(4)
      const height = target.readUInt32BE(8)
      const length = target.readUInt32BE(12)
      if (!displayId || !width || !height || Math.max(width, height) > 1920 ||
          Math.min(width, height) > 1080 || length < 4 || length > 2 * 1024 * 1024) {
        throw new Error('native-picker-failed')
      }
      if (this.display && (displayId !== this.display.displayId || width !== this.display.width || height !== this.display.height)) {
        throw new Error('native-picker-ended')
      }
      this.display = { displayId, width, height }
      // Exactly the payload's own ArrayBuffer crosses Electron's clone boundary.
      this.body = Buffer.allocUnsafeSlow(length)
    }
  }
}

// Each instance belongs to one local gesture and one picker. Reading is paced
// by renderer acknowledgements, so a slow decoder never builds an IPC queue.
class NativeScreenCapture extends EventEmitter {
  constructor({ isPackaged, resourcesPath, showCursor = true, spawnProcess = spawn, isRestricted = () => false }) {
    super()
    this.executable = helperExecutable({ isPackaged, resourcesPath })
    this.spawnProcess = spawnProcess
    this.isRestricted = isRestricted
    this.showCursor = showCursor
    this.closed = false
    this.credit = false
    this.latest = null
  }

  start() {
    if (this.started || this.closed) return Promise.reject(new Error('native-picker-failed'))
    this.started = true
    return new Promise((resolve, reject) => {
      this.rejectFirst = reject
      const checkPolicy = () => {
        if (this.isRestricted()) this.stop('permission-restricted')
      }
      checkPolicy()
      if (this.closed) return
      // The desktop may be static, with no further frames or renderer credits.
      this.policyTimer = setInterval(checkPolicy, 1000)
      this.policyTimer.unref()
      const reader = new FrameReader(frame => {
        if (this.closed) return
        if (this.rejectFirst) {
          this.rejectFirst = null
          clearTimeout(this.timer)
          resolve({ ...reader.display })
        }
        this.latest = frame
        this.deliver()
        if (!this.credit) this.child.stdout.pause()
      })
      this.timer = setTimeout(() => this.stop('native-picker-failed'), 85_000)
      this.timer.unref()
      let child
      try {
        const args = ['--pick-display']
        if (!this.showCursor) args.push('--omit-cursor')
        this.child = child = this.spawnProcess(this.executable, args, { stdio: ['pipe', 'pipe', 'ignore'] })
      } catch {
        this.stop('native-picker-failed')
        return
      }
      const ended = code => {
        this.exited = true
        clearTimeout(this.killTimer)
        const reason = { 2: 'native-picker-unsupported', 3: 'native-picker-cancelled', 5: 'native-picker-ended' }[code]
        this.stop(reason || 'native-picker-failed')
      }
      child.on('error', () => this.stop('native-picker-failed'))
      child.once('exit', ended)
      child.once('close', ended)
      child.stdin.on('error', () => {})
      child.stdout.on('error', () => this.stop('native-picker-failed'))
      child.stdout.on('data', chunk => {
        if (this.closed) return
        try { reader.write(chunk) } catch (error) { this.stop(error.message) }
      })
    })
  }

  requestFrame() {
    if (this.closed || this.credit || this.rejectFirst || !this.child) return false
    this.credit = true
    if (this.latest) this.deliver()
    else this.child.stdout.resume()
    return true
  }

  deliver() {
    if (!this.credit || !this.latest) return
    const frame = this.latest
    this.latest = null
    this.credit = false
    this.emit('frame', frame)
  }

  restoreViewOnlyCursor() {
    if (this.closed || this.showCursor || !this.child?.stdin.writable) return
    this.showCursor = true
    this.child.stdin.write(Buffer.from([1]))
  }

  stop(reason = 'native-picker-cancelled') {
    if (this.closed) return
    this.closed = true
    clearTimeout(this.timer)
    clearInterval(this.policyTimer)
    this.latest = null
    if (this.child && !this.exited) {
      this.child.stdin.end()
      this.child.kill('SIGTERM')
      this.killTimer = setTimeout(() => this.child.kill('SIGKILL'), 1200)
      this.killTimer.unref()
    }
    if (this.rejectFirst) {
      this.rejectFirst(new Error(reason))
      this.rejectFirst = null
    }
    this.emit('ended', reason)
  }
}

module.exports = { supportsNativePicker, nativeHelperAvailable, NativeScreenCapture, FrameReader }
