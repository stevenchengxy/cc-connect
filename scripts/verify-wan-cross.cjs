// Manual WAN check. The host exposes only a generated canvas track. The viewer
// bridge has no capture, remote input, clipboard or filesystem operations.
const { chromium } = require('playwright-core')
const { PairingNetwork } = require('../src/network.cjs')
const fs = require('node:fs/promises')
const path = require('node:path')
const { pathToFileURL } = require('node:url')
const assert = require('node:assert/strict')

const role = process.argv[2]
const host = role === 'host'
const peer = new PairingNetwork({ managedUrl: 'https://cc-connect-pair.stevenchengxy19.chatgpt.site/v1' })
const viewerName = 'CC Connect WAN synthetic viewer'
const deadline = host ? 235000 : 100000

let stage = 'launch'

async function main() {
  assert(host || role === 'viewer', 'Choose host or viewer')
  const inviteFile = host && process.argv[3]
  if (host) assert(inviteFile, 'Supply a new private file for this synthetic invitation')
  else assert(process.env.CC_WAN_QA_INVITE, 'Missing temporary synthetic invitation')
  const executablePath = process.env.CC_QA_CHROME || (process.platform === 'darwin'
    ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : '/usr/bin/google-chrome')
  const browser = await chromium.launch({ executablePath, headless: true })
  let ownsInvite = false
  let page
  const hardTimeout = setTimeout(() => { peer.stop(); void browser.close().catch(() => {}) }, deadline)
  try {
    page = await browser.newPage()
    const events = []
    let dispatching = Promise.resolve()
    peer.on('event', event => {
      dispatching = dispatching.then(async () => {
        if (event.type === 'connected') {
          assert.equal(event.managedWan, true)
          const iceServers = await peer.getManagedIceServers()
          await notify({type:'accepted', role, name:event.name, managedWan:true, managedIceServers:iceServers, allowControl:false})
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
        delete spec.ips
        delete spec.pin
        delete spec.port
        const testCode = 'RD1.' + Buffer.from(JSON.stringify(spec)).toString('base64url')
        await fs.writeFile(inviteFile, testCode, {flag:'wx', mode:0o600})
        ownsInvite = true
        return {...result, invite:testCode}
      })
      await page.exposeFunction('qaAllowCanvas', (control, screen) => {
        assert.equal(control, false)
        assert.equal(screen, 'synthetic')
        peer.respond(true)
      })
    } else {
      await page.exposeFunction('qaJoin', () => peer.join({invite:process.env.CC_WAN_QA_INVITE, name:viewerName}))
    }
    await page.addInitScript(host => {
      const NativePeer = window.RTCPeerConnection
      window.RTCPeerConnection = class extends NativePeer {
        constructor(config) {
          super(config)
          window.qaPeer = this
        }
      }
      window.jianping = {
        info:async () => ({name:'Synthetic test',platform:'linux',version:'test',language:'en',inputSupported:false,iceServers:[]}),
        setLanguage:async () => {}, onEvent:listener => { window.qaEvent=listener },
        signal:window.qaSignal, disconnect:window.qaStop,
        ...(host ? {host:window.qaHost,screens:async () => [{id:'synthetic',name:'Generated canvas',primary:true}],accept:window.qaAllowCanvas}
          : {join:window.qaJoin})
      }
      Object.defineProperty(navigator.mediaDevices, 'getDisplayMedia', {value:async () => {
        if (!host) throw Error('Receiver only')
        const canvas = document.createElement('canvas')
        canvas.width = 320; canvas.height = 240
        const context = canvas.getContext('2d')
        let frame = 0
        const draw = () => { context.fillStyle = (++frame % 2) ? '#59469c' : '#4881be'; context.fillRect(0,0,320,240) }
        draw()
        window.setInterval(draw,100)
        return canvas.captureStream(10)
      }})
    },host)
    await page.goto(pathToFileURL(path.resolve(__dirname, '../src/ui/index.html')).href)
    await page.waitForFunction(() => document.getElementById('device-name').textContent === 'Synthetic test')
    if (host) {
      await page.locator('#host-tab').click()
      await page.locator('#host-button').click()
      stage = 'waiting for synthetic viewer'
      await page.locator('#consent[open]').waitFor({timeout:deadline})
      assert((await page.locator('#consent-title').innerText()).includes(viewerName))
      assert.equal(await page.locator('#allow-control').isChecked(), false)
      await page.locator('#accept').click()
      stage = 'host media negotiation'
      await page.waitForFunction(() => document.getElementById('top-status').textContent === 'Sharing', null, {timeout:70000})
      await page.locator('#home').waitFor({state:'visible',timeout:60000})
      console.log('Synthetic host finished the public pairing session.')
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
      assert.match(await page.locator('#permission-state').innerText(), /View only|View-only/i)
      console.log('Decoded', frames, 'synthetic 320x240 frames through the public pairing service.')
      await page.locator('#end-session').click()
    }
    assert.deepEqual(events, [])
  } catch (error) {
    // Only public state names and candidate types leave either test device.
    const diagnostics = await page?.evaluate(async () => {
      const pc = window.qaPeer
      if (!pc) return {establishedPairing:false}
      const stats = [...(await pc.getStats()).values()]
      const types = role => [...new Set(stats.filter(s => s.type === role + '-candidate').map(s => s.candidateType))]
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
})
