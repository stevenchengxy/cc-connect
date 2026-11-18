// Optional two-window renewal regression. Uses an already installed coturn image
// with a loopback-only listener and permits relay traffic only to the same container.
const { execFile } = require('node:child_process')
const { promisify } = require('node:util')
const { randomUUID, randomBytes, createHmac } = require('node:crypto')
const run = promisify(execFile)
const docker = async (...args) => (await run('docker',args)).stdout.trim()

async function startLoopbackTurn() {
  const name = 'cc-connect-qa-' + randomUUID()
  const bridge = name + '-net'
  const secret = randomBytes(32).toString('hex')
  const grants = {host:0,viewer:0}
  await docker('network','create',bridge)
  let container
  const close = async () => {
    if (container) await docker('rm','-f',container).catch(() => {})
    await docker('network','rm',bridge)
  }
  try {
    const gateway = await docker('network','inspect',bridge,'--format','{{(index .IPAM.Config 0).Gateway}}')
    const addr = gateway.split('.')
    addr[3] = Number(addr[3]) + 1
    const ip = addr.join('.')
    container = await docker('run','--pull','never','-d','--name',name,'--network',bridge,'--ip',ip,
      '-p','127.0.0.1::3478/tcp','coturn/coturn:4-alpine','--no-tls','--no-udp',
      '--listening-ip=' + ip,'--relay-ip=' + ip,'--realm=cc-qa.test','--use-auth-secret','--static-auth-secret=' + secret,
      '--allowed-peer-ip=' + ip,'--denied-peer-ip=0.0.0.0-255.255.255.255','--denied-peer-ip=::-ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff')
    const port = (await docker('port',container,'3478/tcp')).split(':').pop()
    return {
      grants, close, denied:false,
      issue(role) {
        if (this.denied) return Response.json({error:'relay_budget'},{status:403})
        const expiresAt = Date.now() + 20000
        const username = Math.ceil(expiresAt/1000) + ':' + role + '-' + ++grants[role]
        const credential = createHmac('sha1',secret).update(username).digest('base64')
        return Response.json({iceServers:[{urls:['turn:127.0.0.1:' + port + '?transport=tcp'],username,credential}],expiresAt})
      }
    }
  } catch (error) {
    await close()
    // Omit command arguments, which can contain the disposable shared secret.
    throw new Error('Could not start the loopback coturn fixture (' + (error.code || 'unknown') + ')')
  }
}
module.exports = {startLoopbackTurn}
