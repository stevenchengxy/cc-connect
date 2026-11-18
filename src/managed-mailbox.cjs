'use strict';

const { messages, readJSON } = require('./account.cjs');
const { EventEmitter } = require('node:events');
const { createHash, createHmac, randomBytes } = require('node:crypto');
const { setTimeout: sleep } = require('node:timers/promises');

const MAX_PACKET = 160 * 1024;
const QUEUE_LIMIT = 4 * MAX_PACKET;
const OPEN = 1;
const CLOSED = 3;
const transient = status => status === 408 || status === 429 || status >= 500;

const unreachable = '无法访问公网配对服务，请检查网络和系统代理后重试。';
function registrationFailure(response) {
  const messages = {
    403: '公网配对码验证失败，请重新复制共享端生成的完整配对码。',
    404: '找不到这份公网邀请，请在共享端重新生成配对码。',
    409: '这份公网邀请已被使用，请在共享端重新生成配对码。',
    410: '这份公网邀请已结束或过期，请在共享端重新生成配对码。',
    429: '公网配对服务暂时繁忙，请稍后重新生成配对码。'
  };
  if (response.headers.get('cf-mitigated') === 'challenge' ||
      (response.status === 403 && response.headers.get('content-type')?.includes('text/html'))) {
    return '公网配对服务拒绝了此次网络访问，请联系服务管理员。';
  }
  return messages[response.status] || unreachable;
}

function turnURL(value) {
  if (typeof value !== 'string' || value.length > 512) return false;
  const match = /^turns?:((?:[a-z0-9.-]+|\[[a-f0-9:]+\])(?::[0-9]{1,5})?)(?:\?transport=(?:tcp|udp))?$/i.exec(value);
  if (!match) return false;
  try { return new URL('https://' + match[1]).port !== '0'; }
  catch { return false; }
}

function iceServers(config) {
  if (!Array.isArray(config?.iceServers) || config.iceServers.length > 8) return [];
  const servers = [];
  for (const entry of config.iceServers) {
    if (!entry || ![entry.username, entry.credential].every(value =>
      typeof value === 'string' && value.length > 0 && value.length <= 1024 && !/[\u0000-\u001f\u007f]/.test(value))) continue;
    const candidates = typeof entry.urls === 'string' ? [entry.urls] : entry.urls;
    if (!Array.isArray(candidates) || candidates.length > 12) continue;
    const urls = candidates.filter(turnURL);
    if (urls.length) servers.push({ urls, username: entry.username, credential: entry.credential });
  }
  return servers;
}

class Mailbox extends EventEmitter {
  constructor(base, role, secret, fetchImpl, accountToken) {
    super();
    const url = new URL(base);
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw new Error('Invalid managed pairing service URL');
    const digest = purpose => createHmac('sha256', secret).update(purpose).digest('base64url');
    this.url = url.href.replace(/\/$/, '') + '/rooms/' + digest('rd1-managed-room') + '/' + role;
    const viewerProof = digest('rd1-managed-viewer-proof');
    this.proof = role === 'viewer' ? viewerProof : createHash('sha256').update(viewerProof).digest('hex');
    this.authorization = 'Bearer ' + randomBytes(32).toString('base64url');
    this.authHeaders = { authorization:this.authorization, ...(accountToken && { 'x-cc-session':accountToken }) };
    this.fetch = fetchImpl;
    this.role = role;
    this.sent = 0;
    this.received = 0;
    this.bufferedAmount = 0;
    this.queue = Promise.resolve();
    this.controller = new AbortController();
    this.readyState = 0;
    this.registered = false;
    this.active = false;
  }

  async request(method, suffix, opts = {}) {
    const signal = AbortSignal.any([this.controller.signal, AbortSignal.timeout(opts.timeout ?? 5500)]);
    const response = await this.fetch(this.url + suffix, {
      method, redirect: 'error', cache: 'no-store', signal,
      headers: { ...this.authHeaders, ...opts.headers }, credentials: 'omit', body: opts.body
    });
    if (this.authHeaders['x-cc-session'] && [401,403].includes(response.status) && response.headers.get('content-type')?.includes('application/json')) {
      const { error } = await readJSON(response).catch(() => ({}));
      if (['account_required','account_pending','account_suspended','account_revoked'].includes(error)) {
        this.accountError = messages[error];
        this.terminate();
      }
    }
    return response;
  }

  async ice() {
    if (!this.active || this.readyState !== OPEN) return [];
    try {
      this.iceUnavailable = false;
      this.iceExpiresAt = 0;
      const response = await this.retryRequest('GET', '/ice', { timeout: 7000 }, 2);
      if (response.status !== 200) {
        this.iceUnavailable = response.status !== 204;
        await response.body?.cancel();
        return [];
      }
      const chunks = [];
      let size = 0;
      for await (const bytes of response.body) {
        size += bytes.length;
        if (size > 16 * 1024) throw new Error('Invalid grant size');
        chunks.push(bytes);
      }
      const grant = JSON.parse(Buffer.concat(chunks, size));
      if (this.authHeaders['x-cc-session'] && (!Number.isSafeInteger(grant.expiresAt) || grant.expiresAt <= Date.now())) throw new Error('Expired grant');
      const servers = iceServers(grant);
      this.iceExpiresAt = Number.isSafeInteger(grant.expiresAt) ? grant.expiresAt : 0;
      this.iceUnavailable = servers.length === 0;
      return servers;
    } catch { this.iceUnavailable = true; return []; }
  }

  async register() {
    let response;
    try { response = await this.retryRequest('POST', '', { headers: { 'x-viewer-proof': this.proof } }, 2); }
    catch { throw new Error(this.accountError || unreachable); }
    await response.body?.cancel();
    if (response.status !== 201 && response.status !== 200) throw new Error(this.accountError || registrationFailure(response));
    this.registered = true;
    this.readyState = OPEN;
  }

  async retryRequest(method, suffix, opts, maxAttempts = 3) {
    for (let attempt = 0; ; attempt++) {
      try {
        const response = await this.request(method, suffix, opts);
        if (!transient(response.status) || attempt + 1 === maxAttempts) return response;
        await response.body?.cancel();
      } catch (error) {
        if (this.controller.signal.aborted || attempt + 1 === maxAttempts) throw error;
      }
      await sleep(250 * 2 ** attempt, undefined, { signal: this.controller.signal });
    }
  }

  async poll() {
    let delay = 0;
    try {
      while (this.readyState === OPEN) {
        if (delay) await sleep(delay, undefined, { signal: this.controller.signal });
        const response = await this.retryRequest('GET', '/messages/' + (this.received + 1));
        if (response.status === 204) {
          const idle = this.active ? 3500 : !this.received && this.role === 'host' ? 1400 : 500;
          delay = Math.min(idle, delay + 250);
          continue;
        }
        if (response.status !== 200) { await response.body?.cancel(); throw new Error('Mailbox closed'); }
        const chunks = [];
        let length = 0;
        for await (const bytes of response.body) {
          length += bytes.length;
          if (length > MAX_PACKET) throw new Error('Oversized signaling packet');
          chunks.push(bytes);
        }
        if (this.readyState !== OPEN) break;
        this.received++;
        this.emit('message', Buffer.concat(chunks, length), true);
        delay = 0;
      }
    } catch { this.terminate(); }
  }

  send(data) {
    if (this.readyState !== OPEN || this.bufferedAmount + data.length > QUEUE_LIMIT) throw new Error('连接已中断。');
    const sequence = ++this.sent;
    this.bufferedAmount += data.length;
    this.queue = this.queue.then(async () => {
      if (this.controller.signal.aborted) return;
      const response = await this.retryRequest('PUT', '/messages/' + sequence, { headers: { 'content-type': 'application/octet-stream' }, body: data });
      await response.body?.cancel();
      if (response.status !== 204) throw new Error('Mailbox send failed');
    }).catch(() => this.terminate()).finally(() => { this.bufferedAmount -= data.length; });
  }

  close() {
    // Flush an authenticated rejection before notifying the other endpoint.
    void this.queue.then(() => this.terminate());
  }

  terminate() {
    if (this.readyState === CLOSED) return;
    this.readyState = CLOSED;
    this.controller.abort();
    if (this.registered) {
      void this.fetch(this.url, {
        method: 'DELETE', headers: this.authHeaders, credentials:'omit',
        redirect: 'error', signal: AbortSignal.timeout(3000)
      }).then(response => response.body?.cancel()).catch(() => {});
    }
    this.emit('close');
  }
}

module.exports = { Mailbox };
