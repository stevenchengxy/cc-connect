const { _electron } = require('playwright-core')
const assert = require('node:assert/strict')
const path = require('node:path')
const os = require('node:os')
const fs = require('node:fs/promises')
const { setTimeout: delay } = require('node:timers/promises')
const { spawn } = require('node:child_process')

const publicIceOnly = process.argv.includes('--public-ice-only')
const wan = publicIceOnly || process.argv.includes('--wan')

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
  async function launch(name) {
    const args = [path.join(__dirname, 'fixtures', 'desktop.cjs'), '--user-data-dir=' + path.join(temp, name)]
    if (!wan) args.push('--test-local-pairing')
    if (name === 'host') args.push('--synthetic-source')
    const instance = await _electron.launch({ executablePath: require('electron'), args })
    apps.push(instance)
    for (let i = 0; i < 150; i++) {
      const page = instance.windows().find(w => w.url().endsWith('/src/ui/index.html'))
      if (page) {
        await page.waitForFunction(() => window.jianping && document.getElementById('device-name').textContent !== '正在读取设备…')
        await page.locator('#language-select').selectOption('en')
        await page.waitForFunction(() => document.documentElement.lang === 'en')
        assert.equal(await page.locator('#join-button').innerText(), 'Connect')
        await page.locator('#language-select').selectOption('zh-TW')
        await page.waitForFunction(() => document.documentElement.lang === 'zh-TW')
        assert.equal(await page.locator('#host-tab').innerText(), '分享此電腦')
        await page.locator('#language-select').selectOption('zh-CN')
        await page.waitForFunction(() => document.documentElement.lang === 'zh-CN')
        return page
      }
      await delay(200)
    }
    throw Error('应用窗口未就绪')
  }
  try {
    const host = await launch('host')
    const viewer = await launch('viewer')
    if (wan) await Promise.all([observeInternetConnection(host), observeInternetConnection(viewer)])
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
      const summary = page => page.locator('body').innerText()
      throw new Error('视频未就绪。\n' + await summary(host) + '\n' + await summary(viewer), { cause: error })
    }
    const result = await viewer.evaluate(() => {
      const video = document.getElementById('remote-video')
      return { width: video.videoWidth, height: video.videoHeight, frames: video.getVideoPlaybackQuality().totalVideoFrames }
    })
    assert.match(await viewer.locator('#permission-state').textContent(), /仅观看/)
    await viewer.locator('#live-quality').selectOption('smooth')
    await viewer.waitForFunction(() => /加密(直连|中继)/.test(document.getElementById('session-stats').textContent))
    if (wan) {
      const paths = await Promise.all([verifyInternetConnection(host), verifyInternetConnection(viewer)])
      console.log('Verified public pairing at both endpoints. Selected remote ICE candidate types:', paths)
    }
    await host.locator('#end-session').click()
    await viewer.waitForFunction(() => !document.getElementById('home').hidden)
    assert.equal(await viewer.locator('#remote-video').evaluate(v => v.srcObject), null)
    console.log('Passed single-instance lock, custom selection, three languages, Electron pairing, denial, explicit consent, synthetic WebRTC frames, stats, and remote disconnect.', result)
  } finally {
    await Promise.allSettled(apps.map(instance => instance.close()))
    await fs.rm(temp, { recursive: true, force: true })
  }
}
run().catch(error => { console.error(error); process.exitCode = 1 })
