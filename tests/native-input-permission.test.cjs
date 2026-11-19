'use strict'

const {test} = require('node:test')
const assert = require('node:assert/strict')
const {once} = require('node:events')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const {InputBridge} = require('../native/bridge.cjs')

async function fixture(t, onCheck) {
  const resourcesPath = await fs.mkdtemp(path.join(os.tmpdir(),'cc-input-permission-'))
  const dir = path.join(resourcesPath,'native','bin')
  await fs.mkdir(dir,{recursive:true})
  // This private executable accepts only test permission queries, never input.
  await fs.writeFile(path.join(dir,'jianping-input'), [
    '#!/bin/sh', 'if [ "$1" = "--check" ]; then echo DENIED; exit 0; fi', 'echo READY',
    'while IFS= read -r line; do', '  [ "$line" = "check-access" ] || exit 2', ...onCheck, 'done'
  ].join('\n') + '\n',{mode:0o700})
  const bridge = new InputBridge()
  t.after(async () => { await bridge.stop(); await fs.rm(resourcesPath,{force:true,recursive:true}) })
  const options = {resourcesPath,isPackaged:true}
  assert.equal(await InputBridge.macAccess(options),'denied')
  await bridge.start({id:123}, options)
  return bridge
}

test('recheck uses the working input process and reports its actual revocation', {skip:process.platform !== 'darwin'}, async t => {
  const bridge = await fixture(t, [
    'if [ -z "$checked" ]; then checked=1; echo "ACCESS OK"; else echo "ERROR control-permission"; exit 1; fi'
  ])
  const first = once(bridge.session.child.stdout,'data')
  bridge.recheckAccess()
  assert.equal(String((await first)[0]).trim(),'ACCESS OK')
  const error = once(bridge,'error')
  bridge.recheckAccess()
  assert.equal((await error)[0].message,'control-permission')
  assert.equal(bridge.session,null)
  bridge.recheckAccess()
})

test('an unresponsive input helper closes as unavailable, distinct from a denied grant', {skip:process.platform !== 'darwin'}, async t => {
  const bridge = await fixture(t, [':'])
  const error = once(bridge,'error')
  bridge.recheckAccess()
  assert.match((await error)[0].message,/仅观看/)
  assert.equal(bridge.session,null)
})
