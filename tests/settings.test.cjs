const { test } = require('node:test')
const assert = require('node:assert/strict')
const os = require('node:os')
const path = require('node:path')
const fs = require('node:fs/promises')
const { Settings } = require('../src/settings.cjs')

test('TURN credentials follow the specific server and user through saving and clearing', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'jianping-settings-'))
  t.after(() => fs.rm(directory, { recursive: true, force: true }))
  const store = {
    isAsyncEncryptionAvailable: async () => true,
    encryptStringAsync: async () => Buffer.from('protected'),
    decryptStringAsync: async () => ({ result: 'demo-test-password' })
  }
  const settings = new Settings(directory, store)
  const form = { relayUrl: 'wss://relay.example/pair', turnUrl: 'turn:turn.example:3478', turnUsername: 'member', turnPassword: 'demo-test-password' }
  await settings.update(form)
  assert(!(await fs.readFile(settings.file, 'utf8')).includes('demo-test-password'))
  const reboot = new Settings(directory, store)
  await reboot.load()
  await reboot.update({ ...form, turnPassword: '' })
  assert.equal((await reboot.getPublic()).iceServers[0].credential, form.turnPassword)
  await assert.rejects(reboot.update({ ...form, turnUsername: 'another', turnPassword: '' }), /密码/)
  await assert.rejects(reboot.update({ ...form, relayUrl: 'ws://host' }), /wss/)
  await reboot.update({ ...form, turnUrl: '', turnPassword: '' })
  assert.deepEqual((await reboot.getPublic()).iceServers, [])
})
