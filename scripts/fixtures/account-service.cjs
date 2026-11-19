// In-process production worker, isolated SQLite and synthetic accounts for the two Electron windows.
const http = require('node:http')

async function startAccountFixture(relay) {
  const { database, token, sha } = await import('../../pairing-site/test/fixture.js')
  const { default: worker } = await import('../../pairing-site/worker/index.js')
  let dispose
  const env = database({after: cleanup => { dispose = cleanup }})
  const call = (method, suffix, data, bearer) => worker.fetch(new Request('https://example.test/v1/' + suffix, {
    method, headers:{'content-type':'application/json', ...(bearer && {authorization:'Bearer ' + bearer})},
    body:data && JSON.stringify(data)
  }), env)
  const bootstrap = token()
  env.CC_ADMIN_BOOTSTRAP_SHA256 = sha(bootstrap)
  const admin = {username:'qa-admin', password:token()}
  if ((await call('POST','auth/bootstrap',{...admin,bootstrap})).status !== 201) throw new Error('Fixture bootstrap failed')
  const owner = (await (await call('POST','auth/login',admin)).json()).token
  const server = http.createServer(async (req, res) => {
    try {
      const chunks = []
      for await (const chunk of req) chunks.push(chunk)
      const body = Buffer.concat(chunks)
      let response = await worker.fetch(new Request('https://example.test' + req.url, {
        method:req.method, headers:req.headers, body:body.length ? body : undefined
      }),env)
      const ice = /^\/v1\/rooms\/[^/]+\/(host|viewer)\/ice$/.exec(req.url)
      if (relay && ice && response.status === 204) response = relay.issue(ice[1])
      res.writeHead(response.status,Object.fromEntries(response.headers))
      res.end(Buffer.from(await response.arrayBuffer()))
    } catch { res.writeHead(500); res.end() }
  })
  await new Promise(resolve => server.listen(0,'127.0.0.1',resolve))
  return {
    origin:'http://127.0.0.1:' + server.address().port,
    async waitForHostSlot() {
      // This suite creates more than a minute's allowance from its single loopback IP.
      // Run the actual admission policy, spacing test rooms just as a client must.
      const now = Date.now()
      const room = env.handle.prepare('SELECT created FROM rooms WHERE created>? ORDER BY created DESC LIMIT 1 OFFSET 11').get(now - 60_000)
      if (room) await new Promise(resolve => setTimeout(resolve, room.created + 60_050 - now))
    },
    async invite() { return (await (await call('POST','admin/invites',undefined,owner)).json()).invite },
    async setStatus(username,status) {
      const {accounts} = await (await call('GET','admin/accounts',undefined,owner)).json()
      const account = accounts.find(row => row.username === username)
      if (!account || (await call('PATCH','admin/accounts/' + account.id,{status},owner)).status !== 200) throw new Error('Fixture status transition failed')
    },
    async close() { await new Promise(resolve => { server.close(resolve); server.closeAllConnections() }); dispose() }
  }
}
module.exports = {startAccountFixture}
