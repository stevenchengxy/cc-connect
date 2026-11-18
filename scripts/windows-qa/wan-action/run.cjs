const path = require('node:path')
const fs = require('node:fs/promises')
const {spawn} = require('node:child_process')
const {createInterface} = require('node:readline')
const {setTimeout:delay} = require('node:timers/promises')
const {DefaultArtifactClient} = require(path.join(process.env.RUNNER_TEMP,'cc-owned-tools','node_modules','@actions','artifact'))

async function run() {
  const envelope=path.join(process.env.RUNNER_TEMP,'cc-owned-invite.enc')
  const executable=path.resolve('node_modules/electron/dist/electron.exe')
  const childEnv={...process.env}
  for (const key of Object.keys(childEnv)) {
    if (/^(ACTIONS_RUNTIME_|ACTIONS_ID_TOKEN_|GITHUB_TOKEN$)/i.test(key)) delete childEnv[key]
  }
  const child=spawn(executable,[path.resolve('scripts/verify-wan-cross.cjs'),'host',envelope,'control'],{env:childEnv,stdio:['ignore','pipe','pipe']})
  let pass=false, finished=false
  const ended=new Promise(resolve=>{
    child.once('error',()=>{finished=true;resolve(1)})
    child.once('exit',code=>{finished=true;resolve(code)})
  })
  const read=createInterface({input:child.stdout})
  read.on('line',line=>{
    if(line==='PASS real Win32 window-targeted mouse and KeyA with physical pixels')pass=true
    if(/^(PASS real Win32|Owned Windows form ready|Owned fixture exit code [0-9]+$|Windows owned form confirmed|Managed pairing completed|Managed TURN entries|Host control ICE route|  (policy|path|local|remote|protocol):)/.test(line))console.log(line)
  })
  const errors=createInterface({input:child.stderr})
  errors.on('line',line=>{if(/^The synthetic WAN check did not complete during [a-z ]+$/.test(line))console.log(line)})
  const finite=setTimeout(()=>{child.kill()},370000)
  try {
    let ready=false
    for(let i=0;i<125 && !finished;i++) {
      if(await fs.stat(envelope).then(s=>s.size>100).catch(()=>false)){ready=true;break}
      await delay(400)
    }
    if(!ready)throw Error('Encrypted invitation not available')
    await new DefaultArtifactClient().uploadArtifact('cc-owned-window-invitation',[envelope],process.env.RUNNER_TEMP,{retentionDays:1})
    if(await ended!==0 || !pass)throw Error('Windows form acceptance did not complete')
  } finally {
    clearTimeout(finite);if(!finished)child.kill();read.close();errors.close()
    await fs.rm(envelope,{force:true})
  }
}
run().catch(()=>{console.error('Owned Windows WAN acceptance failed.');process.exitCode=1})
