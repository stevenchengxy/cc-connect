const { _electron } = require('playwright-core')
const assert = require('node:assert/strict')
const path = require('node:path')
const os = require('node:os')
const fs = require('node:fs/promises')
const { setTimeout: delay } = require('node:timers/promises')
const { spawn } = require('node:child_process')
const { randomBytes } = require('node:crypto')

const publicIceOnly = process.argv.includes('--public-ice-only')
const wan = publicIceOnly || process.argv.includes('--wan')
const loopbackRelay = process.argv.includes('--loopback-relay')
const legacyPicker = process.argv.includes('--legacy-picker')

async function observeInternetConnection(page) {
  await page.evaluate(restrictCandidates => {
    // The app still uses its own ICE configuration, encryption and consent flow.
    // In the stricter mode the receiving endpoint ignores every LAN candidate.
    const PeerConnection = window.RTCPeerConnection
    window.RTCPeerConnection = class extends PeerConnection {
      constructor(config) {
        super(config)
        window.testPeerConnection = this
      }
      addIceCandidate(candidate) {
        if (restrictCandidates && candidate && /\btyp host\b/.test(candidate.candidate)) return Promise.resolve()
        return super.addIceCandidate(candidate)
      }
      setRemoteDescription(description) {
        if (!restrictCandidates || !description.sdp) return super.setRemoteDescription(description)
        const sdp = description.sdp.split('\r\n').filter(line => !/^a=candidate:.*\btyp host\b/.test(line)).join('\r\n')
        return super.setRemoteDescription({...description, sdp})
      }
    }
  }, publicIceOnly)
}

async function verifyInternetConnection(page) {
  const {usesStun, remoteType, state} = await page.evaluate(async () => {
    const pc = window.testPeerConnection
    const usesStun = pc.getConfiguration().iceServers.some(server => [server.urls].flat().includes('stun:stun.cloudflare.com:3478'))
    const report = await pc.getStats()
    const transport = [...report.values()].find(stat => stat.type === 'transport' && stat.selectedCandidatePairId)
    const pair = report.get(transport?.selectedCandidatePairId)
    return {usesStun, state:pc.connectionState, remoteType:report.get(pair?.remoteCandidateId)?.candidateType}
  })
  assert(usesStun, 'Accepted managed internet pairing must activate STUN at both ends')
  assert.equal(state, 'connected')
  if (publicIceOnly) assert(['srflx','prflx','relay'].includes(remoteType), 'Selected remote candidate must not be a LAN host')
  return remoteType
}

async function verifyFileExchange(apps, pages, temp) {
  const dirs = await Promise.all(['host', 'viewer'].map(role => fs.mkdtemp(path.join(temp, role, 'transfer-qa-'))))
  const samples = [randomBytes(294913), randomBytes(32769)]
  for (const [index, dir] of dirs.entries()) {
    await fs.writeFile(path.join(dir, 'sample.bin'), samples[index])
    // Substitute only the native chooser in these isolated test processes.
    // File access, WebRTC transport and the receiving user's UI remain real.
    await apps[index].evaluate(({ dialog, session }, dir) => {
      const calls = session.defaultSession.fileDialogCalls = { open:0, save:0 }
      dialog.showOpenDialog = async () => {
        calls.open++
        return { canceled:false, filePaths:[dir + '/sample.bin'] }
      }
      dialog.showSaveDialog = async () => {
        calls.save++
        return { canceled:false, filePath:dir + '/received.bin' }
      }
    }, dir)
    await pages[index].locator('#file-send').waitFor({state:'visible'})
  }
  const expectPhase = (page, phase) => page.waitForFunction(phase =>
    document.getElementById('file-transfer').dataset.phase === phase, phase)
  const [host, viewer] = pages
  await viewer.locator('#file-send').click()
  await expectPhase(host, 'incoming')
  await host.locator('#file-cancel').click()
  await expectPhase(viewer, 'done')
  assert.equal(await apps[0].evaluate(({ session }) => session.defaultSession.fileDialogCalls.save), 0)
  await assert.rejects(fs.stat(path.join(dirs[0], 'received.bin')), {code:'ENOENT'})
  for (const [index, sender] of pages.entries()) {
    const receiver = pages[1-index]
    await sender.locator('#file-send').click()
    await expectPhase(receiver, 'incoming')
    await receiver.locator('#file-save').click()
    await expectPhase(receiver, 'done')
    await expectPhase(sender, 'done')
    assert.match(await receiver.locator('#file-status').textContent(), /文件已保存/)
    assert.match(await sender.locator('#file-status').textContent(), /文件已送达/)
    assert.deepEqual(await fs.readFile(path.join(dirs[1-index], 'received.bin')), samples[index])
  }
  console.log('Verified both file directions byte for byte and local refusal without writing a file.')
}

async function run() {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'jianping-e2e-'))
  const apps = []
  let relay, fixture
  async function launch(name) {
    const args = [path.join(__dirname, 'fixtures', 'desktop.cjs'), '--user-data-dir=' + path.join(temp, name)]
    if (legacyPicker) args.push('--legacy-picker')
    if (name === 'host') args.push('--synthetic-source')
    const instance = await _electron.launch({ executablePath: require('electron'), args, env:{...process.env, CC_QA_ACCOUNT_ORIGIN:fixture?.origin || ''} })
    apps.push(instance)
    for (let i = 0; i < 150; i++) {
      const page = instance.windows().find(w => w.url().endsWith('/src/ui/index.html'))
      if (page) {
        await page.waitForFunction(() => window.jianping && document.getElementById('device-name').textContent !== '正在读取设备…')
        const username = wan ? process.env['CC_QA_' + name.toUpperCase() + '_USERNAME'] : 'qa.' + name
        const password = wan ? process.env['CC_QA_' + name.toUpperCase() + '_PASSWORD'] : require('node:crypto').randomBytes(24).toString('base64url')
        if (!username || !password) throw new Error('Public account QA requires two explicitly provisioned QA accounts')
        const refuse = () => page.evaluate(async () => {
          const pairing = await Promise.allSettled([window.jianping.host(),window.jianping.prepareHost(),window.jianping.join('test')])
          return pairing.every(run => run.status === 'rejected')
        })
        assert(await refuse(), 'Signed-out host and join IPC must fail')
        const adminEntry = page.locator('#admin-button')
        const settings = page.locator('#settings-button')
        assert.equal(await adminEntry.isVisible(), false)
        await settings.press('Enter')
        await page.locator('#settings-dialog[open]').waitFor()
        assert(await page.locator('#language-select-button').isVisible())
        assert(await page.locator('#update-button').isVisible())
        assert.equal(await page.locator('#account-logout').isVisible(), false)
        assert.equal(await page.locator('#advanced-settings').isVisible(), false)
        await page.keyboard.press('Escape')
        if (fixture) await page.locator('#account-switch').click()
        await page.locator('#account-username').fill(username)
        await page.locator('#account-password').fill(password)
        if (fixture) {
          const invite = await fixture.invite()
          assert.match(invite, /^[2-9A-HJ-NP-Z]{4}-[2-9A-HJ-NP-Z]{4}$/)
          await page.locator('#register-invite').fill(name === 'host' ? invite.toLowerCase().replace('-', '') : invite)
        }
        await page.locator('#account-submit').click()
        if (fixture) {
          await page.locator('#account-refresh').waitFor({state:'visible'})
          assert.equal(await adminEntry.isVisible(), false)
          assert(await refuse(), 'Pending accounts must be blocked by both pairing IPC paths')
          await fixture.setStatus(username,'approved')
          await page.locator('#account-refresh').click()
        }
        await page.locator('#join-button').waitFor({state:'visible'})
        if (fixture) assert.equal(await adminEntry.isVisible(), false)
        const island = page.locator('#island-toggle')
        await island.press('Enter')
        assert.equal(await island.getAttribute('aria-expanded'), 'true')
        await island.press('Escape')
        assert.equal(await island.getAttribute('aria-expanded'), 'false')
        await settings.click()
        assert(await page.locator('#account-logout').isVisible())
        assert(await page.locator('#advanced-settings summary').isVisible())
        assert.equal(await page.locator('#turn-url').isVisible(), false)
        await page.locator('#advanced-settings summary').press('Enter')
        assert(await page.locator('#turn-url').isVisible())
        await page.locator('#advanced-settings summary').press('Enter')
        await page.locator('#language-select').selectOption('en')
        await page.waitForFunction(() => document.documentElement.lang === 'en')
        assert.equal(await page.locator('#join-button').innerText(), 'Connect')
        await page.locator('#language-select').selectOption('zh-TW')
        await page.waitForFunction(() => document.documentElement.lang === 'zh-TW')
        assert.equal(await page.locator('#host-tab').innerText(), '分享此電腦')
        await page.locator('#language-select').selectOption('zh-CN')
        await page.waitForFunction(() => document.documentElement.lang === 'zh-CN')
        await page.locator('#close-settings').click()
        return page
      }
      await delay(200)
    }
    throw Error('应用窗口未就绪')
  }
  try {
    if (loopbackRelay) relay=await require('./fixtures/loopback-turn.cjs').startLoopbackTurn()
    if (!wan) fixture=await require('./fixtures/account-service.cjs').startAccountFixture(relay)
    const host = await launch('host')
    const viewer = await launch('viewer')
    const localCaptureQA = !!fixture && !relay
    const setCaptureQA = update => apps[0].evaluate(({session}, update) => {
      Object.assign(session.defaultSession.captureQA, update)
    }, update)
    const readCaptureQA = () => apps[0].evaluate(({session}) => ({...session.defaultSession.captureQA}))
    const pickerSupported = await apps[0].evaluate(() => process.platform === 'darwin' && Number.parseInt(process.getSystemVersion()) >= 15)
    const nativePicker = localCaptureQA && await host.evaluate(async () => (await window.jianping.info()).canUseNativeScreenPicker)
    async function waitForVideo() {
      await viewer.waitForFunction(() => {
        const video = document.getElementById('remote-video')
        return video.videoWidth > 0 && video.getVideoPlaybackQuality().totalVideoFrames >= 3
      }, null, {timeout:wan ? 60000 : 20000})
    }
    async function waitForNotice(id, text) {
      await host.waitForFunction(({id,text}) => {
        const notice = document.getElementById(id)
        return !notice.hidden && notice.textContent.includes(text)
      }, {id,text})
    }
    if (wan) await Promise.all([observeInternetConnection(host), observeInternetConnection(viewer)])
    if (relay) for (const page of [host,viewer]) {
      await page.evaluate(() => {
        const Native = window.RTCPeerConnection
        const localOnly = config => ({...config, iceTransportPolicy:'relay',
          iceServers:config.iceServers.filter(server => [server.urls].flat().some(url => url.startsWith('turn:127.0.0.1:')))})
        window.RTCPeerConnection = class extends Native {
          constructor(config) {
            super(localOnly(config)); window.testPeerConnection = this; this.restarts=0; this.relayErrors=[]
            this.addEventListener('icecandidateerror',event => this.relayErrors.push([event.errorCode,event.errorText]))
          }
          setConfiguration(config) { return super.setConfiguration(localOnly(config)) }
          async createOffer(options) { if (options?.iceRestart) this.restarts++; return super.createOffer(options) }
        }
        window.testCaptures=0
        const capture=navigator.mediaDevices.getDisplayMedia.bind(navigator.mediaDevices)
        navigator.mediaDevices.getDisplayMedia=async options=>{const stream=await capture(options); window.testCaptures++; return stream}
      })
    }
    const duplicate = spawn(require('electron'), [path.resolve(__dirname, '..'), '--user-data-dir=' + path.join(temp, 'viewer')], { stdio: 'ignore' })
    const exitCode = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => { duplicate.kill(); reject(new Error('Duplicate application instance did not exit')) }, 10000)
      duplicate.once('error', error => { clearTimeout(timeout); reject(error) })
      duplicate.once('exit', code => { clearTimeout(timeout); resolve(code) })
    })
    assert.equal(exitCode, 0, 'a second instance must yield to the existing application')
    assert.equal(await viewer.locator('#language-select-button').getAttribute('role'), 'combobox')
    await viewer.locator('#quality-select-button').click()
    await viewer.locator('#quality-select-button').press('Home')
    await viewer.locator('#quality-select-button').press('Enter')
    assert.equal(await viewer.locator('#quality-select').inputValue(), 'smooth')
    await viewer.locator('#quality-select').selectOption('balanced')
    const captureIsDenied = () => host.evaluate(async () => {
      try {
        const stream = await navigator.mediaDevices.getDisplayMedia({ video: true })
        stream.getTracks().forEach(t => t.stop())
        return false
      } catch { return true }
    })
    assert.equal(await captureIsDenied(), true, 'before consent the app must deny screen capture')
    if (localCaptureQA) {
      const before = await readCaptureQA()
      const failures = await host.evaluate(async () => {
        const api = window.jianping
        const calls = await Promise.allSettled([api.screens('stale'), api.armSystemPicker('stale'),
          api.accept(false,'system-picker','stale')])
        return calls.map(call => call.status)
      })
      assert.deepEqual(failures,['rejected','rejected','rejected'])
      if (process.platform !== 'darwin') assert.equal(await host.evaluate(() => window.jianping.inputStatus()), null)
      assert.equal((await readCaptureQA()).listCalls, before.listCalls)
      assert.equal((await readCaptureQA()).pickerCalls, 0)
      await setCaptureQA({listFails:true})
      await host.locator('#settings-button').click()
      await host.locator('#screen-check').click()
      await waitForNotice('screen-check-result','无法列出屏幕')
      if (process.platform === 'darwin') assert.match(await host.locator('#screen-check-result').innerText(), /权限已开启/)
      await host.locator('#close-settings').click()
      await setCaptureQA({listFails:false})
    }
    if (nativePicker) {
      await host.evaluate(() => {
        const RTC = window.RTCPeerConnection
        window.qaRoomConnections = 0
        window.qaNativeFrameEvents = 0
        window.RTCPeerConnection = class extends RTC {
          constructor(config) { super(config); window.qaRoomConnections++ }
        }
        window.jianping.onEvent(event => { if (event.type === 'native-frame') window.qaNativeFrameEvents++ })
      })
      await setCaptureQA({screenPermission:'denied',listFails:true,inputPermission:'denied',cancelNativePicker:true})
      const before = await readCaptureQA()
      await host.locator('#settings-button').click()
      await waitForNotice('input-check-result','键鼠控制需要辅助功能授权')
      await host.locator('#screen-check').click()
      await waitForNotice('screen-check-result','预检未确认')
      assert(await host.locator('#settings-input-settings').isVisible())
      const choose = host.locator('#settings-native-display')
      await choose.click()
      await waitForNotice('screen-check-result','已取消选择屏幕')
      assert.equal((await readCaptureQA()).nativeActive,0)
      await setCaptureQA({cancelNativePicker:false})
      await choose.click()
      await waitForNotice('screen-check-result','640 × 360')
      const after = await readCaptureQA()
      assert.equal(after.nativeStarts,before.nativeStarts + 2)
      assert.equal(after.nativeStops,before.nativeStops + 2)
      assert.equal(after.nativeActive,0)
      assert.equal(after.nativeFrames,before.nativeFrames + 1)
      assert.equal(after.roomRequests,before.roomRequests)
      assert.equal(after.inputStarts,before.inputStarts)
      assert.deepEqual(await host.evaluate(() => [window.qaRoomConnections,window.qaNativeFrameEvents]),[0,0])
      assert.equal(after.inputPrompts, before.inputPrompts, 'Reading permissions must not request new Accessibility access')
      await host.locator('#settings-input-settings').click()
      await apps[0].evaluate(async ({session}, previousChecks) => {
        for (let i = 0; i < 100; i++) {
          const qa = session.defaultSession.captureQA
          if (qa.inputSettingsOpened && qa.inputPrompts && qa.inputChecks > previousChecks) return
          await new Promise(resolve => setTimeout(resolve, 50))
        }
        throw Error('The isolated Accessibility settings action did not finish')
      },after.inputChecks)
      const inSettings = await readCaptureQA()
      assert.equal(inSettings.inputSettingsOpened,after.inputSettingsOpened + 1)
      assert.equal(inSettings.inputPrompts,after.inputPrompts + 1)
      await setCaptureQA({inputPermission:'granted'})
      // Drive the same event macOS returns to the renderer. Playwright forces
      // window focus and must not steal focus from the operator's actual apps.
      await host.evaluate(() => window.dispatchEvent(new FocusEvent('focus')))
      await waitForNotice('input-check-result','已获辅助功能授权')
      assert.equal(await host.locator('#settings-input-settings').isVisible(),false)
      assert.match(await host.locator('#screen-check-result').innerText(),/640 × 360/)
      const returned = await readCaptureQA()
      assert(returned.inputChecks > inSettings.inputChecks)
      assert.equal(returned.inputPrompts,inSettings.inputPrompts)
      for (const key of ['listCalls','pickerCalls','nativeStarts','nativeFrames','roomRequests','inputStarts']) {
        assert.equal(returned[key],after[key], 'Returning from Accessibility settings must leave ' + key + ' unchanged')
      }
      await host.locator('#screen-check').click()
      await waitForNotice('screen-check-result','预检未确认')
      await waitForNotice('screen-native-history','640 × 360')
      assert.match(await host.locator('#screen-native-history').innerText(), /上次本地检测/)
      const reread = await readCaptureQA()
      assert.equal(reread.nativeStarts,returned.nativeStarts)
      assert.equal(reread.listCalls,returned.listCalls + 1)
      await host.locator('#close-settings').click()
      await host.locator('#settings-button').click()
      await waitForNotice('screen-native-history','640 × 360')
      await waitForNotice('input-check-result','已获辅助功能授权')
      assert.equal((await readCaptureQA()).listCalls,reread.listCalls)
      await setCaptureQA({screenPermission:'restricted'})
      await host.locator('#screen-check').click()
      await waitForNotice('screen-check-result','系统策略')
      assert.equal(await choose.isVisible(),false)
      assert.equal(await host.locator('#screen-native-history').isVisible(),false)
      await assert.rejects(host.evaluate(() => window.jianping.testNativeDisplay()), /permission-restricted/)
      assert.equal((await readCaptureQA()).nativeStarts,reread.nativeStarts)
      await host.locator('#close-settings').click()
      await setCaptureQA({screenPermission:'granted',listFails:false})
      console.log('Verified Accessibility grant on focus return with no additional screen enumeration, picker, permission prompt or remote input. Local diagnostic history survives recheck and settings reopen, and a current policy restriction blocks capture.')
    }
    await host.locator('#host-tab').click()
    async function readCopiedCode(predicate) {
      for (let attempt = 0; attempt < 50; attempt++) {
        const value = await apps[0].evaluate(({session}) => session.defaultSession.qaCopiedText)
        if (typeof value === 'string' && predicate(value)) return value
        await delay(50)
      }
      throw Error('The copy action did not deliver the expected invitation to the test clipboard')
    }
    async function pair(copyCompatible = false, fileOnly = false) {
      await fixture?.waitForHostSlot()
      await host.locator('#host-review').click()
      await host.locator('#host-invite').waitFor({ state: 'visible' })
      const shortCode = await host.locator('#host-invite').inputValue()
      assert.match(shortCode, /^[2-9A-HJ-NP-Z]{4}-[2-9A-HJ-NP-Z]{4}-[2-9A-HJ-NP-Z]{4}$/)
      let invite = shortCode
      if (copyCompatible) {
        const invitationNotice = await host.locator('#home-notice').textContent()
        await host.locator('#copy-button').press('Enter')
        await readCopiedCode(value => value === shortCode)
        await host.waitForFunction(() => document.getElementById('copy-button').classList.contains('copied'))
        assert.match(await host.locator('#copy-feedback').textContent(), /已复制/)
        assert.equal(await host.locator('#home-notice').textContent(), invitationNotice)
        await host.getByRole('button', {name:/旧版|兼容/}).click()
        invite = await readCopiedCode(value => value.startsWith('RD1.'))
        const legacy = JSON.parse(Buffer.from(invite.slice(4), 'base64url'))
        const {normalizePairCode, pairSecret} = require('../src/pair-code.cjs')
        const key = await pairSecret(normalizePairCode(shortCode))
        assert(legacy.key === key.toString('base64url'), 'Both copy actions must refer to one host invitation')
      }
      await viewer.locator('#invite-input').fill(invite)
      await viewer.locator(fileOnly ? '#join-files' : '#join-button').click()
      await host.locator('#consent[open]').waitFor()
      assert.equal(await viewer.locator(fileOnly ? '#join-files' : '#join-button').getAttribute('aria-busy'), 'true')
      assert.equal(await viewer.locator(fileOnly ? '#join-button' : '#join-files').getAttribute('aria-busy'), 'false')
      assert.equal(await host.locator('#copy-feedback').textContent(), '')
      assert.equal(await host.locator('#host-invite').isVisible(), false, 'A claimed code must no longer be offered for copying')
      assert.equal(await viewer.locator('#invite-input').inputValue(), '', 'A claimed code must not be reused on reconnection')
      assert.equal(await host.locator('#allow-control').isChecked(), false)
    }
    await pair(!!fixture)
    await host.locator('#reject').click()
    await viewer.waitForFunction(() => document.getElementById('top-status').textContent === '待连接')
    if (fixture) {
      const beforeFiles = await readCaptureQA()
      await setCaptureQA({screenPermission:'restricted',listFails:true})
      await pair(false,true)
      assert.equal(await host.locator('#allow-control').isVisible(), false)
      await host.locator('#accept-files').click()
      for (const page of [host,viewer]) await page.locator('#session[data-mode="files"]').waitFor()
      assert.equal((await readCaptureQA()).listCalls, beforeFiles.listCalls)
      assert.equal((await readCaptureQA()).inputStarts, beforeFiles.inputStarts)
      assert(await captureIsDenied(), 'A file session must never enable screen capture')
      assert.equal(await viewer.locator('#remote-video').evaluate(video => video.srcObject), null)
      await verifyFileExchange(apps, [host,viewer], temp)
      await host.locator('#end-session').click()
      await viewer.waitForFunction(() => document.getElementById('top-status').textContent === '待连接')
      await setCaptureQA({screenPermission:'granted',listFails:false})
      console.log('Verified approved members can transfer files in a data-only call while screen capture is restricted.')
    }
    if (localCaptureQA && pickerSupported && !nativePicker) {
      await setCaptureQA({listFails:true,cancelPicker:true})
      await pair()
      await waitForNotice('consent-notice','无法列出屏幕')
      assert(await host.locator('#allow-control').isDisabled())
      await host.locator('#use-system-picker').click()
      const resume = host.locator('#resume-capture')
      await resume.waitFor()
      assert.equal((await readCaptureQA()).pickerCalls, 0, 'Only a local share action may open the picker')
      assert(await captureIsDenied(), 'Approving a picker session alone must not grant capture')
      await resume.click()
      await host.locator('#session-notice').waitFor({state:'visible'})
      await resume.waitFor()
      assert.equal((await readCaptureQA()).pickerCalls, 1)
      assert.equal(await viewer.locator('#remote-video').evaluate(video => video.srcObject), null)
      assert(await captureIsDenied(), 'Cancelling the picker must withdraw the capture grant')
      await setCaptureQA({cancelPicker:false})
      await resume.click()
      await waitForVideo()
      assert.equal((await readCaptureQA()).pickerCalls, 2)
      assert.match(await host.locator('#permission-state').innerText(), /仅观看/)
      assert.match(await viewer.locator('#permission-state').innerText(), /仅观看/)
      await host.locator('#end-session').click()
      await viewer.waitForFunction(() => document.getElementById('top-status').textContent === '待连接')
      console.log('Verified consent-bound synthetic picker, cancellation, retry, decoded frames and view-only mode.')
    }
    if (localCaptureQA && process.platform === 'darwin') {
      await setCaptureQA({screenPermission:'denied', listFails:false, inputPermission:'denied'})
      await pair()
      await waitForNotice('consent-notice','录屏设置')
      await host.locator('#retry-screens').click()
      await host.locator('#allow-control').check()
      await host.locator('#accept').click()
      await waitForNotice('consent-notice','键鼠控制尚未获准')
      assert(await host.locator('#consent-input-settings').isVisible())
      assert.equal((await readCaptureQA()).inputStarts, 0)
      assert.equal(await viewer.locator('#remote-video').evaluate(v => v.srcObject), null)
      await setCaptureQA({inputPermission:'granted'})
      await host.locator('#accept').click()
      const resume = host.locator('#resume-capture')
      if (await resume.isVisible()) await resume.click()
      await waitForVideo()
      await viewer.waitForFunction(() => document.getElementById('permission-state').textContent.includes('可控制'))
      const hidden = await viewer.locator('#remote-video').evaluate(el => getComputedStyle(el).cursor === 'none')
      const cursorMode = await host.evaluate(() => room.stream.getVideoTracks()[0].getSettings().cursor)
      assert.equal(hidden,['motion','always'].includes(cursorMode), 'Only suppress the viewer pointer when capture contains one')
      await viewer.locator('#remote-video').click()
      await viewer.keyboard.press('KeyK')
      await apps[0].evaluate(async ({session}) => {
        for (let i = 0; i < 60; i++) {
          const {inputEvents} = session.defaultSession.captureQA
          if (inputEvents.some(e => e.kind === 'button' && e.down) &&
              inputEvents.some(e => e.kind === 'key' && e.code === 'KeyK' && !e.down)) return
          await new Promise(resolve => setTimeout(resolve, 50))
        }
        throw Error('Expected mouse and keyboard input on the approved host')
      })
      assert.equal((await readCaptureQA()).inputStarts, 1)
      await host.locator('#end-session').click()
      await viewer.waitForFunction(() => document.getElementById('top-status').textContent === '待连接')
      console.log('Verified approved member control with stale screen preflight, explicit control consent, Accessibility retry, live video, keyboard and mouse delivery to the isolated host input bridge.')
    }
    if (nativePicker) {
      const initial = await readCaptureQA()
      await setCaptureQA({screenPermission:'denied',listFails:true,inputPermission:'granted',cancelNativePicker:true,inputEvents:[]})
      await pair()
      await host.locator('#retry-screens').click()
      await waitForNotice('consent-notice','预检未确认')
      await host.locator('#allow-control').check()
      await host.locator('#use-system-picker').click()
      const resume = host.locator('#resume-capture')
      await resume.waitFor()
      assert.equal((await readCaptureQA()).nativeStarts,initial.nativeStarts)
      assert(await captureIsDenied(), 'Approving a native picker must not grant general display capture')
      await resume.click()
      await waitForNotice('session-notice','已取消选择屏幕')
      assert.equal((await readCaptureQA()).inputStarts,initial.inputStarts)
      assert.equal(await viewer.locator('#remote-video').evaluate(v => v.srcObject),null)
      await setCaptureQA({cancelNativePicker:false})
      await resume.click()
      await waitForVideo()
      await viewer.waitForFunction(() => document.querySelector('#permission-state').textContent.includes('可控制'))
      const frame = await viewer.locator('#remote-video').evaluate(video => {
        const canvas = document.createElement('canvas')
        canvas.width = canvas.height = 1
        const context = canvas.getContext('2d')
        context.drawImage(video,0,0,1,1)
        return [video.videoWidth,video.videoHeight,...context.getImageData(0,0,1,1).data]
      })
      assert.deepEqual(frame.slice(0,2),[640,360])
      assert.notEqual(await viewer.locator('#remote-video').evaluate(v => getComputedStyle(v).cursor),'none',
        'The native controlled display omits its encoded cursor and uses the responsive local pointer')
      assert(frame[2] > 160 && frame[3] < 75 && frame[4] < 75,'The viewer should decode the synthetic red JPEG')
      await host.evaluate(() => window.jianping.input('stale-room',{kind:'key',code:'KeyB',down:true}))
      await viewer.locator('#remote-video').click()
      await viewer.keyboard.press('KeyJ')
      await apps[0].evaluate(async ({session}) => {
        const state = session.defaultSession.captureQA
        for (let i=0; i<60; i++) {
          if (state.inputEvents.some(e => e.kind === 'button' && e.down) &&
              state.inputEvents.some(e => e.kind === 'key' && e.code === 'KeyJ' && !e.down)) return
          await new Promise(resolve => setTimeout(resolve,50))
        }
        throw Error('Synthetic remote input did not reach the selected display')
      })
      const controlled = await readCaptureQA()
      assert.equal(controlled.inputStarts,initial.inputStarts + 1)
      assert(!controlled.inputEvents.some(e => e.code === 'KeyB'), 'An earlier session cannot authorize input')
      await apps[0].evaluate(({session}) => session.defaultSession.stopSyntheticPicker())
      await viewer.waitForFunction(() => document.getElementById('top-status').textContent === '待连接')
      assert.equal(await viewer.locator('#remote-video').evaluate(v => v.srcObject),null)
      const beforeUnmatched = await readCaptureQA()
      await setCaptureQA({nativeDisplayId:900002})
      await pair()
      await host.locator('#allow-control').check()
      await host.locator('#use-system-picker').click()
      await resume.click()
      await waitForVideo()
      await waitForNotice('session-notice','仅共享画面')
      assert.match(await viewer.locator('#permission-state').innerText(),/仅观看/)
      assert.equal((await readCaptureQA()).inputStarts,beforeUnmatched.inputStarts)
      await host.locator('#end-session').click()
      await viewer.waitForFunction(() => document.getElementById('top-status').textContent === '待连接')
      assert.equal((await readCaptureQA()).nativeActive,0)
      await setCaptureQA({nativeDisplayId:900001})
      console.log('Verified native selection after failed enumeration, cancelled selection then retry, decoded 640×360 JPEGs, input after fresh frames, source shutdown and unmatched display view-only.')
    }
    if (localCaptureQA) {
      await setCaptureQA({screenPermission:'granted',listFails:false,noDisplays:false,inputPermission:'granted'})
      const hostButton = host.locator('#host-button')
      const code = host.locator('#host-invite')
      const stop = async () => {
        await host.locator('#end-session').click()
        await viewer.waitForFunction(() => document.getElementById('top-status').textContent === '待连接')
        await hostButton.waitFor({state:'visible'})
      }
      const connectWithCode = async (files = false) => {
        await code.waitFor({state:'visible'})
        const invite = await code.inputValue()
        await viewer.locator('#invite-input').fill(invite)
        await viewer.locator(files ? '#join-files' : '#join-button').click()
        return invite
      }
      const supportsInput = await host.evaluate(async () => (await window.jianping.info()).inputSupported)
      await hostButton.click()
      await host.locator('#consent[open]').waitFor()
      assert.equal(await code.isVisible(),false)
      assert.equal(await host.locator('#allow-control').isChecked(),false)
      if (supportsInput) await host.locator('#allow-control').check()
      await host.locator('#accept').click()
      await code.waitFor({state:'visible'})
      assert.match(await host.locator('#host-scope').innerText(),supportsInput ? /键鼠/ : /仅观看/)
      const first = await code.inputValue()
      await host.locator('#cancel-host').click()
      await hostButton.waitFor({state:'visible'})
      assert(await captureIsDenied(), 'Cancelling the prepared invite must revoke the capture grant')
      await hostButton.click()
      await code.waitFor({state:'visible'})
      assert.notEqual(await code.inputValue(),first)
      assert.equal(await host.locator('#consent').isVisible(),false, 'The same monitor should not need another selection')
      const listed = (await readCaptureQA()).listCalls
      const beforeConnect = await readCaptureQA()
      const codeUsed = await connectWithCode()
      await waitForVideo() // No host actions after publishing the code.
      assert.equal((await readCaptureQA()).listCalls,listed)
      assert.equal(await host.locator('#consent').isVisible(),false)
      assert.equal(await code.inputValue(),'')
      let throttling
      if (process.argv.includes('--weak-network')) {
        throttling = await host.context().newCDPSession(host)
        await throttling.send('Network.emulateNetworkConditionsByRule', {matchedNetworkConditions:[{
          urlPattern:'',uploadThroughput:90000,downloadThroughput:250000,latency:50,
          packetLoss:4,packetQueueLength:30,packetReordering:true
        }]})
        const initial = await viewer.locator('#remote-video').evaluate(v => v.getVideoPlaybackQuality().totalVideoFrames)
        await viewer.waitForFunction(n => document.querySelector('#remote-video').getVideoPlaybackQuality().totalVideoFrames >= n + 12, initial)
      }
      if (supportsInput) {
        await viewer.waitForFunction(() => document.querySelector('#permission-state').textContent.includes('可控制'))
        await viewer.locator('#remote-video').click()
        await viewer.keyboard.press('KeyM')
        await apps[0].evaluate(async ({session},offset) => {
          for (let i=0; i<100; i++) {
            const events = session.defaultSession.captureQA.inputEvents.slice(offset)
            if (events.some(e => e.kind === 'button' && e.down) &&
                events.some(e => e.kind === 'key' && e.code === 'KeyM' && !e.down)) return
            await new Promise(resolve => setTimeout(resolve,50))
          }
          throw Error('An explicitly control-enabled code failed to deliver keyboard and mouse input')
        },beforeConnect.inputEvents.length)
      }
      if (throttling) {
        await throttling.send('Network.emulateNetworkConditionsByRule',{matchedNetworkConditions:[]})
        await throttling.detach()
        console.log('Under a simulated 720 kbps uplink, 4% packet loss and reordering, the client continued receiving frames and delivered input.')
      }
      await stop()
      await viewer.locator('#invite-input').fill(codeUsed)
      await viewer.locator('#join-button').click()
      await viewer.locator('#home-notice.error').waitFor({state:'visible'})
      assert.equal(await viewer.locator('#remote-video').evaluate(v => v.srcObject),null)

      // A files-only invitation cannot be upgraded by the viewer's Screen button.
      await setCaptureQA({screenPermission:'restricted',listFails:true})
      const beforeFileCode = await readCaptureQA()
      await host.locator('#host-files').click()
      await connectWithCode()
      for (const page of [host,viewer]) await page.locator('#session[data-mode="files"]').waitFor()
      assert.equal(await viewer.locator('#remote-video').evaluate(v => v.srcObject),null)
      assert.equal((await readCaptureQA()).listCalls,beforeFileCode.listCalls)
      assert.equal((await readCaptureQA()).inputStarts,beforeFileCode.inputStarts)
      await stop()
      await setCaptureQA({screenPermission:'granted',listFails:false})
      // Conversely, a files-only request must release an already prepared screen.
      await hostButton.click()
      await connectWithCode(true)
      for (const page of [host,viewer]) await page.locator('#session[data-mode="files"]').waitFor()
      assert.equal(await viewer.locator('#remote-video').evaluate(v => v.srcObject),null)
      assert(await captureIsDenied())
      await stop()

      if (nativePicker) {
        await setCaptureQA({listFails:true,cancelNativePicker:true,inputPermission:'granted'})
        const before = await readCaptureQA()
        await host.locator('#host-options').click()
        await host.locator('#use-system-picker').click()
        await waitForNotice('consent-notice','已取消选择屏幕')
        assert.equal(await code.isVisible(),false)
        assert.equal((await readCaptureQA()).nativeActive,0)
        await setCaptureQA({cancelNativePicker:false})
        await host.locator('#use-system-picker').click()
        await code.waitFor({state:'visible'})
        assert.equal((await readCaptureQA()).nativeActive,1)
        const starts = (await readCaptureQA()).nativeStarts
        await connectWithCode()
        await waitForVideo()
        assert.equal((await readCaptureQA()).nativeStarts,starts, 'Joining must reuse the system-selected stream')
        assert.equal(starts,before.nativeStarts + 2)
        await stop()
        assert.equal((await readCaptureQA()).nativeActive,0)
        // If macOS ends its selected source before anyone joins, the
        // published invitation must go away along with the local capture.
        await hostButton.click()
        await code.waitFor({state:'visible'})
        await apps[0].evaluate(({session}) => session.defaultSession.stopSyntheticPicker())
        await hostButton.waitFor({state:'visible'})
        assert.equal(await code.inputValue(),'')
        assert.equal((await readCaptureQA()).nativeActive,0)
        await setCaptureQA({listFails:false})
      }
      if (pickerSupported && !nativePicker) {
        await setCaptureQA({screenPermission:'granted',listFails:true,cancelPicker:false})
        await host.locator('#host-options').click()
        await host.locator('#use-system-picker').click()
        await code.waitFor({state:'visible'})
        const pickerCalls = (await readCaptureQA()).pickerCalls
        await connectWithCode()
        await waitForVideo()
        assert.equal((await readCaptureQA()).pickerCalls,pickerCalls)
        assert(await host.locator('#resume-capture').isHidden())
        await stop()
        await setCaptureQA({listFails:false})
      }
      // Emit only inside this isolated Electron main process. The operator's
      // machine never locks and the source remains the synthetic window.
      await host.locator('#host-files').click()
      await code.waitFor({state:'visible'})
      await apps[0].evaluate(({powerMonitor}) => powerMonitor.emit('lock-screen'))
      await hostButton.waitFor({state:'visible'})
      assert.equal(await code.inputValue(),'')
      assert(await captureIsDenied())
      console.log('Verified saved display and control, one-time codes, cancellation, file-only permissions and code-to-video with no host interaction after publication.')
    }
    const beforeRetry = await readCaptureQA()
    if (localCaptureQA) await setCaptureQA({screenPermission:process.platform === 'darwin' ? 'denied' : 'granted',listFails:true})
    await pair()
    if (localCaptureQA) {
      if (process.platform === 'darwin') {
        await waitForNotice('consent-notice','录屏设置')
        assert(await host.locator('#consent-screen-settings').isVisible())
        assert.equal((await readCaptureQA()).listCalls, beforeRetry.listCalls,
          'An incoming request with denied permission must not prompt for screen access')
        await setCaptureQA({screenPermission:'restricted'})
        await host.locator('#retry-screens').click()
        await waitForNotice('consent-notice','系统策略')
        assert.equal(await host.locator('#use-system-picker').isVisible(),false)
        await setCaptureQA({screenPermission:'not-determined'})
        await host.locator('#retry-screens').click()
        await waitForNotice('consent-notice','预检未确认')
        await setCaptureQA({screenPermission:'granted'})
        await host.locator('#retry-screens').click()
      }
      await waitForNotice('consent-notice','无法列出屏幕')
      assert(await host.locator('#accept').isDisabled())
      assert.equal(await host.locator('#consent-screen-settings').isVisible(),false)
      await setCaptureQA({listFails:false,noDisplays:true})
      await host.locator('#retry-screens').click()
      await waitForNotice('consent-notice','没有找到')
      await setCaptureQA({noDisplays:false})
      await host.locator('#retry-screens').click()
    }
    await host.waitForFunction(() => document.getElementById('screens').value && !document.getElementById('accept').disabled)
    const afterReading = await readCaptureQA()
    await host.locator('#accept').click()
    const help = host.locator('#resume-capture')
    if (await help.isVisible()) await help.click()
    try {
      await waitForVideo()
    } catch (error) {
      const summary = async page => {
        const state = await page.evaluate(async () => {
          const pc=window.testPeerConnection
          if (!pc) return {}
          const report=[...await pc.getStats()].map(([,v])=>v)
          return {state:pc.connectionState,ice:pc.iceGatheringState,signal:pc.signalingState,
            offers:[pc.localDescription?.type,pc.remoteDescription?.type],iceServers:pc.getConfiguration().iceServers.length,errors:pc.relayErrors,stats:report.filter(s=>s.type.endsWith('candidate')||s.type==='candidate-pair').map(s=>[s.type,s.candidateType,s.state,s.protocol,s.relayProtocol])}
        })
        const notice = page.locator('#session-notice')
        return JSON.stringify(state) + '\n' + (await notice.isVisible() ? await notice.textContent() : '')
      }
      throw new Error('视频未就绪。\n' + await summary(host) + '\n' + await summary(viewer), { cause: error })
    }
    assert.equal((await readCaptureQA()).listCalls, afterReading.listCalls,
      'Sharing must use the source read by the host for this consent request')
    const result = await viewer.evaluate(() => {
      const video = document.getElementById('remote-video')
      return { width: video.videoWidth, height: video.videoHeight, frames: video.getVideoPlaybackQuality().totalVideoFrames }
    })
    assert(await viewer.locator('#end-session').isVisible())
    await viewer.locator('#settings-button').click()
    assert(await viewer.locator('#settings-end').isVisible())
    assert(await viewer.locator('#update-button').isDisabled())
    assert.equal(await viewer.locator('#advanced-settings').isVisible(), false)
    await viewer.locator('#close-settings').click()
    assert.match(await viewer.locator('#permission-state').textContent(), /仅观看/)
    await viewer.locator('#live-quality').selectOption('smooth')
    await viewer.waitForFunction(() => /加密(直连|中继)/.test(document.getElementById('session-stats').textContent))
    if (fixture) await verifyFileExchange(apps, [host, viewer], temp)
    if (wan) {
      const paths = await Promise.all([verifyInternetConnection(host), verifyInternetConnection(viewer)])
      console.log('Verified public pairing at both endpoints. Selected remote ICE candidate types:', paths)
    }
    if (relay) {
      await host.waitForFunction(() => window.testPeerConnection?.restarts >= 1, null, {timeout:36000})
      await viewer.waitForFunction(() => window.testPeerConnection.connectionState === 'connected' &&
        document.getElementById('remote-video').getVideoPlaybackQuality().totalVideoFrames > 8)
      for (let i=0;i<100 && Math.min(relay.grants.host,relay.grants.viewer)<2;i++) await delay(150)
      assert(relay.grants.host >= 2 && relay.grants.viewer >= 2,'Both authorized endpoints must renew their relay grants')
      await host.waitForFunction(() => window.testPeerConnection.signalingState === 'stable' && window.testPeerConnection.connectionState === 'connected')
      const before=await viewer.locator('#remote-video').evaluate(video=>video.getVideoPlaybackQuality().totalVideoFrames)
      await viewer.waitForFunction(count => document.getElementById('remote-video').getVideoPlaybackQuality().totalVideoFrames >= count+3,before)
      assert.equal(await host.evaluate(() => window.testCaptures),1)
      assert.match(await viewer.locator('#session-stats').innerText(),/加密中继/)
      relay.denied = true
      await host.locator('#host-button').waitFor({state:'visible',timeout:35000})
      console.log('Verified loopback TURN renewal, ICE restart, one capture permission, and shutdown after relay budget refusal.',relay.grants)
    } else if (fixture) {
      await fixture.setStatus('qa.host','suspended')
      try { await host.locator('#account-form').waitFor({state:'visible'}) }
      catch (error) {
        const status = await host.evaluate(async () => ({
          account:(await window.jianping.info()).account.status,
          connection:document.getElementById('top-status').innerText,
          reason:document.getElementById('home-notice').innerText
        }))
        throw new Error('Suspended host not signed out: ' + JSON.stringify(status),{cause:error})
      }
    } else await host.locator('#end-session').click()
    await viewer.waitForFunction(() => !document.getElementById('home').hidden)
    assert.equal(await viewer.locator('#remote-video').evaluate(v => v.srcObject), null)
    console.log('Passed single-instance lock, custom selection, three languages, Electron pairing, denial, explicit consent, synthetic WebRTC frames, stats, and remote disconnect.', result)
  } finally {
    await Promise.allSettled(apps.map(instance => instance.close()))
    await fixture?.close()
    await relay?.close()
    await fs.rm(temp, { recursive: true, force: true })
  }
}
run().catch(error => { console.error(error); process.exitCode = 1 })
