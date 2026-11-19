const {
  app, BrowserWindow, clipboard, desktopCapturer, dialog, ipcMain, Menu, nativeImage, net, powerMonitor,
  safeStorage, screen, session, shell, systemPreferences, Tray
} = require('electron')
const { randomUUID } = require('node:crypto')
const os = require('node:os')
const path = require('node:path')
const { pathToFileURL } = require('node:url')
const { PairingNetwork } = require('./network.cjs')
const { InputBridge } = require('../native/bridge.cjs')
const { NativeScreenCapture, supportsNativePicker, nativeHelperAvailable } = require('../native/screen-bridge.cjs')
const { Settings } = require('./settings.cjs')
const { DesktopAccount, messages } = require('./account.cjs')
const { AdminConsole } = require('./admin-console.cjs')
const { Updater } = require('./updater.cjs')
const { FileTransfer, LocalFilePanel } = require('./file-transfer.cjs')
const { systemUpdateTransport } = require('./update-transport.cjs')
const { ScreenCapture, ScreenChoices, screenSelectionError, permissionErrors } = require('./screen-capture.cjs')

const page = path.join(__dirname, 'ui', 'index.html')
const pageUrl = pathToFileURL(page).href
const iconPath = path.join(__dirname, 'icon.png')
const managedUrl = 'https://cc-connect-pair.stevenchengxy19.chatgpt.site/v1'
const inputSupported = ['darwin', 'win32'].includes(process.platform)
const systemVersion = process.platform === 'darwin' ? process.getSystemVersion() : ''
const nativeOptions = { resourcesPath: process.resourcesPath, isPackaged: app.isPackaged }
const nativePickerSupported = supportsNativePicker(process.platform, systemVersion)
const deviceName = os.hostname().replace(/\.local$/i, '').slice(0, 64) || '我的电脑'
const capture = new ScreenCapture({
  platform: process.platform, systemVersion,
  getPermission: kind => systemPreferences.getMediaAccessStatus(kind),
  getSources: options => desktopCapturer.getSources(options)
})
let displayRevision = 0
let pickerGrant
let diagnosticCapture
let inputDrained = Promise.resolve()

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
let account
let adminConsole
let current
let tray
let saveInProgress = false
let updater
let installingUpdate = false
const localFiles = new LocalFilePanel(
  active => current === active && active.phase === 'connected' && active.token === account.approvedToken,
  (active, input) => input.start(active.display, { resourcesPath: process.resourcesPath, isPackaged: app.isPackaged }),
  (active, error) => disableInput(active, error.message)
)
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
  diagnosticCapture?.stop()
  const active = current
  current = null
  if (!active) return
  if (pickerGrant) disarmSystemPicker(pickerGrant.id)
  active.allowControl = false
  if (active.input) inputDrained = Promise.all([inputDrained, active.input.stop()]).then(() => {})
  active.nativeCapture?.bridge.stop()
  void active.files?.cancel()
  active.network.stop()
  if (active.previousThrottling !== undefined && window && !window.isDestroyed() && !window.webContents.isDestroyed()) {
    window.webContents.setBackgroundThrottling(active.previousThrottling)
  }
  tray?.destroy()
  tray = null
  if (window && !window.isDestroyed()) window.setTitle('CC Connect')
  send({ type: 'closed', reason, error })
  // A revoked room may lose its data channel before the signaling server's
  // close arrives. Recheck the same account whichever side noticed first.
  if (account.approvedToken === active.token) void account.refresh().catch(() => {})
}

function showSharingIndicator() {
  const filesOnly = current.captureMode === 'files'
  const title = 'CC Connect · ' + (filesOnly ? nativeText('文件传输', '檔案傳輸', 'File transfer') : current.allowControl
    ? nativeText('正在共享屏幕和键鼠', '正在共享螢幕與鍵鼠', 'Screen and controls shared')
    : nativeText('正在共享屏幕', '正在共享螢幕', 'Screen sharing'))
  window.setTitle(title)
  tray = new Tray(nativeImage.createFromPath(iconPath).resize({ width: 18, height: 18 }))
  if (process.platform === 'darwin') tray.setTitle(filesOnly ? nativeText('文件会话', '檔案連線', 'Files') : nativeText('共享中', '共享中', 'Sharing'))
  tray.setToolTip(title)
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: title, enabled: false },
    { label: nativeText('打开 CC Connect', '開啟 CC Connect', 'Open CC Connect'), click: () => { window.show(); window.focus() } },
    { label: filesOnly ? nativeText('结束连接', '結束連線', 'Disconnect') : nativeText('结束共享', '結束共享', 'Stop sharing'),
      click: () => finish(filesOnly ? '本机已断开连接' : '本机已结束共享') }
  ]))
}

function createSession(role, token) {
  if (!token || account.approvedToken !== token) throw new Error(messages.account_required)
  if (installingUpdate) throw new Error('更新任务正在进行，请稍候。')
  if (current || saveInProgress) throw new Error('请先结束当前配对，或等待网络设置保存完成。')
  diagnosticCapture?.stop()
  const network = new PairingNetwork({
    managedUrl, accountOnly: true, accountToken: token,
    fetchImpl: (url, init) => session.defaultSession.fetch(url, { ...init, credentials: 'omit' })
  })
  const active = { network, role, token, phase: 'pairing', requestId: randomUUID(), allowControl: false }
  current = active
  active.network.on('event', event => {
    if (current !== active) return
    switch (event.type) {
      case 'request':
        if (active.role !== 'host' || active.phase !== 'pairing') return
        active.phase = 'pending'
        active.fileSessions = event.fileSessions
        active.requestedFiles = event.requestedFiles
        if (active.preparedInvite) {
          send({type:'invite-claimed', requestId:active.requestId, name:event.name})
          void admitPreparedPeer(active)
          break
        }
        window.show()
        send({ type: 'request', name: event.name, requestId: active.requestId,
          fileSessions:event.fileSessions, requestedFiles:event.requestedFiles })
        break
      case 'connected': {
        if ((role === 'host' && active.phase !== 'approving') ||
            (role === 'viewer' && active.phase !== 'pairing')) return finish('配对状态已改变')
        active.phase = 'connected'
        if (event.mode === 'files') active.captureMode = 'files'
        if (role === 'host') showSharingIndicator()
        const accepted = { type: 'accepted', role, name: event.name, allowControl: active.allowControl,
          requestId: active.requestId, captureMode: active.captureMode || 'screen', controlRequested: active.controlRequested === true }
        if (event.managedWan) {
          active.pendingSignals = []
          active.network.getManagedIceServers().then(iceServers => {
            if (current !== active) return
            send({ ...accepted, allowControl: active.allowControl, managedWan: true, managedIceServers: iceServers, managedIceExpiresAt: active.network.managedIceExpiresAt, managedIceUnavailable: active.network.managedIceUnavailable })
            for (const signal of active.pendingSignals) send({ type: 'signal', signal })
            active.pendingSignals = null
          }).catch(() => { if (current === active) finish('公网连接初始化失败，请重新配对。') })
        } else {
          send(accepted)
        }
        break
      }
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

function requireHostPhase(requestId, ...phases) {
  if (!current || current.requestId !== requestId || current.role !== 'host' || !phases.includes(current.phase) ||
      current.token !== account.approvedToken) throw new Error('连接请求已失效。')
  return current
}

function discardHostScreen(active) {
  const selection = active.nativeCapture
  active.nativeCapture = null
  selection?.bridge.stop()
  active.controlRequested = false
  active.sourceRequested = false
  active.systemPicked = false
  active.source = null
  active.display = null
  active.captureMode = null
}

async function admitPreparedPeer(active) {
  try {
    // PairingNetwork emitted this event only after the first peer proved
    // possession of this invite. Recheck membership at the point of admission.
    if (await account.requireApproved() !== active.token) throw new Error(messages.account_required)
    requireHostPhase(active.requestId, 'pending')
    const filesOnly = active.requestedFiles || active.captureMode === 'files'
    if (filesOnly && !active.fileSessions) throw new Error('对方版本尚不支持仅传文件，请先更新 CC Connect。')
    if (filesOnly && active.captureMode !== 'files') {
      discardHostScreen(active)
      active.captureMode = 'files'
      send({type:'discard-prepared-screen', requestId:active.requestId})
    }
    if (active.captureMode === 'screen' && screenSelectionError(capture.permission(), active.listedPermission)) {
      throw new Error('系统未允许本次录屏请求。请检查当前应用的录屏设置。')
    }
    if (!filesOnly && capture.permission() === 'restricted') throw new Error('系统策略限制了录屏，请联系设备管理员。')
    active.phase = 'approving'
    active.network.respond(true, filesOnly ? 'files' : 'screen')
  } catch (error) {
    if (current === active) finish(error.message, true)
  }
}

function disableInput(active, message) {
  if (current !== active) return
  active.allowControl = false
  active.nativeCapture?.bridge.restoreViewOnlyCursor()
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

function roomFiles(requestId) {
  const active = current
  if (!active || active.phase !== 'connected' || active.token !== account.approvedToken ||
      active.requestId !== requestId) throw new Error('file-session')
  if (!active.files) active.files = new FileTransfer({
    live: () => current === active && active.token === account.approvedToken,
    chooseSource: () => localFiles.choose(active, async () => {
      const result = await dialog.showOpenDialog(window, {
        title: nativeText('选择要发送的文件', '選擇要傳送的檔案', 'Choose a file to send'),
        properties: ['openFile', 'dontAddToRecent']
      })
      return result.canceled ? null : result.filePaths[0]
    }),
    chooseDestination: name => localFiles.choose(active, async () => {
      const result = await dialog.showSaveDialog(window, {
        title: nativeText('保存对方发来的文件', '儲存對方傳來的檔案', 'Save the incoming file'),
        defaultPath: path.join(app.getPath('downloads'), name),
        properties: ['createDirectory', 'showOverwriteConfirmation', 'dontAddToRecent']
      })
      return result.canceled ? null : result.filePath
    })
  })
  return active.files
}

function registerHandlers() {
  handle('file-pick', id => roomFiles(id).pick())
  handle('file-save', (id, offer) => roomFiles(id).save(offer))
  handle('file-read', (id, file) => roomFiles(id).read(file))
  handle('file-write', (id, file, chunk) => roomFiles(id).write(file, chunk))
  handle('file-sent-digest', (id, file) => roomFiles(id).sentDigest(file))
  handle('file-commit', (id, file, digest) => roomFiles(id).commit(file, digest))
  handle('file-cancel', (id, file) => roomFiles(id).cancel(file))
  handle('language', locale => {
    if (!['zh-CN', 'zh-TW', 'en'].includes(locale)) return
    language = locale
    updateApplicationMenu()
    if (tray) { tray.destroy(); tray = null; showSharingIndicator() }
  })
  handle('info', async () => {
    const token = account.approvedToken
    const config = token ? await preferences.getPublic() : null
    return {name:deviceName, platform:process.platform, version:app.getVersion(), inputSupported, language,
      canUseSystemPicker:capture.canUseSystemPicker,
      canUseNativeScreenPicker:nativePickerSupported && nativeHelperAvailable(nativeOptions) && capture.permission() !== 'restricted',
      update:updater.getState(), ...(token && token === account.approvedToken ? config : {}), account:account.state}
  })
  handle('account-login', values => account.login(values))
  handle('account-register', values => account.register(values))
  handle('account-refresh', () => account.refresh())
  handle('open-admin-console', () => adminConsole.open(window, language))
  handle('account-logout', () => account.logout())
  handle('input-status', () => process.platform === 'darwin' ? InputBridge.macAccess(nativeOptions, false) : null)
  handle('screen-status', async () => {
    const { report } = await capture.inspect(true)
    const appPath = process.platform === 'darwin' && app.isPackaged ? path.resolve(path.dirname(app.getPath('exe')), '../..') : null
    return { ...report, appPath }
  })
  handle('open-input-settings', async () => {
    if (process.platform !== 'darwin') throw new Error('control-permission')
    await shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility')
    await InputBridge.macAccess({ resourcesPath: process.resourcesPath, isPackaged: app.isPackaged }, true)
  })
  handle('open-screen-settings', async () => {
    if (process.platform !== 'darwin') throw new Error('source-unavailable')
    await shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture')
  })
  handle('arm-system-picker', armSystemPicker)
  handle('disarm-system-picker', disarmSystemPicker)
  handle('test-native-display', testNativeDisplay)
  handle('cancel-native-display-test', () => diagnosticCapture?.stop())
  handle('pick-native-display', pickNativeDisplay)
  handle('native-frame-ack', (requestId, captureId) => {
    const selection = nativeSelection(requestId, captureId)
    return selection.bridge.requestFrame()
  })
  handle('stop-native-display', (requestId, captureId) => {
    nativeSelection(requestId, captureId)
    finish('本机已结束共享')
  })
  handle('renew-ice', async () => {
    const active = current
    if (!active || active.phase !== 'connected' || active.token !== account.approvedToken) throw new Error(messages.account_required)
    const iceServers = await active.network.getManagedIceServers(true)
    if (current !== active || active.token !== account.approvedToken) throw new Error('连接已结束。')
    return {iceServers, expiresAt:active.network.managedIceExpiresAt, unavailable:active.network.managedIceUnavailable}
  })
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
    await account.requireApproved()
    if (current || saveInProgress) throw new Error('请先结束当前配对，再修改网络设置。')
    saveInProgress = true
    try { await preferences.update({...values, relayUrl:''}) } finally { saveInProgress = false }
  })
  for (const role of ['host', 'viewer']) {
    handle(role === 'host' ? 'host' : 'join', async (invite, intent) => {
      const token = await account.requireApproved()
      const active = createSession(role, token)
      const options = { name: deviceName }
      try {
        return role === 'host'
          ? await active.network.host(options)
          : await active.network.join({ ...options, invite, intent })
      } catch (err) {
        if (current === active) finish(err.message, true)
        throw err
      }
    })
  }
  handle('prepare-host', async () => {
    // Keep a slow membership check out of the local display-picker gesture.
    // Publication and peer admission both verify membership with the service.
    const active = createSession('host', account.approvedToken)
    active.phase = 'preparing'
    await inputDrained
    requireHostPhase(active.requestId, 'preparing')
    return active.requestId
  })
  handle('reset-host-selection', requestId => {
    const active = requireHostPhase(requestId, 'prepared')
    if (pickerGrant) disarmSystemPicker(pickerGrant.id)
    discardHostScreen(active)
    active.phase = 'preparing'
  })
  handle('publish-host', async requestId => {
    const active = requireHostPhase(requestId, 'prepared')
    if (active.captureMode === 'native-display' && !active.nativeCapture?.displayId ||
        active.captureMode === 'screen' && !active.sourceRequested ||
        active.captureMode === 'system-picker' && !active.systemPicked) throw new Error('未获取到屏幕画面。')
    active.phase = 'pairing'
    active.preparedInvite = true
    try {
      if (await account.requireApproved() !== active.token) throw new Error(messages.account_required)
      requireHostPhase(requestId, 'pairing')
      return await active.network.host({name:deviceName})
    }
    catch (error) {
      if (current === active) finish(error.message, true)
      throw error
    }
  })
  handle('screens', async (requestId, explicitCheck) => {
    const active = requireHostPhase(requestId, 'pending', 'preparing')
    if (active.requestedFiles) throw new Error('文件会话未获双方确认。')
    const attempt = active.listAttempt = (active.listAttempt || 0) + 1
    active.choices = null
    active.screenError = null
    const revision = displayRevision
    const { sources, report } = await capture.inspect(explicitCheck === true)
    requireHostPhase(requestId, 'pending', 'preparing')
    if (active.listAttempt !== attempt) throw new Error('连接请求已失效。')
    active.screenError = report.errorCode || (revision !== displayRevision ? 'source-unavailable' : null)
    if (active.screenError) throw new Error(active.screenError)
    active.listedPermission = report.permission
    active.choices = new ScreenChoices(sources, screen.getAllDisplays(), screen.getPrimaryDisplay().id, revision)
    return active.choices.options
  })
  const selectSharing = async (allowControl, screenId, requestId, preparing) => {
    const active = requireHostPhase(requestId, preparing ? 'preparing' : 'pending')
    active.phase = preparing ? 'selecting' : 'approving'
    try {
      if (!preparing && (await account.requireApproved() !== active.token || current !== active)) throw new Error('连接请求已失效。')
      if (screenId === 'files') {
        if ((!preparing && !active.fileSessions) || allowControl !== false) throw new Error('文件会话未获双方确认。')
        active.choices = null
        active.captureMode = 'files'
        if (preparing) active.phase = 'prepared'
        else active.network.respond(true, 'files')
        return
      }
      if (active.requestedFiles) throw new Error('文件会话未获双方确认。')
      const permission = capture.permission()
      if (permission === 'restricted') throw new Error('permission-restricted')
      if (screenId === 'native-display') {
        requireNativePicker()
        active.captureMode = 'native-display'
      } else if (screenId === 'system-picker') {
        if (!capture.canUseSystemPicker || !active.screenError || active.screenError === 'permission-restricted' ||
            allowControl !== false) throw new Error('source-unavailable')
        active.captureMode = 'system-picker'
      } else {
        if (!active.choices) throw new Error(active.screenError || 'source-unavailable')
        const permissionError = screenSelectionError(permission, active.listedPermission)
        if (permissionError) throw new Error(permissionError)
        const { source, display } = active.choices.select(screenId, screen.getAllDisplays(), displayRevision)
        active.source = source
        active.display = display
        active.captureMode = 'screen'
      }
      if (allowControl === true) {
        if (!inputSupported || (active.captureMode !== 'native-display' && !active.display)) throw new Error('无法为所选显示器启用键鼠控制。')
        if (process.platform === 'darwin') {
          const access = await InputBridge.macAccess({ resourcesPath: process.resourcesPath, isPackaged: app.isPackaged })
          if (access === 'denied') throw new Error('control-permission')
          if (access !== 'granted') throw new Error('无法检查键鼠组件，请确认已完整安装 CC Connect。')
        }
      }
      if (current !== active || active.token !== account.approvedToken) throw new Error('连接请求已失效。')
      active.controlRequested = allowControl === true
      if (preparing) active.phase = 'prepared'
      else active.network.respond(true)
    } catch (err) {
      if (current === active && ['approving','selecting'].includes(active.phase)) {
        discardHostScreen(active)
        if (['source-unavailable', ...Object.values(permissionErrors)].includes(err.message)) {
          active.screenError = err.message
          active.choices = null
        }
        active.phase = preparing ? 'preparing' : 'pending'
      }
      throw err
    }
  }
  handle('select-sharing', (control, screenId, id) => selectSharing(control, screenId, id, true))
  handle('accept', (control, screenId, id) => selectSharing(control, screenId, id, false))
  handle('reject', requestId => {
    const active = requireHostPhase(requestId, 'pending')
    active.network.respond(false)
    if (current === active) finish('已拒绝请求')
  })
  handle('signal', payload => {
    if (current?.phase !== 'connected' || current.token !== account.approvedToken) throw new Error('连接已结束。')
    current.network.signal(payload)
  })
  handle('screen-stream-ready', async (requestId, captureId) => {
    const active = current
    if (!approvedHost() || active.requestId !== requestId || active.captureGranted || !active.sourceRequested) {
      throw new Error('连接请求已失效。')
    }
    const native = active.captureMode === 'native-display'
    if (native) {
      nativeSelection(requestId, captureId)
      requireNativePicker()
    } else {
      if (active.captureMode !== 'screen') throw new Error('连接请求已失效。')
      const error = screenSelectionError(capture.permission(), active.listedPermission)
      if (error) throw new Error(error)
    }
    // Consume the selected-source grant only after the renderer obtained video.
    active.sourceRequested = false
    if (active.controlRequested && (!native || active.display)) {
      if (active.input || !active.display) throw new Error('无法为所选显示器启用键鼠控制。')
      active.input = new InputBridge()
      active.input.on('error', err => disableInput(active, err.message))
      await inputDrained
      if (current !== active || !approvedHost()) throw new Error('连接请求已失效。')
      await active.input.start(active.display, { resourcesPath: process.resourcesPath, isPackaged: app.isPackaged })
      if (current !== active || !approvedHost()) { active.input.stop(); throw new Error('连接请求已失效。') }
      if (active.controlError) throw new Error(active.controlError)
      active.allowControl = true
      tray?.destroy()
      showSharingIndicator()
    }
    active.captureGranted = true
    return active.allowControl
  })
  ipcMain.on('jianping:input', (event, requestId, data) => {
    if (localFiles.open || !trusted(event.senderFrame) || current?.role !== 'host' ||
        current.phase !== 'connected' || current.requestId !== requestId || current.token !== account.approvedToken ||
        !current.allowControl || !current.captureGranted) return
    try { current.input.send(data) } catch (err) { disableInput(current, err.message) }
  })
  handle('disconnect', () => finish('本机已断开连接'))
  handle('copy', text => {
    if (typeof text !== 'string' || text.length > 16384) throw new Error('无法复制邀请。')
    clipboard.writeText(text)
  })
}

function approvedHost() {
  return current?.role === 'host' && current.phase === 'connected' && current.token === account.approvedToken
}

function maySelectDisplay() {
  return approvedHost() || (current?.role === 'host' && current.phase === 'prepared' &&
    current.token === account.approvedToken)
}

function requireNativePicker() {
  if (!nativePickerSupported || !nativeHelperAvailable(nativeOptions)) throw new Error('native-picker-unsupported')
  if (capture.permission() === 'restricted') throw new Error('permission-restricted')
}

function createNativeCapture(showCursor = true) {
  return new NativeScreenCapture({ ...nativeOptions, showCursor, isRestricted: () => capture.permission() === 'restricted' })
}

async function testNativeDisplay() {
  requireNativePicker()
  if (current || diagnosticCapture) throw new Error('native-picker-failed')
  const bridge = diagnosticCapture = createNativeCapture()
  try {
    // A previous session may still be releasing held buttons or draining stdin.
    await inputDrained
    if (bridge.closed || current) throw new Error('native-picker-cancelled')
    const { width, height } = await bridge.start()
    if (bridge.closed || current) throw new Error('native-picker-cancelled')
    requireNativePicker()
    return { width, height }
  } finally {
    bridge.stop()
    diagnosticCapture = null
  }
}

function nativeSelection(requestId, captureId) {
  const selection = current?.nativeCapture
  if (!approvedHost() || current.captureMode !== 'native-display' || current.requestId !== requestId ||
      !selection?.displayId || selection.id !== captureId || selection.bridge.closed) throw new Error('连接请求已失效。')
  return selection
}

async function pickNativeDisplay(requestId) {
  requireNativePicker()
  const active = current
  if (!maySelectDisplay() || active.requestId !== requestId || active.captureMode !== 'native-display' ||
      active.nativeCapture || active.input || diagnosticCapture) throw new Error('连接请求已失效。')
  const bridge = createNativeCapture(!active.controlRequested)
  const selection = active.nativeCapture = { id: randomUUID(), bridge }
  bridge.on('frame', ({ width, height, bytes }) => {
    if (current !== active || !approvedHost() || active.nativeCapture !== selection || !trusted(window?.webContents.mainFrame)) return
    if (!selection.delivered) {
      selection.delivered = true
      active.sourceRequested = true
    }
    send({ type: 'native-frame', requestId, captureId: selection.id, width, height, bytes })
  })
  bridge.on('ended', reason => {
    if (current === active && active.nativeCapture === selection && selection.displayId) {
      if (reason === 'permission-restricted') return finish('系统策略限制了录屏，请联系设备管理员。', true)
      finish(reason === 'native-picker-ended' ? '本机已结束共享' : '画面来源已结束，请重新配对。')
    }
  })
  try {
    await inputDrained
    if (bridge.closed || current !== active || !maySelectDisplay()) throw new Error('连接请求已失效。')
    const { displayId, width, height } = await bridge.start()
    if (bridge.closed || current !== active || !maySelectDisplay()) throw new Error('连接请求已失效。')
    requireNativePicker()
    active.display = screen.getAllDisplays().find(display => display.id === displayId)
    if (!active.display) bridge.restoreViewOnlyCursor()
    selection.displayId = displayId
    active.previousThrottling = window.webContents.getBackgroundThrottling()
    window.webContents.setBackgroundThrottling(false)
    return { captureId: selection.id, displayId, width, height, matched: Boolean(active.display) }
  } catch (error) {
    if (active.nativeCapture === selection) active.nativeCapture = null
    bridge.stop()
    throw error
  }
}

function grantSelectedDisplay(request, callback) {
  if (trusted(request.frame) && request.videoRequested && !request.audioRequested &&
      maySelectDisplay() && current.captureMode === 'screen' && current.source && !current.sourceRequested && !current.captureGranted &&
      !screenSelectionError(capture.permission(), current.listedPermission)) {
    current.sourceRequested = true
    callback({ video: current.source })
  } else callback(null)
}

function disarmSystemPicker(id, selected = false) {
  if (!pickerGrant || pickerGrant.id !== id) return false
  if (current?.requestId === pickerGrant.requestId && current.phase === 'prepared') current.systemPicked = selected === true
  clearTimeout(pickerGrant.timer)
  pickerGrant = null
  session.defaultSession.setDisplayMediaRequestHandler(grantSelectedDisplay)
  return true
}

function armSystemPicker(requestId) {
  if (!maySelectDisplay() || current.requestId !== requestId || current.captureMode !== 'system-picker' ||
      !capture.canUseSystemPicker || current.allowControl || pickerGrant) throw new Error('连接请求已失效。')
  if (capture.permission() === 'restricted') throw new Error('permission-restricted')
  const id = randomUUID()
  // Electron's native picker bypasses the custom source callback. Keep the
  // separate permission request handler active and consume one video request.
  session.defaultSession.setDisplayMediaRequestHandler(grantSelectedDisplay, { useSystemPicker: true })
  const timer = setTimeout(() => {
    if (pickerGrant?.id === id) finish('等待画面超时。请核实录屏权限和两端的网络设置。', true)
  }, 90_000)
  timer.unref()
  pickerGrant = { id, requestId, used: false, timer }
  return id
}

function configurePermissions() {
  const ses = session.defaultSession
  function allowed(contents, permission, details) {
    if (contents !== window?.webContents || !trusted(contents?.mainFrame) || permission !== 'display-capture' ||
        !details.isMainFrame || details.requestingUrl !== pageUrl || !maySelectDisplay()) return false
    return current.captureMode === 'screen' ? Boolean(current.source) :
      current.captureMode === 'system-picker' && pickerGrant?.requestId === current.requestId
  }
  ses.setPermissionCheckHandler((contents, permission, _origin, details) => allowed(contents, permission, details))
  ses.setPermissionRequestHandler((contents, permission, callback, details) => {
    if (!allowed(contents, permission, details) || details.mediaTypes?.includes('audio')) return callback(false)
    if (current.captureMode === 'system-picker') {
      if (pickerGrant.used) return callback(false)
      pickerGrant.used = true
    }
    callback(true)
  })
  ses.setDisplayMediaRequestHandler(grantSelectedDisplay)
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
  window.on('closed', () => { adminConsole?.close(); window = null })
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
  updater = new Updater({ app, request: systemUpdateTransport(net, session.defaultSession),
    emit: state => send({ type: 'update', state }), canInstall: () => !current })
  account = new DesktopAccount({
    directory: app.getPath('userData'), storage:safeStorage, base:managedUrl,
    fetchImpl: (url, init) => session.defaultSession.fetch(url, init),
    onChange: state => {
      adminConsole?.checkIdentity()
      if (current && current.token !== account.approvedToken) finish(state.message || '账号授权已结束。')
      send({type:'account', account:state})
    }
  })
  adminConsole = new AdminConsole({ BrowserWindow, session, account, origin: new URL(managedUrl).origin })
  preferences = new Settings(app.getPath('userData'), safeStorage)
  let startupError
  try { await preferences.load() } catch (err) { startupError = err.message }
  updateApplicationMenu()
  registerHandlers()
  configurePermissions()
  for (const event of ['suspend', 'lock-screen']) {
    powerMonitor.on(event, () => finish('设备已锁定或休眠'))
  }
  for (const event of ['display-removed', 'display-added', 'display-metrics-changed']) {
    screen.on(event, (_event, display, changedMetrics) => {
      const geometryChanged = event !== 'display-metrics-changed' || changedMetrics?.some(key => key !== 'workArea')
      if (geometryChanged) displayRevision++
      if (current?.captureMode === 'native-display' && !geometryChanged) return
      if (current?.display?.id === display.id || current?.nativeCapture?.displayId === display.id ||
          (current?.captureMode === 'screen' && !current.display && event !== 'display-metrics-changed')) {
        finish('共享显示器配置已更改，请重新配对')
      }
    })
  }
  openWindow()
  void account.restore().catch(() => {})
  if (startupError) window.webContents.once('did-finish-load', () => send({ type: 'error', message: startupError }))
})
app.on('before-quit', () => { updater?.cancel(); finish() })
app.on('window-all-closed', () => app.quit())
