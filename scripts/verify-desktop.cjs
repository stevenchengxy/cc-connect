const { _electron } = require('playwright-core')
const assert = require('node:assert/strict')
const path = require('node:path')
const os = require('node:os')
const fs = require('node:fs/promises')
const { setTimeout: delay } = require('node:timers/promises')
const { spawn } = require('node:child_process')

const publicIceOnly = process.argv.includes('--public-ice-only')
const wan = publicIceOnly || process.argv.includes('--wan')
const loopbackRelay = process.argv.includes('--loopback-relay')

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

function internetInvite(invite) {
  const data = JSON.parse(Buffer.from(invite.slice(4), 'base64url').toString('utf8'))
  assert.equal(data.managed, 1, 'Public pairing service did not register the host')
  delete data.ips
  delete data.port
  delete data.pin
  return 'RD1.' + Buffer.from(JSON.stringify(data)).toString('base64url')
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

async function run() {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'jianping-e2e-'))
  const apps = []
  let relay, fixture
  async function launch(name) {
    const args = [path.join(__dirname, 'fixtures', 'desktop.cjs'), '--user-data-dir=' + path.join(temp, name)]
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
          const pairing = await Promise.allSettled([window.jianping.host(),window.jianping.join('test')])
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
        if (fixture) await page.locator('#register-invite').fill(await fixture.invite())
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
    const denied = await host.evaluate(async () => {
      try {
        const stream = await navigator.mediaDevices.getDisplayMedia({ video: true })
        stream.getTracks().forEach(t => t.stop())
        return false
      } catch { return true }
    })
    assert.equal(denied, true, 'before consent the app must deny screen capture')
    await host.locator('#host-tab').click()
    async function pair() {
      await host.locator('#host-button').click()
      await host.locator('#host-invite').waitFor({ state: 'visible' })
      const invite = await host.locator('#host-invite').inputValue()
      assert(invite.startsWith('RD1.'))
      await viewer.locator('#invite-input').fill(wan ? internetInvite(invite) : invite)
      await viewer.locator('#join-button').click()
      await host.locator('#consent[open]').waitFor()
      assert.equal(await host.locator('#allow-control').isChecked(), false)
    }
    await pair()
    await host.locator('#reject').click()
    await viewer.waitForFunction(() => document.getElementById('top-status').textContent === '待连接')
    await pair()
    await host.locator('#accept').click()
    const help = host.locator('#resume-capture')
    if (await help.isVisible()) await help.click()
    try {
      await viewer.waitForFunction(() => {
        const video = document.getElementById('remote-video')
        return video.videoWidth > 0 && video.getVideoPlaybackQuality().totalVideoFrames >= 3
      }, null, { timeout: wan ? 60000 : 20000 })
    } catch (error) {
      const summary = async page => {
        const state = await page.evaluate(async () => {
          const pc=window.testPeerConnection
          if (!pc) return {}
          const report=[...await pc.getStats()].map(([,v])=>v)
          return {state:pc.connectionState,ice:pc.iceGatheringState,signal:pc.signalingState,
            offers:[pc.localDescription?.type,pc.remoteDescription?.type],iceServers:pc.getConfiguration().iceServers.length,errors:pc.relayErrors,stats:report.filter(s=>s.type.endsWith('candidate')||s.type==='candidate-pair').map(s=>[s.type,s.candidateType,s.state,s.protocol,s.relayProtocol])}
        })
        return JSON.stringify(state) + '\n' + await page.locator('body').innerText()
      }
      throw new Error('视频未就绪。\n' + await summary(host) + '\n' + await summary(viewer), { cause: error })
    }
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
      await host.locator('#account-form').waitFor({state:'visible'})
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
