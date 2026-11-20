'use strict'

const { execFileSync } = require('node:child_process')
const path = require('node:path')
const verifyMacSignatures = require('./verify-mac-signatures.cjs')

async function buildSignedMac() {
  if (process.platform !== 'darwin') throw new Error('Developer ID builds require macOS.')
  const available = execFileSync('/usr/bin/security', ['find-identity', '-v', '-p', 'codesigning'], { encoding: 'utf8' })
  const identities = [...available.matchAll(/^\s*\d+\) ([A-Fa-f0-9]{40}) "(Developer ID Application: .+)"\s*$/gm)]
  const selector = process.env.CSC_NAME
  const matching = identities.filter(([, hash, name]) =>
    !selector || selector.toUpperCase() === hash.toUpperCase() || name.includes(selector))
  if (!matching.length) throw new Error('The keychain has no matching valid Developer ID Application identity with a private key.')
  if (matching.length > 1) throw new Error('Set CSC_NAME to the SHA-1 fingerprint of the intended Developer ID Application identity.')
  const certificate = matching[0][1].toUpperCase()

  const root = path.join(__dirname, '..')
  execFileSync(process.execPath, [path.join(__dirname, 'build-native.cjs'), certificate], { stdio: 'inherit' })
  const { Arch, Platform, build } = require('electron-builder')
  let verified = false
  await build({
    projectDir: root,
    targets: Platform.MAC.createTarget('dmg', Arch.universal),
    publish: 'never',
    config: {
      forceCodeSigning: true,
      mac: {
        identity: certificate, type: 'distribution', hardenedRuntime: true,
        // Keep the fingerprint when two valid certificates have the same display name.
        sign: options => require('@electron/osx-sign').signAsync({ ...options, identity: certificate })
      },
      afterSign(context) {
        verifyMacSignatures(context, certificate)
        verified = true
      },
      artifactBuildStarted() {
        if (!verified) throw new Error('The Developer ID signatures must be verified before creating the DMG.')
      }
    }
  })
}

buildSignedMac().catch(error => { console.error(error.message); process.exitCode = 1 })
