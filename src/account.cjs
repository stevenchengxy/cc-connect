'use strict'

const fs = require('node:fs/promises')
const path = require('node:path')
const { randomUUID } = require('node:crypto')

const messages = {
  account_required: '请先登录账号。',
  account_pending: '等待管理员批准。',
  account_suspended: '账号已停用，请联系管理员。',
  account_revoked: '账号授权已撤销，请联系管理员。',
  invalid_credentials: '用户名或密码不正确。',
  registration_unavailable: '无法注册，请检查邀请码和用户名。',
  invalid_request: '请检查用户名、密码和邀请码。',
  rate_limited: '尝试次数过多，请稍后再试。'
}
const offline = '无法验证账号，请检查网络后重试。'
const storageError = '无法使用系统安全凭据存储，请解锁钥匙串后重试。'
const validToken = token => typeof token === 'string' && /^[A-Za-z0-9_-]{43}$/.test(token)

async function readJSON(response) {
  let size = 0
  const parts = []
  for await (const chunk of response.body || []) {
    size += chunk.length
    if (size > 16384) throw new Error(offline)
    parts.push(chunk)
  }
  return JSON.parse(Buffer.concat(parts).toString())
}

function credentials(values, registration) {
  const username = typeof values?.username === 'string' ? values.username.trim() : ''
  const password = values?.password
  if (!/^[a-z0-9][a-z0-9._-]{2,39}$/i.test(username)) throw new Error('用户名须为 3 至 40 位字母、数字、点、下划线或短横线，并以字母或数字开头。')
  if (typeof password !== 'string' || !password || password.length > 128 || (registration && password.length < 12)) {
    throw new Error('请输入 12 至 128 位密码。')
  }
  if (!registration) return { username, password }
  const invite = typeof values.invite === 'string' ? values.invite.trim() : ''
  if (validToken(invite)) return { username, password, invite }
  const compact = invite.replace(/[\s-]/g,'')
  if (!/^[2-9A-HJ-NP-Z]{8}$/i.test(compact)) throw new Error('请填写管理员提供的邀请码。')
  return { username, password, invite: compact.toUpperCase() }
}

class DesktopAccount {
  constructor({ directory, storage, base, fetchImpl, platform = process.platform, onChange = () => {} }) {
    const url = new URL(base)
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw new Error(offline)
    this.base = url.href.replace(/\/$/, '') + '/auth/'
    this.file = path.join(directory, 'account-session.bin')
    this.storage = storage
    this.fetch = fetchImpl
    this.platform = platform
    this.onChange = onChange
    this.state = { status: 'signedOut' }
    this.queue = Promise.resolve()
    this.generation = 0
  }

  run(fn) {
    const operation = this.queue.then(fn)
    this.queue = operation.catch(() => {})
    return operation
  }

  setState(status, username = '', message = '', role = 'member') {
    this.state = { status, username, message, role, revision:(this.state.revision || 0) + 1 }
    this.onChange(this.state)
    return this.state
  }

  get approvedToken() {
    return this.state.status === 'approved' && this.expiresAt > Date.now() ? this.token : null
  }

  async secureStore() {
    if (!await this.storage.isAsyncEncryptionAvailable() || (this.platform === 'linux' &&
      !['gnome_libsecret','kwallet','kwallet5','kwallet6'].includes(this.storage.getSelectedStorageBackend()))) throw new Error(storageError)
  }

  async request(action, { token, body } = {}) {
    let response, data
    try {
      response = await this.fetch(this.base + action, {
        method: action === 'me' ? 'GET' : 'POST', credentials: 'omit', cache: 'no-store', redirect: 'error',
        signal: AbortSignal.timeout(8000), headers: { ...(token && { authorization: 'Bearer ' + token }),
          ...(body && { 'content-type':'application/json' }) }, ...(body && {body:JSON.stringify(body)})
      })
      if (response.status === 204 && action === 'logout') return
      data = await readJSON(response)
    } catch { throw new Error(offline) }
    if (!response.ok) {
      const code = data?.error
      const error = new Error(Object.hasOwn(messages, code) ? messages[code] : response.status === 401 ? messages.account_required : offline)
      error.code = code
      error.status = response.status
      throw error
    }
    return data
  }

  validate(data) {
    if (!['approved','pending','suspended'].includes(data?.account?.status) ||
        typeof data.account.username !== 'string' || data.account.username.length > 40 ||
        !Number.isSafeInteger(data.expiresAt) || data.expiresAt * 1000 <= Date.now()) throw new Error(offline)
  }

  apply(data) {
    this.expiresAt = data.expiresAt * 1000
    clearTimeout(this.timer)
    this.timer = setTimeout(() => { void this.logout().catch(() => {}) }, Math.min(2147483647, this.expiresAt - Date.now()))
    this.timer.unref?.()
    return this.setState(data.account.status, data.account.username, '', data.account.role === 'admin' ? 'admin' : 'member')
  }

  async forget() {
    clearTimeout(this.timer)
    this.token = null
    this.expiresAt = 0
    this.setState('signedOut')
    try { await fs.rm(this.file, { force:true }) } catch { throw new Error(storageError) }
  }

  async verify() {
    const token = this.token
    if (!token) return this.state
    try {
      const data = await this.request('me', {token})
      this.validate(data)
      if (this.token === token) this.apply(data)
    } catch (error) {
      if (this.token !== token) return this.state
      if (error.status === 401 || ['account_suspended','account_revoked'].includes(error.code)) {
        await this.forget()
        return this.setState('signedOut', '', error.message)
      }
      return this.setState('unavailable', this.state.username, error.message)
    }
    return this.state
  }

  restore() {
    const generation = this.generation
    return this.run(async () => {
      let encrypted
      try { encrypted = await fs.readFile(this.file) } catch (e) {
        if (e.code === 'ENOENT') return this.state
        return this.setState('unavailable', '', storageError)
      }
      try {
        await this.secureStore()
        const {result} = await this.storage.decryptStringAsync(encrypted)
        if (!validToken(result)) throw new Error(storageError)
        if (this.generation !== generation) return this.state
        this.token = result
      } catch { return this.setState('unavailable', '', storageError) }
      return this.verify()
    })
  }

  refresh() {
    return this.token ? this.run(() => this.verify()) : this.restore()
  }

  async requireApproved() {
    const state = await this.refresh()
    if (!this.approvedToken) throw new Error(state.message || messages['account_' + state.status] || messages.account_required)
    return this.approvedToken
  }

  register(values) {
    return this.run(async () => {
      if (this.token) throw new Error('请先退出当前账号。')
      const data = await this.request('register', {body:credentials(values, true)})
      if (data?.status !== 'pending') throw new Error(offline)
      return {status:'pending'}
    })
  }

  login(values) {
    const generation = this.generation
    return this.run(async () => {
      if (this.token) throw new Error('请先退出当前账号。')
      const body = credentials(values, false)
      try { await this.secureStore() } catch { throw new Error(storageError) }
      const data = await this.request('login', {body})
      if (!validToken(data?.token)) throw new Error(offline)
      const token = data.token
      const temp = this.file + '.' + randomUUID()
      try {
        this.validate(data)
        const encrypted = await this.storage.encryptStringAsync(token)
        await fs.mkdir(path.dirname(this.file), {recursive:true})
        await fs.writeFile(temp, encrypted, {mode:0o600, flag:'wx'})
        if (generation !== this.generation) throw new Error(messages.account_required)
        await fs.rename(temp, this.file)
        if (generation !== this.generation) throw new Error(messages.account_required)
        this.token = token
        return this.apply(data)
      } catch (error) {
        void this.request('logout', {token}).catch(() => {})
        throw new Error(error.message === messages.account_required ? error.message : storageError)
      } finally { await fs.rm(temp, {force:true}).catch(() => {}) }
    })
  }

  logout() {
    this.generation++
    const token = this.token
    this.token = null
    clearTimeout(this.timer)
    this.setState('signedOut')
    return this.run(async () => {
      await this.forget()
      if (token) await this.request('logout', {token})
      return this.state
    })
  }
}

module.exports = { DesktopAccount, validToken, messages, readJSON }
