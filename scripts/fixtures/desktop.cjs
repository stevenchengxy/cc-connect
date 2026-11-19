// A visible test window supplies an animated synthetic source. Always replace
// the capture target here so the integration test never reads the user's desktop.
const { app, BrowserWindow, clipboard, desktopCapturer, nativeImage, session, screen, shell, systemPreferences, safeStorage } = require('electron')
const path = require('node:path')
const {EventEmitter} = require('node:events')
const {PassThrough} = require('node:stream')

// Replace only the native child process. Framing, backpressure, local
// approval, display matching, JPEG decode and WebRTC use production code.
function installSyntheticPicker(ses,qa) {
  const bridge = require('../../native/screen-bridge.cjs')
  const Capture = bridge.NativeScreenCapture
  bridge.nativeHelperAvailable = () => true // This process uses the in-memory synthetic helper.
  if (process.argv.includes('--legacy-picker')) bridge.supportsNativePicker = () => false
  const width = 640, height = 360
  const images = [205,235].map(red => {
    const pixels = Buffer.alloc(width * height * 4,Buffer.from([38,32,red,255]))
    return nativeImage.createFromBitmap(pixels,{width,height,scaleFactor:1}).toJPEG(82)
  })
  bridge.NativeScreenCapture = class extends Capture {
    constructor(options) { super({...options,spawnProcess:open}) }
  }
  function open() {
    const child = new EventEmitter()
    child.stdin = new PassThrough()
    child.stdout = new PassThrough()
    const id = qa.nativeDisplayId
    qa.nativeStarts++
    qa.nativeActive++
    let timer, index = 0, ended = false
    const end = code => {
      if (ended) return
      ended = true
      clearInterval(timer)
      qa.nativeActive--
      qa.nativeStops++
      child.stdout.end()
      setImmediate(() => child.emit('exit',code))
    }
    child.kill = () => end(0)
    ses.stopSyntheticPicker = () => end(5)
    const produce = () => {
      if (ended || child.stdout.isPaused()) return
      const jpg = images[index++ % images.length]
      const header = Buffer.alloc(16)
      const fields = [id,width,height,jpg.length]
      fields.forEach((value,i) => header.writeUInt32BE(value,i * 4))
      qa.nativeFrames++
      child.stdout.write(Buffer.concat([header,jpg]))
    }
    if (qa.cancelNativePicker) setImmediate(() => end(3))
    else { timer = setInterval(produce,65); setImmediate(produce) }
    return child
  }
}

app.whenReady().then(async () => {
  const ses = session.defaultSession
  const captureQA = ses.captureQA = {screenPermission:'granted',listCalls:0,listFails:false,noDisplays:false,
    pickerCalls:0,cancelPicker:false,inputPermission:'granted',inputChecks:0,inputPrompts:0,inputSettingsOpened:0,inputStarts:0,inputEvents:[],
    nativeStarts:0,nativeStops:0,nativeActive:0,nativeFrames:0,nativeDisplayId:900001,
    cancelNativePicker:false,roomRequests:0}
  installSyntheticPicker(ses,captureQA)
  // Both test windows use an in-memory clipboard; the host OS clipboard is private.
  clipboard.writeText = value => { ses.qaCopiedText = value }
  const fixture = process.env.CC_QA_ACCOUNT_ORIGIN
  if (fixture) {
    const origin = new URL(fixture)
    if (origin.protocol !== 'http:' || origin.hostname !== '127.0.0.1') throw new Error('Invalid fixture origin')
    const fetch = ses.fetch.bind(ses)
    ses.fetch = (url, init) => {
      const target = new URL(url)
      if (target.pathname.startsWith('/v1/rooms/')) captureQA.roomRequests++
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
  if (fixture) {
    // No test input is injected into the operating system. The fixture
    // records the operations that reach the host's real session input gate.
    const {InputBridge} = require('../../native/bridge.cjs')
    InputBridge.macAccess = async (_options, request = false) => {
      if (request) captureQA.inputPrompts++
      else captureQA.inputChecks++
      return captureQA.inputPermission
    }
    const openExternal = shell.openExternal.bind(shell)
    shell.openExternal = async url => {
      if (url !== 'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility') return openExternal(url)
      captureQA.inputSettingsOpened++
      // Never open the operator's System Settings during an automated test.
    }
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
