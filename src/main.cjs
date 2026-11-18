const {
  app, BrowserWindow, clipboard, desktopCapturer, dialog, ipcMain, Menu, nativeImage, powerMonitor,
  safeStorage, screen, session, systemPreferences, Tray
} = require('electron')
const os = require('node:os')
const path = require('node:path')
const { pathToFileURL } = require('node:url')
const { PairingNetwork } = require('./network.cjs')
const { InputBridge } = require('../native/bridge.cjs')
const { Settings } = require('./settings.cjs')
const { Updater } = require('./updater.cjs')

const page = path.join(__dirname, 'ui', 'index.html')
const pageUrl = pathToFileURL(page).href
const iconPath = path.join(__dirname, 'icon.png')
const managedUrl = 'https://cc-connect-pair.stevenchengxy19.chatgpt.site/v1'
const inputSupported = ['darwin', 'win32'].includes(process.platform)
const deviceName = os.hostname().replace(/\.local$/i, '').slice(0, 64) || '我的电脑'

// Preserve the original application's local settings and permission identity.
const fs = require('node:fs')
const legacyData = path.join(app.getPath('appData'), '见屏')
app.setName('CC Connect')
if (!app.commandLine.hasSwitch('user-data-dir') && fs.existsSync(legacyData)) app.setPath('userData', legacyData)
const primaryInstance = app.requestSingleInstanceLock()
if (!primaryInstance) app.quit()
let language = 'zh-CN'
function nativeText(zh, tw, en) {
  return language === 'en' ? en : language === 'zh-TW' ? tw : zh
}
let window
let preferences
let current
let tray
let saveInProgress = false
let updater
let installingUpdate = false
app.on('second-instance', () => {
  if (window && !window.isDestroyed()) {
    if (window.isMinimized()) window.restore()
    window.show()
    window.focus()
  }
})

function updateApplicationMenu() {
  const menu = [
    { label: 'CC Connect', submenu: [
      { role: 'about', label: nativeText('关于 CC Connect', '關於 CC Connect', 'About CC Connect') },
      { type: 'separator' },
      { role: 'quit', label: nativeText('退出', '結束', 'Quit') }
    ] },
    { label: nativeText('编辑', '編輯', 'Edit'), submenu: [
      { role: 'undo', label: nativeText('撤销', '復原', 'Undo') },
      { role: 'redo', label: nativeText('重做', '重做', 'Redo') },
      { type: 'separator' },
      { role: 'cut', label: nativeText('剪切', '剪下', 'Cut') },
      { role: 'copy', label: nativeText('复制', '複製', 'Copy') },
      { role: 'paste', label: nativeText('粘贴', '貼上', 'Paste') },
      { role: 'selectAll', label: nativeText('全选', '全選', 'Select all') }
    ] },
    { label: nativeText('窗口', '視窗', 'Window'), submenu: [
      { role: 'minimize', label: nativeText('最小化', '縮小', 'Minimize') },
      { role: 'close', label: nativeText('关闭', '關閉', 'Close') }
    ] }
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(menu))
}

function send(update) {
  if (window && !window.isDestroyed() && !window.webContents.isDestroyed()) {
    window.webContents.send('jianping:event', update)
  }
}

function trusted(frame) {
  return Boolean(frame && window && !window.isDestroyed() &&
    frame === window.webContents.mainFrame && frame.url === pageUrl)
}

function finish(reason = '连接已结束', error = false) {
  const active = current
  current = null
  if (!active) return
  active.allowControl = false
  active.input?.stop()
  active.network.stop()
  tray?.destroy()
  tray = null
  if (window && !window.isDestroyed()) window.setTitle('CC Connect')
  send({ type: 'closed', reason, error })
}

function showSharingIndicator() {
  const title = 'CC Connect · ' + (current.allowControl
    ? nativeText('正在共享屏幕和键鼠', '正在共享螢幕與鍵鼠', 'Screen and controls shared')
    : nativeText('正在共享屏幕', '正在共享螢幕', 'Screen sharing'))
  window.setTitle(title)
  tray = new Tray(nativeImage.createFromPath(iconPath).resize({ width: 18, height: 18 }))
  if (process.platform === 'darwin') tray.setTitle(nativeText('共享中', '共享中', 'Sharing'))
  tray.setToolTip(title)
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: title, enabled: false },
    { label: nativeText('打开 CC Connect', '開啟 CC Connect', 'Open CC Connect'), click: () => { window.show(); window.focus() } },
    { label: nativeText('结束共享', '結束共享', 'Stop sharing'), click: () => finish('本机已结束共享') }
  ]))
}

function createSession(role) {
  if (installingUpdate) throw new Error('更新任务正在进行，请稍候。')
  if (current || saveInProgress) throw new Error('请先结束当前配对，或等待网络设置保存完成。')
  const network = new PairingNetwork({
    managedUrl: !app.isPackaged && app.commandLine.hasSwitch('test-local-pairing') ? undefined : managedUrl,
    fetchImpl: (url, init) => session.defaultSession.fetch(url, { ...init, credentials: 'omit' })
  })
  const active = { network, role, phase: 'pairing', allowControl: false }
  current = active
  active.network.on('event', event => {
    if (current !== active) return
    switch (event.type) {
      case 'request':
        if (active.role !== 'host' || active.phase !== 'pairing') return
        active.phase = 'pending'
        window.show()
        send({ type: 'request', name: event.name })
        break
      case 'connected':
        if ((role === 'host' && active.phase !== 'approving') ||
            (role === 'viewer' && active.phase !== 'pairing')) return finish('配对状态已改变')
        active.phase = 'connected'
        if (role === 'host') showSharingIndicator()
        if (event.managedWan) {
          active.pendingSignals = []
          active.network.getManagedIceServers().then(iceServers => {
            if (current !== active) return
            send({ type: 'accepted', role, name: event.name, allowControl: active.allowControl, managedWan: true, managedIceServers: iceServers, managedIceUnavailable: active.network.managedIceUnavailable })
            for (const signal of active.pendingSignals) send({ type: 'signal', signal })
            active.pendingSignals = null
          }).catch(() => { if (current === active) finish('公网连接初始化失败，请重新配对。') })
        } else {
          send({ type: 'accepted', role, name: event.name, allowControl: active.allowControl })
        }
        break
      case 'signal':
        if (active.phase !== 'connected') return
        if (active.pendingSignals) {
          if (active.pendingSignals.length >= 128) return finish('连接消息过多，请重新配对。')
          active.pendingSignals.push(event.payload)
        } else send({ type: 'signal', signal: event.payload })
        break
      case 'closed':
        finish(event.reason || '对方已断开连接')
        break
    }
  })
  return active
}

function requirePending() {
  if (!current || current.role !== 'host' || current.phase !== 'pending') throw new Error('连接请求已失效。')
  return current
}

async function listScreens() {
  const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 0, height: 0 } })
  if (process.platform === 'darwin' && systemPreferences.getMediaAccessStatus('screen') === 'denied') {
    throw new Error('请在「系统设置 → 隐私与安全性 → 屏幕与系统音频录制」中允许CC Connect，然后重新打开应用。')
  }
  if (!sources.length) throw new Error('没有可共享的屏幕。请检查系统的屏幕录制权限。')
  return sources
}

function disableInput(active, message) {
  if (current !== active) return
  active.allowControl = false
  active.controlError = message || '键鼠控制不可用，本次仅共享画面。'
  active.input?.stop()
  if (active.phase === 'connected') {
    tray?.destroy()
    tray = null
    showSharingIndicator()
    send({ type: 'control-unavailable', message: active.controlError })
  }
}

function handle(name, fn) {
  ipcMain.handle('jianping:' + name, (event, ...args) => {
    if (!trusted(event.senderFrame)) throw new Error('无效的窗口。')
    return fn(...args)
  })
}

function registerHandlers() {
  handle('language', locale => {
    if (!['zh-CN', 'zh-TW', 'en'].includes(locale)) return
    language = locale
    updateApplicationMenu()
    if (tray) { tray.destroy(); tray = null; showSharingIndicator() }
  })
  handle('info', async () => ({
    name: deviceName, platform: process.platform, version: app.getVersion(), inputSupported, language, update: updater.getState(),
    ...await preferences.getPublic()
  }))
  handle('check-update', () => updater.check())
  handle('download-update', () => updater.download())
  handle('install-update', async () => {
    if (current) throw new Error('请先结束远程连接，再安装更新。')
    if (installingUpdate) throw new Error('更新任务正在进行，请稍候。')
    installingUpdate = true
    try {
      const result = await updater.install()
      setImmediate(() => app.quit())
      return result
    } catch (error) { installingUpdate = false; throw error }
  })
  handle('settings', async values => {
    if (current || saveInProgress) throw new Error('请先结束当前配对，再修改网络设置。')
    saveInProgress = true
    try { await preferences.update(values) } finally { saveInProgress = false }
  })
  for (const role of ['host', 'viewer']) {
    handle(role === 'host' ? 'host' : 'join', async invite => {
      const active = createSession(role)
      const options = { name: deviceName, relayUrl: preferences.value.relayUrl }
      try {
        return role === 'host'
          ? await active.network.host(options)
          : await active.network.join({ ...options, invite })
      } catch (err) {
        if (current === active) finish(err.message, true)
        throw err
      }
    })
  }
  handle('screens', async () => {
    const active = requirePending()
    const sources = await listScreens()
    if (current !== active) throw new Error('连接请求已失效。')
    const primaryId = String(screen.getPrimaryDisplay().id)
    const displays = screen.getAllDisplays()
    return sources.map((item, index) => {
      const display = displays.find(display => String(display.id) === item.display_id)
      return { id: item.id, name: display?.label || item.name || ('屏幕 ' + (index + 1)), primary: item.display_id === primaryId }
    })
  })
  handle('accept', async (allowControl, screenId) => {
    const active = requirePending()
    active.phase = 'approving'
    try {
      const sources = await listScreens()
      if (current !== active) throw new Error('连接请求已失效。')
      active.source = sources.find(item => item.id === screenId)
      if (!active.source) throw new Error('选定的屏幕已经断开，请重新选择。')
      active.display = screen.getAllDisplays().find(item => String(item.id) === active.source.display_id)
      if (allowControl === true && inputSupported) {
        if (active.display) {
          active.input = new InputBridge()
          active.input.on('error', err => disableInput(active, err.message))
          try {
            await active.input.start(active.display, { resourcesPath: process.resourcesPath, isPackaged: app.isPackaged })
            if (!active.controlError && current === active) active.allowControl = true
          } catch (err) { disableInput(active, err.message) }
        } else {
          disableInput(active, '无法匹配所选显示器的坐标，本次仅共享画面。')
        }
      }
      if (current !== active) { active.input?.stop(); throw new Error('连接请求已失效。') }
      active.network.respond(true)
      if (active.controlError) send({ type: 'control-unavailable', message: active.controlError })
    } catch (err) {
      if (current === active && active.phase === 'approving') {
        active.input?.stop()
        active.input = null
        active.allowControl = false
        active.controlError = null
        active.phase = 'pending'
      }
      throw err
    }
  })
  handle('reject', () => {
    const active = requirePending()
    active.network.respond(false)
    if (current === active) finish('已拒绝请求')
  })
  handle('signal', payload => {
    if (current?.phase !== 'connected') throw new Error('连接已结束。')
    current.network.signal(payload)
  })
  ipcMain.on('jianping:input', (event, data) => {
    if (!trusted(event.senderFrame) || current?.role !== 'host' ||
        current.phase !== 'connected' || !current.allowControl || !current.captureGranted) return
    try { current.input.send(data) } catch (err) { disableInput(current, err.message) }
  })
  handle('disconnect', () => finish('本机已断开连接'))
  handle('copy', text => {
    if (typeof text !== 'string' || text.length > 16384) throw new Error('无法复制邀请。')
    clipboard.writeText(text)
  })
}

function configurePermissions() {
  const ses = session.defaultSession
  const sharing = () => current?.role === 'host' && current.phase === 'connected' && Boolean(current.source)
  ses.setPermissionCheckHandler((contents, permission, origin) =>
    contents === window?.webContents && permission === 'display-capture' && sharing())
  ses.setPermissionRequestHandler((contents, permission, callback, details) =>
    callback(contents === window?.webContents && permission === 'display-capture' &&
      details.isMainFrame !== false && sharing()))
  ses.setDisplayMediaRequestHandler((request, callback) => {
    if (trusted(request.frame) && request.videoRequested && !request.audioRequested && sharing()) {
      current.captureGranted = true
      callback({ video: current.source })
    } else callback(null)
  })
}

function openWindow() {
  window = new BrowserWindow({
    title: 'CC Connect', width: 1030, height: 760, minWidth: 720, minHeight: 540, backgroundColor: '#f7f8fc',
    icon: iconPath, show: false, autoHideMenuBar: true,
    ...(process.platform === 'darwin' ? { titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 18, y: 23 } } : {}),
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, sandbox: true, nodeIntegration: false }
  })
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  window.webContents.on('will-navigate', event => event.preventDefault())
  window.webContents.on('did-start-navigation', (_event, _url, sameDocument, isMainFrame) => {
    if (isMainFrame && !sameDocument) finish('窗口已重新载入')
  })
  window.webContents.on('render-process-gone', () => finish('窗口已关闭'))
  window.on('close', () => finish('窗口已关闭'))
  window.on('closed', () => { window = null })
  window.once('ready-to-show', () => window?.show())
  window.loadFile(page)
}

async function offerInstallation() {
  if (!app.isPackaged || process.platform !== 'darwin' || app.isInApplicationsFolder()) return false
  const choice = await dialog.showMessageBox({
    type: 'question', title: 'CC Connect',
    message: nativeText('将 CC Connect 安装到「应用程序」？', '將 CC Connect 安裝到「應用程式」？', 'Install CC Connect in Applications?'),
    detail: nativeText('应用内更新会替换同一位置的旧版本。', '應用程式內更新會取代相同位置的舊版本。', 'In-app updates replace the previous version in the same location.'),
    buttons: [nativeText('安装', '安裝', 'Install'), nativeText('稍后', '稍後', 'Later')], defaultId: 0, cancelId: 1
  })
  if (choice.response !== 0) return false
  try {
    return app.moveToApplicationsFolder({ conflictHandler: conflict => dialog.showMessageBoxSync({
      type: 'question', title: 'CC Connect',
      message: nativeText('已安装 CC Connect', '已安裝 CC Connect', 'CC Connect is already installed'),
      detail: conflict === 'existsAndRunning'
        ? nativeText('继续将打开已运行的版本。请在该应用内检查更新。', '繼續將開啟執行中的版本。請在該應用程式內檢查更新。', 'Continue to the running copy, then check for updates there.')
        : nativeText('继续将替换旧版本，保留本机设置。', '繼續將取代舊版本，保留本機設定。', 'Continue to replace the previous version and keep local settings.'),
      buttons: [nativeText('继续', '繼續', 'Continue'), nativeText('取消', '取消', 'Cancel')], defaultId: 0, cancelId: 1
    }) === 0 })
  } catch {
    await dialog.showMessageBox({ type: 'error', title: 'CC Connect', message: nativeText('安装未完成。请退出应用后，将 CC Connect 拖入「应用程序」并选择替换。', '安裝未完成。請結束應用程式後，將 CC Connect 拖入「應用程式」並選擇取代。', 'Installation did not finish. Quit the app, drag CC Connect into Applications, and choose Replace.') })
    return false
  }
}

if (primaryInstance) app.whenReady().then(async () => {
  const locale = app.getLocale().toLowerCase()
  language = /^(zh-(tw|hk|mo)|zh-hant)/.test(locale) ? 'zh-TW' : locale.startsWith('zh') ? 'zh-CN' : 'en'
  if (await offerInstallation()) return
  updater = new Updater({ app, emit: state => send({ type: 'update', state }), canInstall: () => !current })
  preferences = new Settings(app.getPath('userData'), safeStorage)
  let startupError
  try { await preferences.load() } catch (err) { startupError = err.message }
  updateApplicationMenu()
  registerHandlers()
  configurePermissions()
  for (const event of ['suspend', 'lock-screen']) {
    powerMonitor.on(event, () => finish('设备已锁定或休眠'))
  }
  for (const event of ['display-removed', 'display-metrics-changed']) {
    screen.on(event, (_event, display) => {
      if (current?.display?.id === display.id) finish('共享显示器配置已更改，请重新配对')
    })
  }
  openWindow()
  if (startupError) window.webContents.once('did-finish-load', () => send({ type: 'error', message: startupError }))
})
app.on('before-quit', () => { updater?.cancel(); finish() })
app.on('window-all-closed', () => app.quit())
