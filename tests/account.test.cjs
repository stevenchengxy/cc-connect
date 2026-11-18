'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { randomBytes, createCipheriv, createDecipheriv } = require('node:crypto')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const { DesktopAccount } = require('../src/account.cjs')

const password = 'a-long-test-passphrase'
const credentials = {username:'qa.member', password}
async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(),'cc-account-'))
  t.after(() => fs.rm(directory,{recursive:true,force:true}))
  const token = randomBytes(32).toString('base64url')
  const key = randomBytes(32)
  const data = {account:{id:'test',username:'qa.member',role:'member',status:'pending'}, expiresAt:Math.floor(Date.now()/1000)+1000}
  const requests = []
  const storage = {
    async isAsyncEncryptionAvailable() { return true },
    getSelectedStorageBackend: () => 'gnome_libsecret',
    async encryptStringAsync(value) {
      const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm',key,iv)
      const bytes = Buffer.concat([cipher.update(value),cipher.final()])
      return Buffer.concat([iv,cipher.getAuthTag(),bytes])
    },
    async decryptStringAsync(bytes) {
      const dc = createDecipheriv('aes-256-gcm',key,bytes.subarray(0,12))
      dc.setAuthTag(bytes.subarray(12,28))
      return {result:Buffer.concat([dc.update(bytes.subarray(28)),dc.final()]).toString()}
    }
  }
  const f = {directory,storage,data,token,requests, online:true, revoked:false}
  const fetchImpl = async (url,opts) => {
    assert.equal(new URL(url).origin,'https://own.example')
    assert.equal(opts.redirect,'error'); assert.equal(opts.credentials,'omit')
    const action = new URL(url).pathname.split('/').pop()
    requests.push(action)
    if (!f.online) throw new Error('unavailable')
    if (action === 'register') {
      f.submittedInvite = JSON.parse(opts.body).invite
      return Response.json({status:'pending'},{status:201})
    }
    if (action === 'login') return Response.json({token,...data})
    assert.equal(opts.headers.authorization,'Bearer ' + token)
    if (action === 'logout') return new Response(null,{status:204})
    if (f.revoked) return Response.json({error:'account_required'},{status:401})
    return Response.json(data)
  }
  f.create = options => new DesktopAccount({directory,storage,base:'https://own.example/v1',fetchImpl,platform:'linux',...options})
  return f
}

test('invited registration, pending approval and fresh online authorization on every new pairing', async t => {
  const f = await fixture(t), app=f.create()
  await assert.rejects(app.requireApproved(),/登录/)
  await assert.rejects(app.register({...credentials,invite:'bad'}),/邀请码/)
  await assert.rejects(app.register({...credentials,invite:'A1CD-2345'}),/邀请码/)
  const legacyInvite = randomBytes(32).toString('base64url')
  assert.deepEqual(await app.register({...credentials,invite:legacyInvite}),{status:'pending'})
  assert.equal(f.submittedInvite,legacyInvite)
  assert.deepEqual(await app.register({...credentials,invite:'  abcd - 9xj6  '}),{status:'pending'})
  assert.equal(f.submittedInvite,'ABCD9XJ6')
  assert.equal((await app.login(credentials)).status,'pending')
  assert(!JSON.stringify(app.state).includes(f.token))
  await assert.rejects(app.requireApproved(),/等待管理员/)
  f.data.account.status='approved'
  assert.equal(await app.requireApproved(),f.token)
  const ciphertext=await fs.readFile(app.file)
  assert(!ciphertext.includes(password)); assert(!ciphertext.includes(f.token))
  if (process.platform !== 'win32') assert.equal((await fs.stat(app.file)).mode & 0o777,0o600)
  f.online=false
  const next=f.create()
  await next.restore()
  assert.equal(next.state.status,'unavailable'); assert.equal(next.approvedToken,null)
  f.online=true
  assert.equal(await next.requireApproved(),f.token)
  f.revoked=true
  await assert.rejects(next.requireApproved(),/登录/)
  assert.equal(next.state.status,'signedOut')
  await assert.rejects(fs.access(app.file),{code:'ENOENT'})
})

test('refuses weak storage before submitting credentials and removes the saved token on offline logout', async t => {
  const f=await fixture(t), app=f.create()
  f.storage.getSelectedStorageBackend=()=>'basic_text'
  await assert.rejects(app.login(credentials),/安全凭据/)
  assert.deepEqual(f.requests,[])
  f.storage.getSelectedStorageBackend=()=>'kwallet6'
  f.data.account.status='approved'
  await app.login(credentials)
  f.online=false
  const stopped=app.logout()
  assert.equal(app.approvedToken,null)
  await assert.rejects(stopped,/网络/)
  await assert.rejects(fs.access(app.file),{code:'ENOENT'})
})

test('logout racing a credential-store write cannot restore an earlier signed-in session', async t => {
  const f=await fixture(t), app=f.create()
  let entered, go
  const started=new Promise(r=>{entered=r}), gate=new Promise(r=>{go=r})
  const encrypt=f.storage.encryptStringAsync
  f.storage.encryptStringAsync=async value=>{entered(); await gate; return encrypt(value)}
  const pending=app.login(credentials)
  await started
  const logout=app.logout()
  go()
  await assert.rejects(pending,/登录/); await logout
  assert.equal(app.approvedToken,null)
  await assert.rejects(fs.access(app.file),{code:'ENOENT'})
})

test('verified role reaches the desktop view and resets when privileges change', async t => {
  const f = await fixture(t), app = f.create()
  Object.assign(f.data.account, {status:'approved',role:'admin'})
  assert.equal((await app.login(credentials)).role,'admin')
  assert.equal((await f.create().restore()).role,'admin')
  f.data.account.role='member'
  assert.equal((await app.refresh()).role,'member')
  await app.logout()
  assert.notEqual(app.state.role,'admin')
})
