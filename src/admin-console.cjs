'use strict'

const { randomUUID } = require('node:crypto')

const id = '[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}'
const accountPath = new RegExp('^/v1/admin/accounts/' + id + '$')
const revokePath = new RegExp('^/v1/admin/accounts/' + id + '/revoke-sessions$')
const quotaPath = new RegExp('^/v1/admin/quotas/(?:global|' + id + ')$')

function apiAllowed(url, method) {
  const { pathname, searchParams } = url
  if (method === 'GET' && pathname === '/v1/admin/accounts') return [...searchParams.keys()].every(k => ['status','cursor'].includes(k))
  if (method === 'GET' && pathname === '/v1/admin/usage') return [...searchParams.keys()].every(k => k === 'accountId')
  if (url.search) return false
  if (method === 'GET') return pathname === '/v1/auth/me'
  if (method === 'POST') return pathname === '/v1/admin/invites' || revokePath.test(pathname)
  return method === 'PATCH' && (accountPath.test(pathname) || quotaPath.test(pathname))
}

function requestKind(details, contents, origin) {
  if (contents.isDestroyed() || details.webContentsId !== contents.id) return null
  const url = new URL(details.url)
  if (url.origin !== origin || url.username || url.password) return null
  if (details.method === 'GET' && !url.search) {
    if (details.resourceType === 'mainFrame' && url.pathname === '/admin') return 'page'
    if (details.resourceType === 'script' && url.pathname === '/admin/app.js') return 'asset'
    if (details.resourceType === 'stylesheet' && url.pathname === '/admin/base.css') return 'asset'
  }
  if (details.resourceType !== 'xhr' || !details.frame || details.frame !== contents.mainFrame ||
      (details.initiatorOrigin && details.initiatorOrigin !== origin)) return null
  const document = new URL(details.frame.url)
  if (document.origin !== origin || document.pathname !== '/admin' || document.search) return null
  return apiAllowed(url, details.method) ? 'api' : null
}

class AdminConsole {
  constructor({ BrowserWindow, session, account, origin }) {
    Object.assign(this, { BrowserWindow, session, account, origin })
  }

  currentToken() {
    return this.account.state.role === 'admin' ? this.account.approvedToken : null
  }

  checkIdentity() {
    if (this.window && this.token !== this.currentToken()) this.close()
  }

  close() { this.window?.destroy() }

  async open(parent, language) {
    const token = await this.account.requireApproved()
    if (!token || token !== this.currentToken() || parent.isDestroyed()) throw new Error('需要已批准的管理员账号。')
    this.checkIdentity()
    if (this.window) {
      if (this.window.isMinimized()) this.window.restore()
      this.window.show(); this.window.focus()
      return
    }
    const partition = this.session.fromPartition('cc-admin-' + randomUUID(), { cache: false })
    const win = new this.BrowserWindow({ parent, width: 1000, height: 730, minWidth: 640, minHeight: 480,
      show: false, autoHideMenuBar: true, title: 'CC Connect', backgroundColor: '#f7f8fc',
      webPreferences: { session: partition, sandbox: true, contextIsolation: true, nodeIntegration: false, devTools: false } })
    this.window = win
    this.token = token
    const contents = win.webContents
    const active = () => this.window === win && this.currentToken() === token
    const kind = details => active() && requestKind(details, contents, this.origin)
    partition.webRequest.onBeforeRequest((details, done) => done({ cancel: !kind(details) }))
    partition.webRequest.onBeforeSendHeaders((details, done) => {
      const type = kind(details)
      if (!type) return done({ cancel: true })
      const headers = { ...details.requestHeaders }
      for (const name of Object.keys(headers)) {
        if (['authorization','cookie'].includes(name.toLowerCase())) delete headers[name]
      }
      if (type === 'api') headers.Authorization = 'Bearer ' + token
      done({ requestHeaders: headers })
    })
    // Reject redirects on every resource before Chromium can forward its headers.
    partition.webRequest.onHeadersReceived((details, done) => {
      done({ cancel: details.statusCode >= 300 && details.statusCode < 400 && details.statusCode !== 304 })
    })
    partition.webRequest.onCompleted(details => {
      if (active() && [401,403].includes(details.statusCode) && kind(details) === 'api') void this.account.refresh().catch(() => {})
    })
    partition.setPermissionCheckHandler((wc, perm, origin) => active() && wc === contents && origin === this.origin && perm === 'clipboard-sanitized-write')
    partition.setPermissionRequestHandler((wc, perm, done, details) => done(active() && wc === contents &&
      details.isMainFrame && perm === 'clipboard-sanitized-write'))
    partition.on('will-download', event => event.preventDefault())
    contents.setWindowOpenHandler(() => ({ action: 'deny' }))
    for (const event of ['will-frame-navigate','will-redirect','will-attach-webview']) contents.on(event, e => e.preventDefault())
    const poll = setInterval(() => { if (active()) void this.account.refresh().catch(() => {}) }, 60000)
    poll.unref?.()
    win.once('closed', () => {
      clearInterval(poll)
      for (const hook of ['onBeforeRequest','onBeforeSendHeaders','onHeadersReceived','onCompleted']) partition.webRequest[hook](null)
      partition.setPermissionCheckHandler(null)
      partition.setPermissionRequestHandler(null)
      partition.removeAllListeners('will-download')
      if (this.window === win) { this.window = null; this.token = null }
    })
    try {
      const locale = ['zh-CN','zh-TW','en'].includes(language) ? language : 'zh-CN'
      await win.loadURL(this.origin + '/admin#desktop=' + locale)
      if (active()) win.show()
    } catch (error) {
      if (!win.isDestroyed()) win.destroy()
      throw error
    }
  }
}

module.exports = { AdminConsole, requestKind }
