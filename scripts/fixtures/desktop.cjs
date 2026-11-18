// A visible test window supplies an animated synthetic source. Always replace
// the capture target here so the integration test never reads the user's desktop.
const { app, BrowserWindow, clipboard, desktopCapturer, session, screen, systemPreferences, safeStorage } = require('electron')
const path = require('node:path')
app.whenReady().then(async () => {
  const ses = session.defaultSession
  // Both test windows use an in-memory clipboard; the host OS clipboard is private.
  clipboard.writeText = value => { ses.qaCopiedText = value }
  const fixture = process.env.CC_QA_ACCOUNT_ORIGIN
  if (fixture) {
    const origin = new URL(fixture)
    if (origin.protocol !== 'http:' || origin.hostname !== '127.0.0.1') throw new Error('Invalid fixture origin')
    const fetch = ses.fetch.bind(ses)
    ses.fetch = (url, init) => {
      const target = new URL(url)
      if (target.origin === 'https://cc-connect-pair.stevenchengxy19.chatgpt.site') return fetch(origin.origin + target.pathname, init)
      return fetch(url, init)
    }
    // Exercise the app's encrypted-file&IPC paths without modifying the operator's real keychain.
    const { randomBytes, createCipheriv, createDecipheriv } = require('node:crypto')
    const key = randomBytes(32)
    safeStorage.isAsyncEncryptionAvailable = async () => true
    if (process.platform === 'linux') safeStorage.getSelectedStorageBackend = () => 'gnome_libsecret'
    safeStorage.encryptStringAsync = async text => {
      const iv = randomBytes(12)
      const cipher = createCipheriv('aes-256-gcm',key,iv)
      const ciphertext = Buffer.concat([cipher.update(text),cipher.final()])
      return Buffer.concat([iv,cipher.getAuthTag(),ciphertext])
    }
    safeStorage.decryptStringAsync = async buffer => {
      const decipher = createDecipheriv('aes-256-gcm',key,buffer.subarray(0,12))
      decipher.setAuthTag(buffer.subarray(12,28))
      return {result:Buffer.concat([decipher.update(buffer.subarray(28)),decipher.final()]).toString()}
    }
  }
  const setHandler = ses.setDisplayMediaRequestHandler.bind(ses)
  let source
  // The native picker is simulated separately from the application's custom
  // source handler. Neither fixture path can capture the actual desktop.
  const captureQA = ses.captureQA = { screenPermission:'granted', listCalls:0, listFails:false, noDisplays:false,
    pickerCalls:0, cancelPicker:false, inputPermission:'granted', inputStarts:0, inputEvents:[] }
  if (fixture) {
    // No test input is injected into the operating system. The fixture
    // records the operations that reach the host's real session input gate.
    const {InputBridge} = require('../../native/bridge.cjs')
    InputBridge.macAccess = async () => captureQA.inputPermission
    InputBridge.prototype.start = async display => {
      if (display.id !== 900001 || captureQA.inputPermission !== 'granted') throw Error('control-permission')
      captureQA.inputStarts++
    }
    InputBridge.prototype.send = data => { captureQA.inputEvents.push(data); return true }
  }
  ses.setDisplayMediaRequestHandler = (handler, options) => setHandler((request, reply) => {
    if (options?.useSystemPicker) {
      captureQA.pickerCalls++
      return reply(!captureQA.cancelPicker && source ? {video:source.webContents.mainFrame} : null)
    }
    if (!handler) return reply(null)
    handler(request, grant => {
      if (!grant?.video || !source) return reply(null)
      reply({ video: source.webContents.mainFrame })
    })
  })
  const syntheticDisplay = {...screen.getPrimaryDisplay(), id:900001, label:'Synthetic QA screen'}
  screen.getPrimaryDisplay = () => syntheticDisplay
  screen.getAllDisplays = () => [syntheticDisplay]
  desktopCapturer.getSources = async () => {
    captureQA.listCalls++
    if (captureQA.listFails) throw Error('Failed to get sources')
    if (captureQA.noDisplays) return []
    return [{ name: '测试屏幕', id: 'screen:synthetic', display_id: String(screen.getPrimaryDisplay().id) }]
  }
  systemPreferences.getMediaAccessStatus = kind => kind === 'screen' ? captureQA.screenPermission : 'granted'
  if (process.argv.includes('--synthetic-source')) {
    source = new BrowserWindow({ width: 700, height: 380, title: 'CC Connect测试画面', webPreferences: { backgroundThrottling: false } })
    await source.loadFile(path.join(__dirname, 'source.html'))
  }
  require('../../src/main.cjs')
})
