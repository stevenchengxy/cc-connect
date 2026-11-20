'use strict'

const { execFileSync } = require('node:child_process')
const { readFileSync } = require('node:fs')
const path = require('node:path')

module.exports = function verifyMacSignatures({ electronPlatformName, appOutDir }, certificate) {
  if (electronPlatformName !== 'darwin') return
  const app = path.join(appOutDir, 'CC Connect.app')
  const native = path.join(app, 'Contents', 'Resources', 'native', 'bin')
  const verify = ['--verify', '--all-architectures', '--strict']
  execFileSync('/usr/bin/codesign', [...verify, '--deep', app])
  const signer = certificate ? 'anchor apple generic and certificate leaf[field.1.2.840.113635.100.6.1.13] exists'
    + ' and certificate leaf = H"' + certificate + '" and ' : ''
  for (const [target, identifier] of [
    [app, 'app.jianping.desktop'],
    [path.join(native, 'cc-mac-input.node'), 'app.jianping.input'],
    [path.join(native, 'CC Connect Screen.app'), 'app.jianping.screen']
  ]) {
    execFileSync('/usr/bin/codesign', [...verify, '-R=' + signer + 'identifier "' + identifier + '"', target])
  }
  // The native components already carry the signatures from build-native.
  // Re-signing with the same identifier can still replace their entitlements.
  for (const relative of ['cc-mac-input.node', 'CC Connect Screen.app/Contents/MacOS/cc-connect-screen']) {
    const original = readFileSync(path.join(__dirname, '..', 'native', 'bin', relative))
    if (!original.equals(readFileSync(path.join(native, relative)))) {
      throw new Error('Packaged native executable differs from the signed original: ' + relative)
    }
  }
}
