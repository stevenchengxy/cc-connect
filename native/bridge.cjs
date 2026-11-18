const { EventEmitter } = require('node:events');
const { execFile, spawn } = require('node:child_process');
const path = require('node:path');
const { createInterface } = require('node:readline');
const keyMaps = require('./keys.cjs');

function binaryPath({ isPackaged, resourcesPath } = {}) {
  const packaged = isPackaged ?? (__dirname.includes('app.asar' + path.sep));
  const root = packaged ? path.join(resourcesPath ?? process.resourcesPath, 'native') : __dirname;
  return path.join(root, 'bin', process.platform === 'win32' ? 'jianping-input.exe' : 'jianping-input');
}

function displayArgs(display) {
  if (process.platform === 'darwin' && Number.isSafeInteger(display?.id) && display.id > 0) {
    return [String(display.id)];
  }
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

class InputBridge extends EventEmitter {
  constructor() {
    super();
    this.session = null;
    this.closing = Promise.resolve();
    this.revision = 0;
  }

  async checkPermission(options) {
    if (!keyMaps[process.platform]) return false;
    return new Promise(resolve => {
      execFile(binaryPath(options), ['--check'], { timeout: 4000, windowsHide: true }, (err, stdout) => {
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
    const child = spawn(binaryPath(options), args, {
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
    // Dropping release events could leave keys pressed. Close and reset on overload.
    if (session.child.stdin.writableLength > 4096) {
      this.stop();
      this.emit('error', new Error('键鼠输入积压，已停止控制。'));
      return false;
    }
    session.child.stdin.write(line + '\n');
    return true;
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

module.exports = { InputBridge, encodeInput };
