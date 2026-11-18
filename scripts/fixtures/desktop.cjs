// A visible test window supplies an animated synthetic source. Always replace
// the capture target here so the integration test never reads the user's desktop.
const { app, BrowserWindow, desktopCapturer, session, screen, systemPreferences } = require('electron')
const path = require('node:path')
app.whenReady().then(async () => {
  const ses = session.defaultSession
  const setHandler = ses.setDisplayMediaRequestHandler.bind(ses)
  let source
  ses.setDisplayMediaRequestHandler = handler => setHandler((request, reply) => {
    handler(request, grant => {
      if (!grant?.video || !source) return reply(null)
      reply({ video: source.webContents.mainFrame })
    })
  })
  desktopCapturer.getSources = async () => [{ name: '测试屏幕', id: 'screen:synthetic', display_id: String(screen.getPrimaryDisplay().id) }]
  systemPreferences.getMediaAccessStatus = () => 'granted'
  if (process.argv.includes('--synthetic-source')) {
    source = new BrowserWindow({ width: 700, height: 380, title: 'CC Connect测试画面', webPreferences: { backgroundThrottling: false } })
    await source.loadFile(path.join(__dirname, 'source.html'))
  }
  require('../../src/main.cjs')
})
