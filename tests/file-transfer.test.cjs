'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const { randomUUID, createHash, randomBytes } = require('node:crypto')
const { FileTransfer, transferName, CHUNK_SIZE, MAX_SIZE } = require('../src/file-transfer.cjs')

const digest = data => createHash('sha256').update(data).digest('hex')

async function directory(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-file-qa-'))
  t.after(() => fs.rm(dir, { recursive: true, force: true }))
  return dir
}
const session = options => new FileTransfer({ live: () => true, ...options })

test('sends regular files in bounded chunks, including empty files; both directions hash the saved bytes', async t => {
  const dir = await directory(t)
  for (const size of [0, CHUNK_SIZE * 2 + 19]) {
    const source = path.join(dir, 'source ' + size)
    const target = path.join(dir, 'received ' + size)
    const bytes = randomBytes(size)
    await fs.writeFile(source, bytes)
    const sender = session({ chooseSource: () => source })
    const receiver = session({ chooseDestination: name => { assert.equal(name, path.basename(source)); return target } })
    const offer = await sender.pick()
    assert.deepEqual(Object.keys(offer).sort(), ['id', 'name', 'size'])
    assert.equal(offer.size, size)
    assert.equal(await receiver.save(offer), true)
    await assert.rejects(fs.stat(target), { code: 'ENOENT' })
    let count = 0
    while (count < size) {
      const chunk = await sender.read(offer.id)
      assert(chunk.length > 0 && chunk.length <= CHUNK_SIZE)
      await receiver.write(offer.id, chunk)
      count += chunk.length
    }
    assert.equal((await sender.read(offer.id)).length, 0)
    const sha = await sender.sentDigest(offer.id)
    assert.equal(sha, digest(bytes))
    assert.equal(await receiver.commit(offer.id, sha), true)
    assert.deepEqual(await fs.readFile(target), bytes)
    await assert.rejects(sender.read(offer.id), /file-session/)
  }
  assert(!(await fs.readdir(dir)).some(name => name.endsWith('.part')))
})

test('declining or cancelling a chooser, including one left open at revocation, cannot start a file', async t => {
  const dir = await directory(t)
  const offer = { id: randomUUID(), name: 'a.txt', size: 2 }
  let choose
  let live = true
  const receiver = session({ live: () => live, chooseDestination: () => new Promise(resolve => { choose = resolve }) })
  const pendingSave = receiver.save(offer)
  await assert.rejects(receiver.save({ ...offer, id: randomUUID() }), /file-busy/)
  await receiver.cancel(offer.id)
  live = false
  choose(path.join(dir, 'cancelled'))
  await assert.rejects(pendingSave, /file-session/)
  await assert.rejects(receiver.save(offer), /file-session/)
  assert.deepEqual(await fs.readdir(dir), [])
  assert.equal(await session({ chooseDestination: () => null }).save(offer), false)
  assert.equal(await session({ chooseSource: () => null }).pick(), null)
})

test('refuses invalid IDs, oversized offers and oversized chunks, and removes incomplete data', async t => {
  const dir = await directory(t)
  const receiver = session({ chooseDestination: () => path.join(dir, 'out') })
  const offer = { id: randomUUID(), name: 'ok.txt', size: CHUNK_SIZE + 1 }
  await assert.rejects(receiver.save({ ...offer, id: '../path' }), /file-invalid/)
  await assert.rejects(receiver.save({ ...offer, size: MAX_SIZE + 1 }), /file-too-large/)
  await receiver.save(offer)
  await assert.rejects(receiver.write(randomUUID(), new Uint8Array(1)), /file-session/)
  await assert.rejects(receiver.write(offer.id, new Uint8Array(CHUNK_SIZE + 1)), /file-invalid/)
  assert.deepEqual(await fs.readdir(dir), [])
  await receiver.save(offer)
  await receiver.write(offer.id, Uint8Array.of(1))
  await receiver.cancel(offer.id)
  assert.deepEqual(await fs.readdir(dir), [])
})

test('only replaces the confirmed unchanged file after a complete, verified transfer', async t => {
  const dir = await directory(t)
  const target = path.join(dir, 'already exists')
  const receiver = session({ chooseDestination: () => target })
  const offer = { id: randomUUID(), name: 'document', size: 4 }
  const data = Buffer.from('data')
  await fs.writeFile(target, 'original')
  await receiver.save(offer)
  await receiver.write(offer.id, data)
  await assert.rejects(receiver.commit(offer.id, digest('oops')), /file-integrity/)
  assert.equal(await fs.readFile(target, 'utf8'), 'original')
  await receiver.save(offer)
  await fs.writeFile(target, 'changed during transfer')
  await receiver.write(offer.id, data)
  await assert.rejects(receiver.commit(offer.id, digest(data)), /file-destination/)
  assert.equal(await fs.readFile(target, 'utf8'), 'changed during transfer')
  await fs.unlink(target)
  await receiver.save(offer)
  await fs.writeFile(target, 'newly created by another program')
  await receiver.write(offer.id, data)
  await assert.rejects(receiver.commit(offer.id, digest(data)), /file-destination/)
  assert.equal(await fs.readFile(target, 'utf8'), 'newly created by another program')
  await receiver.save(offer)
  await receiver.write(offer.id, data)
  await receiver.commit(offer.id, digest(data))
  assert.deepEqual(await fs.readFile(target), data)
  assert.deepEqual(await fs.readdir(dir), [path.basename(target)])
})

test('uses portable display names and refuses changed sender files and directory selection', async t => {
  assert.equal(transferName('CON.txt'), '_CON.txt')
  assert(!/[\\/\u202e]/u.test(transferName('../music/\\ware\u202e.exe')))
  assert(Buffer.byteLength(transferName('图'.repeat(200))) <= 220)
  const dir = await directory(t)
  await assert.rejects(session({ chooseSource: () => dir }).pick(), /file-unavailable/)
  const file = path.join(dir, 'changed')
  await fs.writeFile(file, 'initial')
  const sender = session({ chooseSource: () => file })
  const offer = await sender.pick()
  await sender.read(offer.id)
  await fs.appendFile(file, 'new')
  await assert.rejects(sender.sentDigest(offer.id), /file-integrity/)
})

test('native panels block remote input while draining and while resuming, even after the user cancels', async () => {
  const { LocalFilePanel } = require('../src/file-transfer.cjs')
  const drain = Promise.withResolvers()
  const picker = Promise.withResolvers()
  const resume = Promise.withResolvers()
  const opened = Promise.withResolvers()
  const restarted = Promise.withResolvers()
  const input = { stop: () => drain.promise }
  const room = { allowControl: true, input }
  const guard = new LocalFilePanel(value => value === room, (value, helper) => {
    assert.equal(value, room)
    assert.equal(helper, input)
    restarted.resolve()
    return resume.promise
  }, () => assert.fail('unexpected input error'))
  let shown = false
  const selection = guard.choose(room, () => { shown = true; opened.resolve(); return picker.promise })
  assert.equal(guard.open, true)
  assert.equal(shown, false)
  await assert.rejects(guard.choose(room, () => assert.fail('second picker')), /file-busy/)
  drain.resolve()
  await opened.promise
  assert.equal(guard.open, true)
  picker.resolve(null)
  await restarted.promise
  assert.equal(guard.open, true)
  resume.resolve()
  assert.equal(await selection, null)
  assert.equal(guard.open, false)
})

test('revoking a session discards a late panel selection and never restarts its keyboard helper', async () => {
  const { LocalFilePanel } = require('../src/file-transfer.cjs')
  const selected = Promise.withResolvers()
  const opened = Promise.withResolvers()
  const room = { allowControl: true, input: { stop: () => {} } }
  let current = room
  const guard = new LocalFilePanel(value => value === current, () => assert.fail('revoked controls resumed'), assert.fail)
  const selection = guard.choose(room, () => { opened.resolve(); return selected.promise })
  await opened.promise
  current = { allowControl: false }
  assert.equal(guard.open, true)
  await assert.rejects(guard.choose(current, () => assert.fail('overlapping panel')), /file-busy/)
  selected.resolve('/ignored')
  await assert.rejects(selection, /file-session/)
  assert.equal(guard.open, false)
  assert.equal(await guard.choose(current, () => null), null)
})
