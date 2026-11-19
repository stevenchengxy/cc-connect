// Manual CI on a fresh GitHub macOS VM. Drive only the installed package's own
// update buttons. The relaunch is performed by its original macOS installer.
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const {pathToFileURL} = require('node:url')
const {createReadStream} = require('node:fs')
const {createHash} = require('node:crypto')
const {execFileSync, spawn} = require('node:child_process')
const {setTimeout: wait} = require('node:timers/promises')
const {chromium} = require('playwright-core')
const {extractFile, uncache} = require('@electron/asar')

const appPath = '/Applications/CC Connect.app'
const executable = path.join(appPath,'Contents/MacOS/CC Connect')
const asarPath = path.join(appPath,'Contents/Resources/app.asar')
const {verifyManifest, compareVersions} = require('../src/updater.cjs')
const sourceVersion = process.env.UPDATE_FROM_VERSION
const targetVersion = require('../package.json').version
const manifestURL = 'https://cc-connect-desktop.stevenchengxy19.chatgpt.site/updates/latest.json'
const updates = path.join(os.homedir(),'Library/Application Support/CC Connect/updates')
const profile = path.dirname(updates)
const netLog = path.join(process.env.RUNNER_TEMP || os.tmpdir(),'cc-connect-update-netlog.json')

let launched
const version = () => { uncache(asarPath); return JSON.parse(extractFile(asarPath,'package.json')).version }
const exists = p => fs.access(p).then(()=>true,()=>false)

async function observe(f,ms) {
  const end = Date.now()+ms
  while (Date.now()<end) {
    const result = await f()
    if (result) return result
    await wait(350)
  }
  throw Error('Timed out waiting for the installed application')
}

function start() {
  const process = spawn(executable,['--remote-debugging-address=127.0.0.1','--remote-debugging-port=0',
    '--log-net-log='+netLog],{stdio:['ignore','ignore','pipe']})
  let address, logs = ''
  process.stderr.on('data',chunk=>{
    // Chromium writes URLs into its diagnostic output. Only retain its local
    // debugger address, never send HTTP URLs or signed asset query strings to CI.
    logs = (logs+chunk).slice(-32000)
    address ||= logs.match(/DevTools listening on (ws:\/\/127\.0\.0\.1:\d+\/devtools\/browser\/[a-f\d-]+)/i)?.[1]
  })
  return {process,address:()=>address}
}

async function waitPhase(page,expected,ms) {
  const end = Date.now()+ms
  while (Date.now()<end) {
    const phase = await page.locator('#update-status').getAttribute('data-state')
    if (phase===expected) return
    if (phase==='error') {
      const info=await page.evaluate(()=>window.jianping.info())
      throw Error('Packaged updater reported '+(info.update?.code || 'error')+' during '+expected)
    }
    await wait(500)
  }
  throw Error('Timed out reaching updater state '+expected)
}

async function checkDownload(target) {
  for (const name of await fs.readdir(updates)) {
    if (!name.startsWith('download-')) continue
    const file = path.join(updates,name,target.name)
    if (!await exists(file)) continue
    const hash = createHash('sha256')
    for await (const chunk of createReadStream(file)) hash.update(chunk)
    assert.equal(hash.digest('hex'),target.sha256)
    assert.equal((await fs.stat(file)).size,target.size)
    console.log('Downloaded DMG matched the signed size and SHA-256',target.size,target.sha256)
    return
  }
  throw Error('The packaged updater did not stage the expected DMG')
}

async function run() {
  assert.equal(process.platform,'darwin')
  assert.equal(process.env.GITHUB_ACTIONS,'true')
  assert.equal(process.env.RUNNER_ENVIRONMENT,'github-hosted')
  assert(compareVersions(targetVersion,sourceVersion) > 0, 'Expected an upgrade from the pinned public distribution')
  assert.equal(version(),sourceVersion)
  assert(await exists(executable))
  assert(!await exists(profile),'Expected a fresh disposable runner profile')
  const response = await fetch(manifestURL,{signal:AbortSignal.timeout(30000)})
  assert(response.ok, 'Could not retrieve public update manifest')
  const key = await fs.readFile(path.join(__dirname,'../src/update-public-key.pem'),'utf8')
  const manifest = verifyManifest(await response.json(),key)
  assert.equal(manifest.version,targetVersion)
  const old = start()
  launched = old.process
  const ws = await observe(()=>{
    if (old.process.exitCode!==null) throw Error('Old package exited before opening')
    return old.address()
  },30000)
  const browser = await chromium.connectOverCDP(ws)
  const homeURL = pathToFileURL(path.join(asarPath,'src/ui/index.html')).href
  const page = await observe(()=>browser.contexts().flatMap(c=>c.pages()).find(p=>p.url()===homeURL),20000)
  const appInfo=await page.evaluate(()=>window.jianping.info())
  assert.equal(appInfo.version,sourceVersion)
  console.log('Installed',sourceVersion,'app opened on fresh',process.arch,'GitHub Mac')
  await page.locator('#settings-button').click()
  await page.locator('#settings-dialog[open] #update-button').click()
  const updateAction = page.locator('#update-dialog[open] #update-action')
  await waitPhase(page,'available',60000)
  assert.equal((await page.evaluate(()=>window.jianping.info())).update.version,targetVersion)
  console.log('Packaged updater accepted the public signed manifest for',targetVersion)
  await updateAction.click()
  await waitPhase(page,'ready',240000)
  await checkDownload(manifest.files.mac)
  await updateAction.click()
  await observe(()=>old.process.exitCode!==null,70000)
  assert.equal(old.process.exitCode,0)
  await observe(async()=>await exists(asarPath) && version()===targetVersion,60000)
  const bundleId=execFileSync('/usr/libexec/PlistBuddy',['-c','Print :CFBundleIdentifier',appPath+'/Contents/Info.plist'],{encoding:'utf8'}).trim()
  assert.equal(bundleId,'app.jianping.desktop')
  assert.equal(execFileSync('/usr/libexec/PlistBuddy',['-c','Print :CFBundleShortVersionString',appPath+'/Contents/Info.plist'],{encoding:'utf8'}).trim(),targetVersion)
  execFileSync('/usr/bin/codesign',['--verify','--deep','--strict',appPath])
  assert(!await exists(path.join(os.homedir(),'Applications/CC Connect.app')))
  const swift = `import AppKit
let target="/Applications/CC Connect.app"
let stop=Date().addingTimeInterval(25)
while Date() < stop {
  let apps=NSRunningApplication.runningApplications(withBundleIdentifier:"app.jianping.desktop").filter{!$0.isTerminated}
  if apps.count == 1, apps[0].bundleURL?.path == target, apps[0].isFinishedLaunching, apps[0].processIdentifier != ${old.process.pid} {
    print(apps[0].processIdentifier);exit(0)
  }
  RunLoop.current.run(until:Date().addingTimeInterval(0.4))
}
exit(1)`
  const relaunchedPid = Number(execFileSync('/usr/bin/swift',['-'],{input:swift,encoding:'utf8',timeout:60000}).trim())
  assert(Number.isSafeInteger(relaunchedPid) && relaunchedPid > 0)
  execFileSync(executable,[],{stdio:'ignore',timeout:15000})
  process.kill(relaunchedPid,0)
  console.log('Relaunched',targetVersion,'at the original path. A second launch exited and the first instance stayed running.')
  const urls=new Set()
  for (const event of JSON.parse(await fs.readFile(netLog,'utf8')).events) {
    if (typeof event.params?.url!=='string') continue
    try { const u=new URL(event.params.url);urls.add(u.hostname+u.pathname) } catch {}
  }
  assert(urls.has('cc-connect-desktop.stevenchengxy19.chatgpt.site/updates/latest.json'))
  for (const part of manifest.files.mac.parts) {
    const asset = new URL(part.url)
    assert(urls.has(asset.hostname+asset.pathname))
  }
  assert([...urls].some(s=>s.startsWith('release-assets.githubusercontent.com/') || s.startsWith('objects.githubusercontent.com/')))
  console.log('Chromium network log confirmed production manifest, public GitHub release, and release-asset transfer')
}

run().catch(error=>{console.error(error.message);process.exitCode=1}).finally(async()=>{
  if (launched && launched.exitCode===null && !launched.signalCode) launched.kill('SIGTERM')
  await fs.rm(netLog,{force:true})
})
