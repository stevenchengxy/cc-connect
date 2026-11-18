// Run only after building both installers. The private key must stay outside Git.
const fs = require('node:fs/promises')
const stream = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const { createHash, createPrivateKey, createPublicKey, sign } = require('node:crypto')
const { verifyManifest } = require('../src/updater.cjs')
const { version } = require('../package.json')

async function main() {
  const root = path.resolve(__dirname, '..')
  const keyPath = process.env.CC_CONNECT_SIGNING_KEY || path.join(os.homedir(), '.config/cc-connect-release/signing-key.pem')
  const privateKey = createPrivateKey(await fs.readFile(keyPath))
  const publicKey = await fs.readFile(path.join(root, 'src/update-public-key.pem'), 'utf8')
  if (privateKey.asymmetricKeyType !== 'ed25519' ||
      createPublicKey(privateKey).export({ type: 'spki', format: 'pem' }) !== publicKey) {
    throw new Error('Release signing key does not match the application public key.')
  }
  const files = {}
  for (const [platform, suffix] of [['mac', 'universal.dmg'], ['windows', 'x64.exe']]) {
    const name = `CC-Connect-${version}-${suffix}`
    const filename = path.join(root, 'release', version, name)
    const hash = createHash('sha256')
    let size = 0
    for await (const chunk of stream.createReadStream(filename)) { hash.update(chunk); size += chunk.length }
    const sha256 = hash.digest('hex')
    files[platform] = { name, size, sha256, parts: [{
      url: `https://github.com/stevenchengxy/cc-connect/releases/download/v${version}/${name}`,
      size, sha256
    }] }
  }
  const payload = Buffer.from(JSON.stringify({ version, files }))
  const envelope = { payload: payload.toString('base64'), signature: sign(null, payload, privateKey).toString('base64') }
  verifyManifest(envelope, publicKey)
  const json = JSON.stringify(envelope, null, 2) + '\n'
  const destination = path.join(root, 'website/dist/updates')
  await fs.mkdir(destination, { recursive: true })
  await fs.writeFile(path.join(destination, 'latest.json'), json)
  await fs.writeFile(path.join(root, 'release', version, 'latest.json'), json)
  await fs.writeFile(path.join(root, 'release', version, 'SHA256SUMS.txt'), Object.values(files).map(f => `${f.sha256}  ${f.name}`).join('\n') + '\n')
  console.log(`Signed v${version} update manifest for macOS and Windows.`)
}
main().catch(error => { console.error(error.message); process.exitCode = 1 })
