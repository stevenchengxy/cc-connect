// Start two synthetic hosts with separate private invite files, one for each mode:
//   npx --no-install electron scripts/verify-wan-cross.cjs host <new-private-file> view|control
// Pass {view: <invite>, control: <invite>} as a JSON-encoded disposable CI secret.
// A viewer exercises the app's video surface and control protocol. The host can
// change only three color states on a generated canvas and cannot inject OS input.
const { chromium } = require('playwright-core')
const { PairingNetwork } = require('../src/network.cjs')
const fs = require('node:fs/promises')
const fsSync = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { pathToFileURL } = require('node:url')
const assert = require('node:assert/strict')

const role = process.argv[2]
const host = role === 'host'
const mode = (host ? process.argv[4] : process.argv[3]) || 'view'
const controlTest = mode === 'control'
const rawInvite = process.env.CC_WAN_QA_INVITE
delete process.env.CC_WAN_QA_INVITE
const requireRelay = process.env.CC_QA_RELAY_ONLY === '1'
// Only the person operating this test chooses its HTTPS service, never an invite.
const managedUrl = process.env.CC_WAN_QA_PAIR_URL || 'https://cc-connect-pair.stevenchengxy19.chatgpt.site/v1'
const electron = process.versions.electron && require('electron')
let profile
if (electron) {
  profile = fsSync.mkdtempSync(path.join(os.tmpdir(), 'cc-wan-network-'))
  electron.app.setPath('userData', profile)
  electron.app.dock?.hide()
}
const peer = new PairingNetwork({
  managedUrl,
  fetchImpl: electron ? (url, init) => electron.session.defaultSession.fetch(url, {...init, credentials:'omit'}) : undefined
})
const viewerName = 'CC Connect synthetic ' + mode + ' viewer'
const deadline = host ? 235000 : 100000

let stage = 'launch'

async function selectedRoute(page) {
  await page.waitForFunction(async () => {
    const stats = await window.qaPeer?.getStats()
    return stats && [...stats.values()].some(s => s.type === 'transport' && s.selectedCandidatePairId)
  }, null, {timeout:15000})
  const route = await page.evaluate(async () => {
    const stats = await window.qaPeer.getStats()
    const transport = [...stats.values()].find(s => s.type === 'transport' && s.selectedCandidatePairId)
    const pair = stats.get(transport.selectedCandidatePairId)
    const local = stats.get(pair.localCandidateId)
    const remote = stats.get(pair.remoteCandidateId)
    return {
      path:[local.candidateType, remote.candidateType].includes('relay') ? 'relay' : 'direct',
      local:local.candidateType,
      remote:remote.candidateType,
      protocol:local.relayProtocol || local.protocol
    }
  })
  if (requireRelay) assert.equal(route.local, 'relay')
  return route
}

async function waitForVideoColor(page, color, after = 0) {
  return page.waitForFunction(({color, after}) => {
    const video = document.getElementById('remote-video')
    if (video.videoWidth !== 320 || video.getVideoPlaybackQuality().totalVideoFrames < after + 2) return false
    const sample = document.createElement('canvas')
    sample.width = sample.height = 1
    const ctx = sample.getContext('2d')
    ctx.drawImage(video, 80, 80, 1, 1, 0, 0, 1, 1)
    const rgb = ctx.getImageData(0, 0, 1, 1).data
    const index = ['red','green','blue'].indexOf(color)
    return rgb[index] > 180 && rgb[(index+1)%3] < 95 && rgb[(index+2)%3] < 95
  }, {color,after}, {timeout:12000})
}

async function main() {
  assert(host || role === 'viewer', 'Choose host or viewer')
  assert(['view','control'].includes(mode), 'Choose view or control test')
  const inviteFile = host && process.argv[3]
  if (host) assert(inviteFile, 'Supply a new private file for this synthetic invitation')
  else assert(rawInvite, 'Missing temporary synthetic invitation')
  if (electron) await electron.app.whenReady()
  const executablePath = process.env.CC_QA_CHROME || (process.platform === 'darwin'
    ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : '/usr/bin/google-chrome')
  const browser = await chromium.launch({ executablePath, headless: true })
  let ownsInvite = false
  let page
  const hardTimeout = setTimeout(() => { peer.stop(); void browser.close().catch(() => {}) }, deadline)
  try {
    page = await browser.newPage()
    const events = []
    let consentedControl = false
    let dispatching = Promise.resolve()
    peer.on('event', event => {
      dispatching = dispatching.then(async () => {
        if (event.type === 'connected') {
          assert.equal(event.managedWan, true)
          console.log('Managed pairing completed for', role, mode)
          const iceServers = await peer.getManagedIceServers()
          console.log('Managed TURN entries for', role, mode, iceServers.length)
          await notify({type:'accepted', role, name:event.name, managedWan:true, managedIceServers:iceServers, allowControl:host && consentedControl})
        } else if (event.type === 'signal') await notify({type:'signal', signal:event.payload})
        else await notify(event)
      }).catch(() => { events.push('signaling delivery stopped') })
    })
    const notify = event => page.evaluate(e => window.qaEvent(e), event)
    // These fixed operations are the entire test bridge. No native input or
    // desktop capturer is loaded in this process.
    await page.exposeFunction('qaSignal', signal => peer.signal(signal))
    await page.exposeFunction('qaStop', () => peer.stop())
    if (host) {
      await page.exposeFunction('qaHost', async () => {
        const result = await peer.host({name:'CC Connect WAN synthetic canvas'})
        const spec = JSON.parse(Buffer.from(result.invite.slice(4), 'base64url').toString())
        assert.equal(spec.managed, 1, 'Public registration failed')
        // Local smoke tests can exercise the online path on one machine. The
        // real cross-network run keeps the application's default path selection.
        if (process.env.CC_QA_FORCE_PUBLIC_PAIRING === '1') {
          delete spec.ips
          delete spec.pin
          delete spec.port
        }
        const testCode = 'RD1.' + Buffer.from(JSON.stringify(spec)).toString('base64url')
        await fs.writeFile(inviteFile, testCode, {flag:'wx', mode:0o600})
        ownsInvite = true
        return {...result, invite:testCode}
      })
      await page.exposeFunction('qaAllowCanvas', (control, screen) => {
        assert.equal(control, controlTest)
        assert.equal(screen, 'synthetic')
        consentedControl = control
        peer.respond(true)
        console.log('Synthetic host approved', mode, 'session')
      })
    } else {
      const invite = rawInvite.startsWith('RD1.') ? rawInvite : JSON.parse(rawInvite)[mode]
      await page.exposeFunction('qaJoin', () => peer.join({invite, name:viewerName}))
    }
    await page.addInitScript(({host, requireRelay}) => {
      const NativePeer = window.RTCPeerConnection
      window.qaCandidates = {local:new Set(), remote:new Set()}
      window.RTCPeerConnection = class extends NativePeer {
        constructor(config) {
          super(requireRelay ? {...config, iceTransportPolicy:'relay'} : config)
          window.qaPeer = this
          this.addEventListener('icecandidate', event => {
            if (event.candidate?.type) window.qaCandidates.local.add(event.candidate.type)
          })
        }
        async addIceCandidate(candidate) {
          await super.addIceCandidate(candidate)
          if (candidate?.candidate) {
            const {type} = new RTCIceCandidate(candidate)
            if (type) window.qaCandidates.remote.add(type)
          }
        }
      }
      window.jianping = {
        info:async () => ({name:'Synthetic test',platform:'linux',version:'test',language:'en',inputSupported:host,iceServers:[]}),
        setLanguage:async () => {}, onEvent:listener => { window.qaEvent=listener },
        signal:window.qaSignal, disconnect:window.qaStop,
        ...(host ? {host:window.qaHost,screens:async () => [{id:'synthetic',name:'Generated canvas',primary:true}],
          accept:async (allow, screen) => { await window.qaAllowCanvas(allow, screen); window.qaControlGranted = allow === true }}
          : {join:window.qaJoin})
      }
      window.qaTarget = {step:0, delivered:0, down:false, pressed:false}
      if (host) window.jianping.input = event => {
        // A finite test surface recognizes one central primary click followed by
        // one KeyA press. It cannot inject events into a browser tab or the OS.
        const target = window.qaTarget
        if (event.kind !== 'button' && event.kind !== 'key') return
        target.delivered++
        if (!window.qaControlGranted || window.qaCaptureTrack?.readyState !== 'live') return
        if (event.kind === 'button' && event.button === 0 && target.step === 0 &&
            Math.abs(event.x - 0.5) < 0.1 && Math.abs(event.y - 0.5) < 0.1) {
          if (event.down) target.down = true
          else if (target.down) target.step = 1
        }
        if (event.kind === 'key' && event.code === 'KeyA' && target.step === 1) {
          if (event.down) target.pressed = true
          else if (target.pressed) target.step = 2
        }
      }
      Object.defineProperty(navigator.mediaDevices, 'getDisplayMedia', {value:async () => {
        if (!host) throw Error('Receiver only')
        const canvas = document.createElement('canvas')
        canvas.width = 320; canvas.height = 240
        const context = canvas.getContext('2d')
        let frame = 0
        const draw = () => {
          context.fillStyle = ['#ed2020','#20ed20','#2020ed'][window.qaTarget.step]
          context.fillRect(0,0,320,240)
          context.fillStyle = (++frame % 2) ? '#fff' : '#000'
          context.fillRect(0,0,32,24)
          context.fillStyle = '#fff'; context.font = 'bold 18px sans-serif'
          context.textAlign = 'center'
          context.fillText(['Click here','Press A','Done'][window.qaTarget.step],160,124)
        }
        draw()
        window.setInterval(draw,100)
        const stream = canvas.captureStream(10)
        window.qaCaptureTrack = stream.getVideoTracks()[0]
        return stream
      }})
    }, {host, requireRelay})
    await page.goto(pathToFileURL(path.resolve(__dirname, '../src/ui/index.html')).href)
    await page.waitForFunction(() => document.getElementById('device-name').textContent === 'Synthetic test')
    if (host) {
      await page.locator('#host-tab').click()
      await page.locator('#host-button').click()
      stage = 'waiting for synthetic viewer'
      await page.locator('#consent[open]').waitFor({timeout:deadline})
      assert((await page.locator('#consent-title').innerText()).includes(viewerName))
      assert.equal(await page.locator('#allow-control').isChecked(), false)
      if (controlTest) await page.locator('#allow-control').check()
      await page.locator('#accept').click()
      stage = 'host media negotiation'
      await page.waitForFunction(() => document.getElementById('top-status').textContent === 'Sharing', null, {timeout:70000})
      console.log('Host', mode, 'ICE route', await selectedRoute(page))
      await page.locator('#home').waitFor({state:'visible',timeout:60000})
      const target = await page.evaluate(() => window.qaTarget)
      assert.equal(target.step, controlTest ? 2 : 0)
      assert.equal(target.delivered, controlTest ? 4 : 0)
      console.log('Host', mode, 'accepted test input events:', target.delivered)
    } else {
      // The actual one-time value stays in this process. The UI needs only a
      // nonempty field to exercise the production Join action.
      await page.locator('#invite-input').fill('synthetic-test-only')
      await page.locator('#join-button').click()
      stage = 'viewer media negotiation'
      await page.waitForFunction(() => {
        const video = document.getElementById('remote-video')
        return video.videoWidth === 320 && video.videoHeight === 240 && video.getVideoPlaybackQuality().totalVideoFrames >= 3
      }, null, {timeout:deadline - 15000})
      const frames = await page.locator('#remote-video').evaluate(video => video.getVideoPlaybackQuality().totalVideoFrames)
      console.log('Viewer', mode, 'ICE route', await selectedRoute(page))
      const permission = controlTest ? /Control enabled/i : /View only/i
      await page.locator('#permission-state').filter({hasText:permission}).waitFor({timeout:10000})
      console.log('Decoded', frames, 'synthetic 320×240 frames after managed pairing.')
      stage = 'checking remote click and keystroke'
      await waitForVideoColor(page, 'red')
      const video = page.locator('#remote-video')
      await video.click()
      if (controlTest) await waitForVideoColor(page, 'green')
      await video.press('a')
      const after = await video.evaluate(v => v.getVideoPlaybackQuality().totalVideoFrames)
      await waitForVideoColor(page, controlTest ? 'blue' : 'red', after)
      console.log(controlTest ? 'Decoded click and KeyA acknowledgments in remote video.' : 'Live view-only surface stayed unchanged after click and KeyA.')
      await page.locator('#end-session').click()
    }
    assert.deepEqual(events, [])
  } catch (error) {
    // Only public state names and candidate types leave either test device.
    const diagnostics = await page?.evaluate(async () => {
      const pc = window.qaPeer
      if (!pc) return {establishedPairing:false}
      const stats = [...(await pc.getStats()).values()]
      const types = role => [...new Set([
        ...window.qaCandidates[role],
        ...stats.filter(s => s.type === role + '-candidate').map(s => s.candidateType)
      ])]
      return {establishedPairing:true, ice:pc.iceConnectionState, local:types('local'), remote:types('remote')}
    }).catch(() => null)
    if (diagnostics) console.log('Synthetic ICE state', diagnostics)
    throw error
  } finally {
    clearTimeout(hardTimeout)
    peer.stop()
    await browser.close()
    if (ownsInvite) await fs.rm(inviteFile, {force:true})
  }
}

main().catch(() => {
  // Never log raw errors: SDP, TURN credentials or the invite could appear in them.
  console.error('The synthetic WAN check did not complete during', stage)
  process.exitCode = 1
}).finally(() => {
  if (electron) {
    electron.app.once('quit', () => fsSync.rmSync(profile, {recursive:true, force:true}))
    electron.app.exit(process.exitCode || 0)
  }
})
