#!/usr/bin/env node
'use strict';

// Standalone operator tool. No account requests are made unless --apply is supplied.
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const origin = 'https://api.cloudflare.com/client/v4';
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const hexId = /^[a-f0-9]{32}$/i;
const marker = 'CC_CONNECT_DEPLOYMENT_OWNER';

function apiClient(account, token, transport) {
  return async function api(route, method = 'GET', data, allowMissingWorker = false) {
    const init = { method, headers: {authorization:'Bearer '+token}, redirect:'error', signal:AbortSignal.timeout(45_000) };
    if (data instanceof FormData) init.body = data;
    else if (data !== undefined) { init.headers['content-type']='application/json'; init.body=JSON.stringify(data); }
    const response = await transport(origin+'/accounts/'+account+route,init);
    let payload;
    try { payload=await response.json(); } catch { throw Error(`Cloudflare returned HTTP ${response.status} without API JSON`); }
    if (!response.ok || payload.success !== true) {
      const codes=(payload.errors || []).map(e=>Number(e.code)).filter(Number.isFinite);
      if (allowMissingWorker && response.status===404 && codes.includes(10007)) return null;
      // Provider error bodies can echo request data containing secrets.
      throw Error(`${method} ${route.split('?')[0]} failed (HTTP ${response.status}, provider codes ${codes.join(',')})`);
    }
    return payload.result;
  };
}

async function atomicState(file,state) {
  const temp=file+'.'+randomUUID()+'.tmp';
  try {
    await fs.writeFile(temp,JSON.stringify(state),{flag:'wx', mode:0o600});
    await fs.rename(temp,file);
  } finally { await fs.rm(temp,{force:true}); }
}

async function verifyWorker(api,slug,state) {
  const settings=await api(`/workers/scripts/${slug}/settings`,'GET',undefined,true);
  if (!settings) return null;
  const entries=settings.bindings;
  if (!Array.isArray(entries) || !entries.some(b=>b.name===marker && b.type==='plain_text' && b.text===state.owner)) {
    throw Error('A Worker already owns this slug. Choose another dedicated slug or restore the original deployment state.');
  }
  if (!entries.some(b=>b.name==='DB' && (b.id||b.database_id)===state.dbId)) throw Error('Existing Worker database binding has changed. Reconcile project state before deploying.');
  return entries;
}

async function applySchema(api,dbId) {
  async function sql(data) {
    const result=await api(`/d1/database/${dbId}/query`,'POST',data);
    if (!Array.isArray(result) || !result.length || result.some(r=>r.success!==true)) throw Error('D1 migration query was not confirmed.');
    return result;
  }
  await sql({sql:'CREATE TABLE IF NOT EXISTS cc_deploy_migrations (name TEXT PRIMARY KEY, sha256 TEXT NOT NULL)'});
  const known=(await sql({sql:'SELECT name,sha256 FROM cc_deploy_migrations'}))[0].results;
  const journal=JSON.parse(await fs.readFile(path.join(__dirname,'drizzle/meta/_journal.json'),'utf8'));
  for (const {tag} of journal.entries) {
    if (!/^\d{4}_[a-zA-Z0-9_]+$/.test(tag)) throw Error('Unexpected migration tag');
    const contents=await fs.readFile(path.join(__dirname,'drizzle',tag+'.sql'),'utf8');
    const digest=createHash('sha256').update(contents).digest('hex');
    const prior=known.find(x=>x.name===tag);
    if (prior) { if (prior.sha256!==digest) throw Error('Applied migration has changed: '+tag); continue; }
    const batch=contents.split('--> statement-breakpoint').map(s=>s.trim()).filter(Boolean).map(sql=>({sql}));
    batch.push({sql:'INSERT INTO cc_deploy_migrations(name,sha256) VALUES(?,?)',params:[tag,digest]});
    await sql({batch});
  }
}

async function deploy({account, token, slug, storage, transport=fetch}) {
  if (!hexId.test(account||'') || !/^[!-~]{16,2048}$/.test(token||'')) throw Error('Set CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN in the operator environment.');
  if (!/^[a-z][a-z0-9-]{1,40}[a-z0-9]$/.test(slug||'')) throw Error('Specify a dedicated 3–42 character lowercase Worker slug.');
  const api=apiClient(account,token,transport);
  const domain=(await api('/workers/subdomain')).subdomain;
  if (!/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(domain||'')) throw Error('Choose your account workers.dev subdomain in Workers & Pages, then retry.');
  const dir=path.join(storage,account,slug), file=path.join(dir,'deployment.json');
  await fs.mkdir(dir,{mode:0o700,recursive:true});
  const lockFile=path.join(dir,'deploy.lock');
  let lock;
  try { lock=await fs.open(lockFile,'wx',0o600); }
  catch (e) { if (e.code==='EEXIST') throw Error('Another deployment is using this local state. See the operator recovery notes.'); throw e; }
  try {
    let state;
    try { state=JSON.parse(await fs.readFile(file,'utf8')); }
    catch (e) { if(e.code!=='ENOENT')throw e; state={owner:randomUUID(),account,slug}; await atomicState(file,state); }
    if (state.account!==account || state.slug!==slug || !uuid.test(state.owner)) throw Error('Local deployment state does not match the target account and slug.');
    await verifyWorker(api,slug,state);
    const name=slug+'-'+state.owner.slice(0,8);
    if (!state.dbId) {
      // The random owner suffix is written before the API call so a lost creation response is recoverable.
      const matches=(await api('/d1/database?name='+encodeURIComponent(name))).filter(d=>d.name===name);
      if (matches.length>1) throw Error('Ambiguous project database name');
      const db=matches[0] || await api('/d1/database','POST',{name});
      if (!uuid.test(db.uuid)) throw Error('Database creation did not return an identifier');
      state.dbId=db.uuid; await atomicState(file,state);
    }
    if (!uuid.test(state.dbId) || (await api('/d1/database/'+state.dbId)).name!==name) throw Error('Database ownership could not be matched to this project.');
    await applySchema(api,state.dbId);
    if (!state.turnId) {
      const keys=await api('/calls/turn_keys');
      if (!Array.isArray(keys) || keys.some(k=>k.name===name)) throw Error('Found a project TURN key without its local receipt. Recover the receipt or re-provision that key explicitly.');
      const key=await api('/calls/turn_keys','POST',{name});
      if (!hexId.test(key.uid||'') || !/^[!-~]{16,256}$/.test(key.key||key.secret||'')) throw Error('TURN key creation was not confirmed. Inspect the project TURN key before retrying.');
      state.turnId=key.uid; state.pendingSecret=key.key||key.secret;
      await atomicState(file,state);
    }
    if (!hexId.test(state.turnId) || (await api('/calls/turn_keys/'+state.turnId)).name!==name) throw Error('TURN key ownership could not be matched to this project.');
    const existing=await verifyWorker(api,slug,state);
    const bindings=[{type:'d1',name:'DB',id:state.dbId},{type:'plain_text',name:marker,text:state.owner},
      {type:'plain_text',name:'CC_CF_TURN_KEY_ID',text:state.turnId}];
    if (state.pendingSecret) bindings.push({type:'secret_text',name:'CC_CF_TURN_API_TOKEN',text:state.pendingSecret});
    else if (!existing?.some(b=>b.name==='CC_CF_TURN_API_TOKEN'&&b.type==='secret_text')) throw Error('The project TURN secret binding is missing. Restore it with the original private credential before retrying.');
    const metadata={main_module:'index.js',compatibility_date:'2026-05-01',bindings};
    if (!state.pendingSecret) metadata.keep_bindings=['secret_text'];
    const form=new FormData();
    form.append('metadata',JSON.stringify(metadata));
    form.append('index.js',new Blob([await (await import('./scripts/bundle.mjs')).bundleWorker()],{type:'application/javascript+module'}),'index.js');
    await api(`/workers/scripts/${slug}`,'PUT',form);
    const installed=await verifyWorker(api,slug,state);
    if (!installed?.some(b=>b.name==='CC_CF_TURN_API_TOKEN'&&b.type==='secret_text')) throw Error('Worker secret upload has not been confirmed. Retry with the same local state.');
    delete state.pendingSecret; await atomicState(file,state);
    await api(`/workers/scripts/${slug}/subdomain`,'POST',{enabled:true,previews_enabled:false});
    return `https://${slug}.${domain}.workers.dev`;
  } finally { await lock.close(); await fs.rm(lockFile,{force:true}); }
}

if (require.main===module) {
  if (process.argv[2]!=='--apply' || process.argv.length!==4) {
    console.log('Usage: node pairing-site/deploy-cloudflare.cjs --apply <dedicated-worker-slug>');
    console.log('Creates or updates one project Worker, one D1 database and one Realtime TURN key. Uses the operator account and may incur bandwidth charges.');
    if(process.argv.length>2 && process.argv[2]!=='--help') process.exitCode=2;
  } else deploy({account:process.env.CLOUDFLARE_ACCOUNT_ID,token:process.env.CLOUDFLARE_API_TOKEN,slug:process.argv[3],storage:path.join(os.homedir(),'.config/cc-connect-cloudflare')})
    .then(url=>console.log('Pairing service deployed at '+url+'/v1'))
    .catch(error=>{console.error(error.message);process.exitCode=1;});
}
module.exports={deploy};
