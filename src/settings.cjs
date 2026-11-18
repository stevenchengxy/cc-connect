const fs = require('node:fs/promises')
const path = require('node:path')
const { randomUUID } = require('node:crypto')

const defaults = { relayUrl: '', turnUrl: '', turnUsername: '', encryptedPassword: '' }

function cleanString(value, limit) {
  if (typeof value !== 'string' || value.length > limit || /[\x00-\x1f\x7f]/.test(value)) {
    throw new Error('网络设置格式有误。')
  }
  return value.trim()
}

function validateFields(input) {
  const relayUrl = cleanString(input.relayUrl, 512)
  const turnUrl = cleanString(input.turnUrl, 2048)
  const turnUsername = cleanString(input.turnUsername, 256)
  if (relayUrl) {
    let url
    try { url = new URL(relayUrl) } catch {}
    if (!url || url.protocol !== 'wss:' || !url.hostname || url.username || url.password || url.search || url.hash) {
      throw new Error('信令地址需要使用 wss://，可带端口和路径。')
    }
  }
  if (turnUrl) {
    const match = /^(turns?):(\[[\da-f:]+\]|[a-z\d.-]+)(?::(\d{1,5}))?(?:\?transport=(?:tcp|udp))?$/i.exec(turnUrl)
    if (!match || (match[3] && (+match[3] < 1 || +match[3] > 65535))) {
      throw new Error('请输入有效的 turn: 或 turns: 地址。')
    }
  }
  return { relayUrl, turnUrl, turnUsername: turnUrl ? turnUsername : '' }
}

class Settings {
  constructor(directory, safeStorage) {
    this.file = path.join(directory, 'network-settings.json')
    this.safeStorage = safeStorage
    this.value = { ...defaults }
  }

  async load() {
    try {
      const saved = JSON.parse(await fs.readFile(this.file, 'utf8'))
      this.value = { ...validateFields(saved), encryptedPassword: cleanString(saved.encryptedPassword, 16384) }
    } catch (err) {
      if (err.code !== 'ENOENT') throw new Error('读取网络设置失败。请重新保存网络设置。')
    }
  }

  async update(input) {
    const values = validateFields(input)
    const pass = input.turnPassword
    if (typeof pass !== 'string' || pass.length > 1024) throw new Error('TURN 密码格式有误。')
    let encryptedPassword = ''
    if (values.turnUrl) {
      if (!values.turnUsername) throw new Error('请填写 TURN 用户名。')
      if (pass) {
        if (!await this.safeStorage.isAsyncEncryptionAvailable()) throw new Error('系统凭据存储暂不可用。')
        encryptedPassword = (await this.safeStorage.encryptStringAsync(pass)).toString('base64')
      } else if (values.turnUrl === this.value.turnUrl && values.turnUsername === this.value.turnUsername) {
        encryptedPassword = this.value.encryptedPassword
      }
      if (!encryptedPassword) throw new Error('请填写此 TURN 账户的密码。')
    }
    const next = { ...values, encryptedPassword }
    const temp = this.file + '.' + randomUUID()
    await fs.mkdir(path.dirname(this.file), { recursive: true })
    try {
      await fs.writeFile(temp, JSON.stringify(next), { mode: 0o600 })
      await fs.rename(temp, this.file)
    } finally {
      await fs.rm(temp, { force: true })
    }
    this.value = next
  }

  async getPublic() {
    const { relayUrl, turnUrl, turnUsername, encryptedPassword } = this.value
    const iceServers = []
    if (turnUrl && encryptedPassword) {
      let decrypted
      try {
        decrypted = await this.safeStorage.decryptStringAsync(Buffer.from(encryptedPassword, 'base64'))
      } catch {
        // Retain editable settings when the OS credential store is locked or has changed.
      }
      if (decrypted) iceServers.push({ urls: turnUrl, username: turnUsername, credential: decrypted.result })
    }
    return { relayUrl, turnUrl, turnUsername, turnConfigured: iceServers.length > 0, iceServers }
  }
}

module.exports = { Settings }
