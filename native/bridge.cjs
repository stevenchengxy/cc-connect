const { EventEmitter } = require('node:events');
const { execFile, spawn } = require('node:child_process');
const path = require('node:path');
const { createInterface } = require('node:readline');
const keyMaps = require('./keys.cjs');

function binaryPath(filename, { isPackaged, resourcesPath } = {}) {
  const packaged = isPackaged ?? (__dirname.includes('app.asar' + path.sep));
  const root = packaged ? path.join(resourcesPath ?? process.resourcesPath, 'native') : __dirname;
  return path.join(root, 'bin', filename);
}

function displayArgs(display) {
  if (process.platform === 'win32' && display?.bounds) {
    const bounds = require('electron').screen.dipToScreenRect(null, display.bounds);
    const numbers = [bounds.x, bounds.y, bounds.width, bounds.height];
    if (numbers.every(Number.isSafeInteger) && bounds.width > 0 && bounds.height > 0) {
      return numbers.map(String);
    }
  }
  throw new Error('无法为所选显示器启用键鼠控制。');
}

function encodeInput(data, platform = process.platform) {
  if (!data || typeof data !== 'object') return null;
  if (data.kind === 'reset') return 'reset';
  if (data.kind === 'key') {
    const code = keyMaps[platform]?.get(data.code);
    if (code === undefined || typeof data.down !== 'boolean') return null;
    return ['key', code, Number(data.down)].join(' ');
  }
  const { x, y } = data;
  if (![x, y].every(n => Number.isFinite(n) && n >= 0 && n <= 1)) return null;
  // Fixed point keeps the helper's wire format locale independent and bounded.
  const position = x.toFixed(6) + ' ' + y.toFixed(6);
  if (data.kind === 'move') return 'move ' + position;
  if (data.kind === 'button') {
    if (![0, 1, 2].includes(data.button) || typeof data.down !== 'boolean') return null;
    return ['button', data.button, Number(data.down), position].join(' ');
  }
  if (data.kind === 'wheel') {
    if (![data.dx, data.dy].every(Number.isFinite)) return null;
    const deltas = [data.dx, data.dy].map(n => Math.round(Math.max(-1000, Math.min(1000, n))));
    if (deltas.every(n => n === 0)) return null;
    return ['wheel', ...deltas, position].join(' ');
  }
  return null;
}

function loadMacInput(options) {
  return require(binaryPath('cc-mac-input.node', options));
}

// A permission dialog belongs to the application. Only the originating live
// input session may act on its result. Other checks remain prompt-free.
const permissionRequests = new WeakMap();
function requestMacAccess(native) {
  let pending = permissionRequests.get(native);
  if (!pending) {
    pending = Promise.resolve(native.access(true)).finally(() => permissionRequests.delete(native));
    permissionRequests.set(native, pending);
  }
  return pending;
}

function waitForMacAccess(native, session) {
  let timeout;
  return new Promise((resolve, reject) => {
    if (session) session.cancel = () => reject(new Error('键鼠授权已取消。'));
    timeout = setTimeout(() => reject(new Error('键鼠服务启动超时。')), 120_000);
    requestMacAccess(native).then(resolve, reject);
  }).finally(() => {
    clearTimeout(timeout);
    if (session) session.cancel = null;
  });
}

class MacInputBridge extends EventEmitter {
  constructor(loadNative = loadMacInput) {
    super();
    this.loadNative = loadNative;
    this.session = null;
  }

  static async macAccess(options, request = false, loadNative = loadMacInput) {
    try {
      const native = loadNative(options);
      const allowed = native.access(false) || (request === true && await waitForMacAccess(native));
      return allowed ? 'granted' : 'denied';
    } catch {
      return 'unknown';
    }
  }

  async checkPermission(options) {
    try { return this.loadNative(options).access(false); }
    catch { return false; }
  }

  async start(display, options) {
    if (this.session) throw new Error('已有键鼠控制会话。');
    if (!Number.isSafeInteger(display?.id) || display.id <= 0 || display.id > 0xffffffff) {
      throw new Error('无法为所选显示器启用键鼠控制。');
    }
    let native;
    try { native = this.loadNative(options); }
    catch { throw new Error('键鼠服务启动失败，请检查应用是否安装完整。'); }
    const session = this.session = {native, ready:false, cancel:null};
    try {
      if (options?.requestAccess === true && !native.access(false)) {
        await waitForMacAccess(native, session);
        if (this.session !== session) throw new Error('键鼠授权已取消。');
      }
      // start() verifies the selected display and this process's effective access.
      native.start(display.id);
      session.ready = true;
    } catch (error) {
      if (this.session === session) this.session = null;
      throw error;
    }
  }

  send(data) {
    const session = this.session;
    if (!session?.ready) return false;
    const line = encodeInput(data);
    if (line === null) return false;
    session.native.send(line);
    return true;
  }

  recheckAccess() {
    const session = this.session;
    if (!session?.ready) return;
    try { session.native.send('check-access'); }
    catch (error) {
      this.stop();
      this.emit('error', error);
    }
  }

  async stop() {
    const session = this.session;
    if (!session) return;
    this.session = null;
    session.cancel?.();
    if (session.ready) session.native.stop();
  }
}

class WindowsInputBridge extends EventEmitter {
  constructor() {
    super();
    this.session = null;
    this.closing = Promise.resolve();
    this.revision = 0;
  }

  async checkPermission(options) {
    if (!keyMaps[process.platform]) return false;
    return new Promise(resolve => {
      execFile(binaryPath('jianping-input.exe', options), ['--check'], { timeout: 4000, windowsHide: true }, (err, stdout) => {
        resolve(!err && stdout.trim() === 'ALLOWED');
      });
    });
  }

  async start(display, options) {
    if (!keyMaps[process.platform]) throw new Error('此系统暂不支持被控键鼠。');
    const revision = ++this.revision;
    if (this.session) throw new Error('已有键鼠控制会话。');
    await this.closing;
    if (revision !== this.revision) throw new Error('键鼠授权已取消。');
    const args = displayArgs(display);
    const child = spawn(binaryPath('jianping-input.exe', options), args, {
      stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true,
    });
    const session = { child, ready: false, stopping: false, message: '', closed: null };
    this.session = session;
    const lines = createInterface({ input: child.stdout });
    session.closed = new Promise(resolve => child.once('close', resolve));
    await new Promise((resolve, reject) => {
      let settled = false;
      const fail = message => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        reject(new Error(message));
      };
      const timeout = setTimeout(() => {
        fail('键鼠服务启动超时。');
        this.stop();
      }, 6000);
      lines.on('line', line => {
        if (line.startsWith('ERROR ')) session.message = line.slice(6, 300);
        if (line === 'READY' && !settled && !session.stopping && this.session === session) {
          session.ready = true;
          settled = true;
          clearTimeout(timeout);
          resolve();
        }
      });
      child.on('error', () => { session.message = '键鼠服务启动失败，请检查应用是否安装完整。'; });
      child.stdin.on('error', () => {
        // EPIPE races with process exit. The close handler reports the outcome.
      });
      child.once('close', () => {
        lines.close();
        if (this.session === session) this.session = null;
        if (!session.ready) {
          fail(session.stopping ? '键鼠授权已取消。' : session.message || '键鼠服务未能启动。');
        } else if (!session.stopping) {
          this.emit('error', new Error(session.message || '键鼠服务已结束。'));
        }
      });
    });
  }

  send(data) {
    const session = this.session;
    if (!session?.ready || session.stopping || !session.child.stdin.writable) return false;
    const line = encodeInput(data);
    if (line === null) return false;
    const stdin = session.child.stdin;
    if (data.kind === 'move') {
      // A burst after network jitter needs only its most recent position.
      // Keep at most one move waiting behind the active pipe write.
      if (session.writingMove) session.pendingMove = line;
      else this.writeMove(session, line);
      return true;
    }
    // Preserve positions on opposite sides of key/button transitions and
    // prevent old write callbacks from replaying a pre-click position.
    session.writingMove = null;
    if (session.pendingMove && (data.kind === 'key' || data.kind === 'wheel')) stdin.write(session.pendingMove + '\n');
    session.pendingMove = null;
    // Dropping release events could leave keys pressed. Close and reset on overload.
    if (session.child.stdin.writableLength > 4096) {
      this.stop();
      this.emit('error', new Error('键鼠输入积压，已停止控制。'));
      return false;
    }
    stdin.write(line + '\n');
    return true;
  }

  writeMove(session, line) {
    const written = () => {
      if (this.session !== session || session.stopping || session.writingMove !== written) return;
      session.writingMove = null;
      const next = session.pendingMove;
      session.pendingMove = null;
      if (next && session.child.stdin.writable) this.writeMove(session, next);
    };
    session.writingMove = written;
    session.child.stdin.write(line + '\n', written);
  }

  stop() {
    ++this.revision;
    const session = this.session;
    if (!session) return this.closing;
    this.session = null;
    session.stopping = true;
    session.ready = false;
    // EOF also reaches the helper if the parent is killed. Each helper releases
    // exactly its own held inputs in the EOF path, including during startup.
    session.child.stdin.end();
    const timeout = setTimeout(() => session.child.kill(), 2000);
    timeout.unref();
    this.closing = session.closed.finally(() => clearTimeout(timeout));
    return this.closing;
  }
}

const InputBridge = process.platform === 'darwin' ? MacInputBridge : WindowsInputBridge;
module.exports = { InputBridge, MacInputBridge, WindowsInputBridge, encodeInput };
