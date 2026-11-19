'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const {setTimeout: sleep} = require('node:timers/promises');
const { createHash, createHmac, createCipheriv, createDecipheriv, randomBytes, randomUUID } = require('node:crypto');
const { formatPairCode, makePairCode, normalizePairCode, pairSecret } = require('./pair-code.cjs');
const { messages, readJSON, validToken } = require('./account.cjs');

const invalid = '配对邀请格式无效，请复制完整邀请。';
const unavailable = '共享端未开启共享，或固定码已更换。请确认后重试。';
const conflict = '固定码无法发布，请在设置中更换固定码后重试。';
const offline = '无法访问公网配对服务，请检查网络和系统代理后重试。';
const storageError = '无法使用系统安全凭据存储，请解锁钥匙串后重试。';
const rateLimited = '配对请求过于频繁，请稍后用同一个配对码重试。';
const maxEnvelope = 1200;
const operations = new Map();

function normalizeDeviceCode(value) {
  if (typeof value !== 'string' || value.length > 64 || !/^[a-zA-Z2-9\s-]+$/.test(value)) return null;
  const compact = value.replace(/[\s-]/g, '').toUpperCase();
  if (!compact.startsWith('CC') || compact.length !== 14) return null;
  return normalizePairCode(compact.slice(2));
}
const displayCode = code => 'CC-' + formatPairCode(code);
const rawCode = code => typeof code === 'string' && code === normalizePairCode(code);
const token = value => validToken(value) && Buffer.from(value, 'base64url').toString('base64url') === value;
const hmac = (secret, label) => createHmac('sha256', secret).update(label).digest();

async function deviceKeys(code) {
  const root = await pairSecret('CC Connect / persistent device / v1\0' + code);
  return {
    alias:hmac(root, 'CC Connect / device locator / v1').toString('base64url'),
    key:hmac(root, 'CC Connect / device envelope / v1')
  };
}

// Accept only the account-approved public pairing format. No address, relay URL,
// local path, management credential or executable instruction belongs in this envelope.
function inviteRoom(invite) {
  if (typeof invite !== 'string' || invite.length > 800 || !/^RD1\.[A-Za-z0-9_-]+$/.test(invite)) throw new Error(invalid);
  const encoded = invite.slice(4), bytes = Buffer.from(encoded, 'base64url');
  if (bytes.toString('base64url') !== encoded) throw new Error(invalid);
  let spec;
  try { spec = JSON.parse(bytes.toString('utf8')); } catch { throw new Error(invalid); }
  if (!spec || !token(spec.key) || spec.account !== 1 || spec.managed !== 1 ||
      !Number.isSafeInteger(spec.exp) || Object.keys(spec).length !== 4) throw new Error(invalid);
  if (spec.exp <= Date.now()) throw new Error(unavailable);
  return hmac(Buffer.from(spec.key, 'base64url'), 'rd1-managed-room').toString('base64url');
}
function sealInvite(keys, invite) {
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', keys.key, nonce);
  cipher.setAAD(Buffer.from(keys.alias, 'ascii'));
  const ciphertext = Buffer.concat([cipher.update(invite, 'utf8'), cipher.final()]);
  return Buffer.concat([nonce, cipher.getAuthTag(), ciphertext]).toString('base64url');
}
function openInvite(keys, envelope) {
  if (typeof envelope !== 'string' || envelope.length > maxEnvelope || !/^[A-Za-z0-9_-]+$/.test(envelope)) throw new Error(invalid);
  const bytes = Buffer.from(envelope, 'base64url');
  if (bytes.length <= 28 || bytes.toString('base64url') !== envelope) throw new Error(invalid);
  let invite;
  try {
    const decipher = createDecipheriv('aes-256-gcm', keys.key, bytes.subarray(0,12));
    decipher.setAAD(Buffer.from(keys.alias, 'ascii'));
    decipher.setAuthTag(bytes.subarray(12,28));
    invite = Buffer.concat([decipher.update(bytes.subarray(28)),decipher.final()]).toString('utf8');
  } catch { throw new Error(invalid); }
  inviteRoom(invite);
  return invite;
}

class DeviceCodes {
  constructor({ directory, storage, base, fetchImpl = globalThis.fetch, platform = process.platform }) {
    const url = new URL(base);
    if (url.protocol !== 'https:' || url.username || url.password || url.hash || url.search) throw new Error(offline);
    this.base = url.href.replace(/\/$/, '');
    this.storage = storage;
    this.platform = platform;
    this.directory = directory;
    this.fetch = fetchImpl;
  }

  owner(username) {
    if (typeof username !== 'string' || !/^[a-z0-9][a-z0-9._-]{2,39}$/i.test(username)) throw new Error(messages.account_required);
    return createHash('sha256').update(this.base + '\0' + username.toLowerCase()).digest('hex');
  }

  async withRecord(username, operation) {
    const owner = this.owner(username);
    const file = path.join(this.directory, 'device-' + owner + '.bin');
    const previous = operations.get(file) || Promise.resolve();
    const task = previous.catch(() => {}).then(async () => {
      let record;
      try {
        if (!await this.storage.isAsyncEncryptionAvailable() || (this.platform === 'linux' &&
            !['gnome_libsecret','kwallet','kwallet5','kwallet6'].includes(this.storage.getSelectedStorageBackend()))) throw new Error(storageError);
        let encrypted;
        try { encrypted = await fs.readFile(file); } catch (error) { if (error.code !== 'ENOENT') throw error; }
        if (encrypted) {
          if (!encrypted.length || encrypted.length > 16384) throw new Error(storageError);
          record = JSON.parse((await this.storage.decryptStringAsync(encrypted)).result);
          if (record?.version !== 1 || record.owner !== owner || !rawCode(record.code) || !token(record.management) ||
              (record.pending !== null && (!rawCode(record.pending) || record.pending === record.code))) throw new Error(storageError);
        } else {
          record = {version:1, owner, code:makePairCode(), management:randomBytes(32).toString('base64url'), pending:null};
          await this.save(file,record);
        }
      } catch { throw new Error(storageError); }
      return operation(record, file);
    });
    operations.set(file, task);
    try { return await task; }
    finally { if (operations.get(file) === task) operations.delete(file); }
  }

  async save(file, record) {
    const temp = file + '.' + randomUUID();
    try {
      const bytes = await this.storage.encryptStringAsync(JSON.stringify(record));
      if (!Buffer.isBuffer(bytes) || !bytes.length || bytes.length > 16384) throw new Error(storageError);
      await fs.mkdir(this.directory, {recursive:true,mode:0o700});
      await fs.writeFile(temp, bytes, {flag:'wx',mode:0o600,flush:true});
      await fs.rename(temp,file);
    } catch { throw new Error(storageError); }
    finally { await fs.rm(temp,{force:true}).catch(() => {}); }
  }

  async request(alias, sessionToken, {method, management, body, signal, timeoutMs = 8000}) {
    if (!token(sessionToken)) throw new Error(messages.account_required);
    const timeout = AbortSignal.timeout(timeoutMs);
    let response;
    try {
      response = await this.fetch(this.base + '/devices/' + alias + (method === 'POST' ? '/publish' : ''), {
        method, redirect:'error', credentials:'omit', cache:'no-store',
        signal:signal ? AbortSignal.any([signal,timeout]) : timeout,
        headers:{'x-cc-session':sessionToken, ...(management && {authorization:'Bearer ' + management}),
          ...(body && {'content-type':'application/json'})},
        ...(body && {body:JSON.stringify(body)})
      });
    } catch { throw new Error(signal?.aborted ? '连接已结束。' : offline); }
    if (response.status === 200 && method === 'GET') {
      try { return (await readJSON(response)).envelope; }
      catch { throw new Error(signal?.aborted ? '连接已结束。' : offline); }
    }
    if ((method === 'POST' && [200,201,204].includes(response.status)) ||
        (method === 'DELETE' && response.status === 204)) {
      await response.body?.cancel().catch(() => {});
      return;
    }
    const data = await readJSON(response).catch(() => ({}));
    const accountError = Object.hasOwn(messages,data?.error) ? messages[data.error] : null;
    let message = accountError || offline;
    if (response.status === 429) message = rateLimited;
    else if (!accountError && response.status === 401) message = messages.account_required;
    else if (!accountError && method === 'GET' && [404,410].includes(response.status)) message = unavailable;
    else if (!accountError && method !== 'GET' && response.status === 409) message = '请先结束当前配对或连接。';
    else if (!accountError && method !== 'GET' && [403,410].includes(response.status)) message = conflict;
    const error = new Error(message);
    error.status = response.status;
    throw error;
  }

  get(username) {
    return this.withRecord(username, record => displayCode(record.code));
  }

  async finishRotation(record, file, session, signal, firstAttempt = false) {
    const keys = await deviceKeys(record.code);
    if (signal?.aborted) {
      if (firstAttempt) await this.save(file,{...record,pending:null});
      throw new Error('连接已结束。');
    }
    try { await this.request(keys.alias, session, {method:'DELETE',management:record.management,signal}); }
    catch (error) {
      const refused = error.status >= 400 && error.status < 500 && error.status !== 408;
      // A live-room conflict proves the old alias has not been retired. After
      // a previous ambiguous response, a mere login failure cannot prove that.
      if (error.status === 409 || (firstAttempt && refused)) await this.save(file,{...record,pending:null});
      throw error;
    }
    // Both values are durably staged before contacting the server. If this write
    // fails, restart/retry will revoke the same old alias and promote the same new one.
    const next = {...record,code:record.pending,pending:null};
    await this.save(file,next);
    return next;
  }

  rotate(username, session, signal) {
    if (!token(session)) return Promise.reject(new Error(messages.account_required));
    return this.withRecord(username, async (record,file) => {
      if (signal?.aborted) throw new Error('连接已结束。');
      const firstAttempt = !record.pending;
      if (firstAttempt) {
        let next;
        do { next = makePairCode(); } while (next === record.code);
        record = {...record,pending:next};
        await this.save(file,record);
      }
      record = await this.finishRotation(record,file,session,signal,firstAttempt);
      return displayCode(record.code);
    });
  }

  publish(username, session, {room, hostToken, invite}, signal) {
    if (!token(session)) return Promise.reject(new Error(messages.account_required));
    return this.withRecord(username, async (record,file) => {
      if (!token(hostToken) || inviteRoom(invite) !== room) throw new Error(invalid);
      if (record.pending) record = await this.finishRotation(record,file,session,signal);
      const keys = await deviceKeys(record.code);
      // A repeated publication of the same invitation must replay its original
      // ciphertext. Process restart ends the room; a new invitation gets a new nonce.
      const digest = createHash('sha256').update(invite).digest('hex');
      if (this.lastEnvelope?.alias !== keys.alias || this.lastEnvelope.digest !== digest) {
        this.lastEnvelope = {alias:keys.alias,digest,envelope:sealInvite(keys,invite)};
      }
      const options = {method:'POST',management:record.management,
        body:{room,hostToken,envelope:this.lastEnvelope.envelope},signal};
      const deadline = Date.now() + 8000;
      try { await this.request(keys.alias,session,{...options,timeoutMs:4000}); }
      catch (error) {
        if (signal?.aborted || (error.status && error.status !== 408 && error.status < 500)) throw error;
        try { await sleep(180,undefined,{signal}); } catch { throw new Error('连接已结束。'); }
        const remaining = deadline - Date.now();
        if (remaining <= 0) throw error;
        // POST replays must reuse the ciphertext, nonce and host bearer. A lost
        // response may already have published the room or a user may have joined it.
        await this.request(keys.alias,session,{...options,timeoutMs:remaining});
      }
      return displayCode(record.code);
    });
  }

  async resolve(value, session, signal) {
    if (!token(session)) throw new Error(messages.account_required);
    const code = normalizeDeviceCode(value);
    if (!code) throw new Error(invalid);
    const keys = await deviceKeys(code);
    const envelope = await this.request(keys.alias,session,{method:'GET',signal});
    return openInvite(keys,envelope);
  }
}

module.exports = {DeviceCodes,normalizeDeviceCode};
