const { spawn } = require('node:child_process')
const { createInterface } = require('node:readline')
const crypto = require('node:crypto')
const path = require('node:path')

function startWindow() {
  if (process.platform !== 'win32' || process.env.GITHUB_ACTIONS !== 'true' ||
      process.env.CC_QA_RUNNER_CLASS !== 'github-hosted' || process.env.RUNNER_OS !== 'Windows') throw Error('Disposable Windows VM required')
  const child = spawn(path.join(process.env.RUNNER_TEMP,'CC-OwnedWindow-WAN.exe'), ['--owned-window'],{stdio:['pipe','pipe','pipe'], windowsHide:true})
  let latest, ready=false, clicked=false, typed=false, stopped=false, sent=0
  const lines=createInterface({input:child.stdout})
  lines.on('line',line=>{
    if (line==='READY') ready=true
    if (line==='CONFIRMED_CLICK') {clicked=true;console.log('Windows owned form confirmed center mouse down/up and green physical pixel')}
    if (line==='CONFIRMED_KEY_A') {typed=true;console.log('Windows owned form confirmed KeyA down/up and blue physical pixel')}
    if (line.startsWith('FRAME ') && line.length<30000) latest='data:image/png;base64,'+line.slice(6)
  })
  child.stdin.on('error',()=>{stopped=true})
  child.on('error',()=>{stopped=true})
  child.on('exit',code=>{stopped=true;if(code!==0)console.log('Owned fixture exit code',code)})
  return {
    async ready() {
      for (let i=0;i<150;i++) {
        if (ready && latest) return
        if (stopped) break
        await new Promise(resolve=>setTimeout(resolve,100))
      }
      throw Error('Owned Windows fixture unavailable')
    },
    frame(){return stopped ? null : latest},
    input(operation){
      if (stopped || !ready || !((operation==='CENTER_CLICK' && sent===0) || (operation==='KEY_A' && sent===1 && clicked))) return false
      sent++;child.stdin.write(operation+'\n');return true
    },
    passed(){return clicked && typed},
    close(){if (!stopped) child.stdin.end('END\n');lines.close()}
  }
}

function sealInvite(invite,der) {
  const pub=crypto.createPublicKey({key:Buffer.from(der,'base64'),format:'der',type:'spki'})
  if (pub.asymmetricKeyType!=='rsa'||pub.asymmetricKeyDetails.modulusLength!==3072) throw Error('QA recipient key rejected')
  const key=crypto.randomBytes(32), nonce=crypto.randomBytes(12)
  const aes=crypto.createCipheriv('aes-256-gcm',key,nonce)
  const ciphertext=Buffer.concat([aes.update(invite,'utf8'),aes.final()])
  const wrapped=crypto.publicEncrypt({key:pub,oaepHash:'sha256'},key)
  return JSON.stringify({wrapped:wrapped.toString('base64'),nonce:nonce.toString('base64'),tag:aes.getAuthTag().toString('base64'),ciphertext:ciphertext.toString('base64')})
}
module.exports={startWindow,sealInvite}
