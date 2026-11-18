'use strict'

const fs = require('node:fs/promises')
const { constants, unlinkSync } = require('node:fs')
const { createHash, randomUUID } = require('node:crypto')
const path = require('node:path')

const MAX_SIZE = 1024 ** 3
const CHUNK_SIZE = 16 * 1024
const TRANSFER_ID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/
const errors = new Set(['file-busy', 'file-too-large', 'file-unavailable', 'file-invalid',
  'file-integrity', 'file-destination', 'file-session'])
const fail = message => { throw new Error(message) }
const pendingParts = new Set()
process.once('exit', () => {
  for (const name of pendingParts) { try { unlinkSync(name) } catch {} }
})

function transferName(name) {
  if (typeof name !== 'string' || !name || name.length > 1024) fail('file-invalid')
  const cleaned = name.normalize('NFC').replace(/[<>:"/\\|?*\p{Cc}\p{Cf}]/gu, '_')
    .trim().replace(/^\.+/, '').replace(/[. ]+$/, '') || 'file'
  let result = '', bytes = 0
  for (const character of cleaned) {
    bytes += Buffer.byteLength(character)
    if (bytes > 218) break
    result += character
  }
  result = result.replace(/[. ]+$/, '') || 'file'
  return /^(?:CON|PRN|AUX|NUL|COM[1-9¹²³]|LPT[1-9¹²³])(?:\.|$)/i.test(result) ? '_' + result : result
}

async function existingFile(destination) {
  try {
    const stat = await fs.lstat(destination, { bigint: true })
    if (!stat.isFile()) fail('file-destination')
    return stat
  } catch (error) {
    if (error.code === 'ENOENT') return null
    throw error
  }
}

function sameFile(left, right) {
  return left && right && left.dev === right.dev && left.ino === right.ino &&
    left.ctimeNs === right.ctimeNs && left.size === right.size
}

class LocalFilePanel {
  constructor(isLive, resumeInput, inputError) {
    this.isLive = isLive
    this.resumeInput = resumeInput
    this.inputError = inputError
    this.open = false
  }

  async choose(room, choose) {
    if (this.open) fail('file-busy')
    this.open = true
    const input = room.allowControl ? room.input : null
    try {
      // Drain queued input and release held keys before presenting the native panel.
      if (input) await input.stop()
      if (!this.isLive(room)) fail('file-session')
      const choice = await choose()
      if (!this.isLive(room)) fail('file-session')
      return choice
    } finally {
      try {
        if (input && this.isLive(room) && room.allowControl && room.input === input) {
          await this.resumeInput(room, input)
        }
      } catch (error) { this.inputError(room, error) }
      finally { this.open = false }
    }
  }
}

class FileTransfer {
  constructor({ live, chooseSource, chooseDestination }) {
    this.live = live
    this.chooseSource = chooseSource
    this.chooseDestination = chooseDestination
    this.active = null
  }

  reserve(id, direction) {
    if (!this.live()) fail('file-session')
    if (this.active) fail('file-busy')
    const item = { id, direction, bytes: 0, hash: createHash('sha256') }
    this.active = item
    return item
  }

  check(item) {
    if (!this.live() || this.active !== item) fail('file-session')
  }

  find(id, direction) {
    const item = this.active
    if (!item || item.id !== id || item.direction !== direction) fail('file-session')
    return item
  }

  async release(item) {
    if (item.handle) {
      await item.handle.close().catch(() => {})
      item.handle = null
    }
    if (item.part) {
      try {
        await fs.unlink(item.part)
        pendingParts.delete(item.part)
      } catch (error) {
        if (error.code === 'ENOENT') pendingParts.delete(item.part)
      }
      item.part = null
    }
  }

  async run(item, task) {
    this.check(item)
    if (item.busy) fail('file-busy')
    item.busy = true
    try {
      return await task()
    } catch (error) {
      if (this.active === item) this.active = null
      throw new Error(errors.has(error.message) ? error.message :
        item.direction === 'send' ? 'file-unavailable' : 'file-destination')
    } finally {
      item.busy = false
      if (this.active !== item) await this.release(item)
    }
  }

  async pick() {
    const item = this.reserve(randomUUID(), 'send')
    return this.run(item, async () => {
      const selected = await this.chooseSource()
      this.check(item)
      if (!selected) { this.active = null; return null }
      const stat = await fs.lstat(selected, { bigint: true })
      if (!stat.isFile()) fail('file-unavailable')
      item.handle = await fs.open(selected, constants.O_RDONLY | (constants.O_NOFOLLOW || 0) |
        (constants.O_NONBLOCK || 0))
      item.original = await item.handle.stat({ bigint: true })
      if (!sameFile(stat, item.original)) fail('file-unavailable')
      if (item.original.size > BigInt(MAX_SIZE)) fail('file-too-large')
      item.size = Number(item.original.size)
      this.check(item)
      return { id: item.id, name: transferName(path.basename(selected)), size: item.size }
    })
  }

  async read(id) {
    const item = this.find(id, 'send')
    return this.run(item, async () => {
      const buffer = Buffer.alloc(Math.min(CHUNK_SIZE, item.size - item.bytes))
      if (!buffer.length) return buffer
      const { bytesRead } = await item.handle.read(buffer, 0, buffer.length, item.bytes)
      this.check(item)
      if (!bytesRead) fail('file-unavailable')
      const data = buffer.subarray(0, bytesRead)
      item.hash.update(data)
      item.bytes += bytesRead
      return data
    })
  }

  async sentDigest(id) {
    const item = this.find(id, 'send')
    return this.run(item, async () => {
      const final = await item.handle.stat({ bigint: true })
      this.check(item)
      if (item.bytes !== item.size || !sameFile(item.original, final)) fail('file-integrity')
      this.active = null
      return item.hash.digest('hex')
    })
  }

  async save(offer) {
    if (!offer || typeof offer.id !== 'string' || !TRANSFER_ID.test(offer.id) ||
        !Number.isSafeInteger(offer.size) || offer.size < 0) fail('file-invalid')
    if (offer.size > MAX_SIZE) fail('file-too-large')
    const name = transferName(offer.name)
    const item = this.reserve(offer.id, 'receive')
    item.size = offer.size
    return this.run(item, async () => {
      const selected = await this.chooseDestination(name)
      this.check(item)
      if (!selected) { this.active = null; return false }
      item.destination = selected
      item.original = await existingFile(selected)
      const part = path.join(path.dirname(selected), '.cc-connect-' + randomUUID() + '.part')
      item.handle = await fs.open(part, 'wx', 0o600)
      item.part = part
      pendingParts.add(part)
      this.check(item)
      return true
    })
  }

  async write(id, data) {
    const item = this.find(id, 'receive')
    return this.run(item, async () => {
      if (!(data instanceof Uint8Array) || !data.length || data.length > CHUNK_SIZE ||
          item.bytes + data.length > item.size || !item.handle) fail('file-invalid')
      let offset = 0
      while (offset < data.length) {
        this.check(item)
        const { bytesWritten } = await item.handle.write(data, offset, data.length - offset, item.bytes + offset)
        if (!bytesWritten) fail('file-destination')
        offset += bytesWritten
      }
      this.check(item)
      item.hash.update(data)
      item.bytes += data.length
    })
  }

  async commit(id, digest) {
    const item = this.find(id, 'receive')
    return this.run(item, async () => {
      if (item.bytes !== item.size || typeof digest !== 'string' || !/^[a-f0-9]{64}$/.test(digest) ||
          digest !== item.hash.digest('hex')) fail('file-integrity')
      await item.handle.sync()
      await item.handle.close()
      item.handle = null
      if (item.original) {
        const current = await existingFile(item.destination)
        if (!sameFile(item.original, current)) fail('file-destination')
        this.check(item)
        // The native save dialog confirmed replacement of this particular file.
        await fs.rename(item.part, item.destination)
        pendingParts.delete(item.part)
        item.part = null
      } else {
        this.check(item)
        // Never overwrite a destination created after the user chose a new name.
        try { await fs.link(item.part, item.destination) }
        catch (error) {
          if (!['ENOTSUP', 'EOPNOTSUPP', 'EPERM', 'ENOSYS'].includes(error.code)) throw error
          this.check(item)
          await fs.copyFile(item.part, item.destination, constants.COPYFILE_EXCL)
        }
      }
      if (this.active === item) this.active = null
      return true
    })
  }

  async cancel(id) {
    const item = this.active
    if (!item || (id !== undefined && id !== item.id)) return
    this.active = null
    if (!item.busy) await this.release(item)
  }
}

module.exports = { FileTransfer, LocalFilePanel, transferName, MAX_SIZE, CHUNK_SIZE }
