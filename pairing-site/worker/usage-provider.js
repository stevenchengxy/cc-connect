// Cloudflare TURN Analytics reports sampled, delayed egress. The account-wide
// query includes every TURN key in the Cloudflare account. SFU charges are separate.
const idPattern = /^[a-f0-9]{32}$/i;
export const accountPattern = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const authorized = value => typeof value === 'string' && /^[!-~]{16,2048}$/.test(value);
const iceURLs = new Set([
  'turn:turn.cloudflare.com:3478?transport=udp','turn:turn.cloudflare.com:443?transport=udp',
  'turn:turn.cloudflare.com:3478?transport=tcp','turn:turn.cloudflare.com:80?transport=tcp',
  'turns:turn.cloudflare.com:5349?transport=tcp','turns:turn.cloudflare.com:443?transport=tcp'
]);
export function accountIdentifier(id) {
  if (!accountPattern.test(id)) throw Error('Invalid account');
  return 'cc-' + id;
}

async function jsonBody(response, max = 16384) {
  if (!response.ok || !response.body) throw Error('Provider unavailable');
  const reader = response.body.getReader(), decoder = new TextDecoder();
  let n = 0, text = '';
  for (;;) {
    const {value,done} = await reader.read();
    if (done) break;
    n += value.byteLength;
    if (n > max) { await reader.cancel(); throw Error('Invalid provider response'); }
    text += decoder.decode(value,{stream:true});
  }
  return JSON.parse(text + decoder.decode());
}

export function periodAt(now, day = '1') {
  if (!/^(?:[1-9]|[12][0-9]|3[01])$/.test(String(day))) throw Error('Invalid billing day');
  const d = new Date(now);
  function boundary(offset) {
    const year = d.getUTCFullYear(), month = d.getUTCMonth() + offset;
    const last = new Date(Date.UTC(year,month+1,0)).getUTCDate();
    return Date.UTC(year,month,Math.min(Number(day),last));
  }
  const offset = now < boundary(0) ? -1 : 0;
  return {periodStart:new Date(boundary(offset)).toISOString(), periodEnd:new Date(boundary(offset+1)).toISOString()};
}

const DAY = 86400000;
class GraphQLQueryError extends Error {}
async function queryAccount(env,fields) {
  const tag = env.CC_CF_ACCOUNT_ID;
  if (!idPattern.test(tag || '') || !authorized(env.CC_CF_ANALYTICS_TOKEN)) throw Error('Meter unavailable');
  const query = `query {viewer {accounts(filter:{accountTag:"${tag}"}) {accountTag ${fields}}}}`;
  const response = await fetch('https://api.cloudflare.com/client/v4/graphql',{
    method:'POST', redirect:'error', signal:AbortSignal.timeout(4500),
    headers:{authorization:'Bearer '+env.CC_CF_ANALYTICS_TOKEN,'content-type':'application/json'},
    body:JSON.stringify({query})
  });
  const result = await jsonBody(response);
  if (Array.isArray(result?.errors) && result.errors.length) throw new GraphQLQueryError('Query declined');
  const accounts = result?.data?.viewer?.accounts;
  if ((result.errors != null && !Array.isArray(result.errors)) || !Array.isArray(accounts) ||
      accounts.length !== 1 || accounts[0]?.accountTag !== tag) throw Error('Meter unavailable');
  return accounts[0];
}

function aggregate(scope,start,end) {
  const filter = scope === 'global' ? '' : ', customIdentifier: ' + JSON.stringify(accountIdentifier(scope));
  return `callsTurnUsageAdaptiveGroups(limit:1, filter:{date_geq:"${start}",date_leq:"${end}"${filter}}) {sum {egressBytes ingressBytes}}`;
}
function sumRows(rows) {
  if (!Array.isArray(rows) || rows.length>1) throw Error('Incomplete meter');
  const sum=rows.length ? rows[0]?.sum : {egressBytes:0,ingressBytes:0};
  if (![sum?.egressBytes,sum?.ingressBytes].every(n=>Number.isSafeInteger(n)&&n>=0)) throw Error('Invalid meter');
  return {egressBytes:sum.egressBytes,ingressBytes:sum.ingressBytes,hasRecords:rows.length>0};
}
export async function turnQueryLimits(env) {
  const account=await queryAccount(env,'settings {callsTurnUsageAdaptiveGroups {enabled maxDuration notOlderThan}}');
  const limits=account.settings?.callsTurnUsageAdaptiveGroups;
  if (limits?.enabled!==true || ![limits.maxDuration,limits.notOlderThan].every(n=>Number.isSafeInteger(n)&&n>0)) throw Error('TURN dataset unavailable');
  return limits;
}

async function dailyUsage(env,scope,first,last,now,limits) {
  if (limits.maxDuration<86400) throw Error('Provider window shorter than one day');
  const {results}=await env.DB.prepare('SELECT * FROM relay_days WHERE provider=? AND scope=? AND day BETWEEN ? AND ?')
    .bind(env.CC_CF_ACCOUNT_ID,scope,first,last).all();
  const historical=new Map(results.map(r=>[r.day,r])), samples=[], needed=[];
  const oldest=now-limits.notOlderThan*1000;
  for (let t=Date.parse(first);t<=Date.parse(last);t+=DAY) {
    const day=new Date(t).toISOString().slice(0,10), cache=historical.get(day);
    // Historical snapshots are captured after the entire provider day closes.
    // Re-check them daily while retained. Never substitute zero for a missing day.
    if (day!==last && cache && cache.checked>=t+DAY+60000 && (cache.checked>=now-DAY || t<oldest)) {
      samples.push({egressBytes:cache.egress,ingressBytes:cache.ingress,hasRecords:!!cache.reported});
    } else {
      if (t<oldest) throw Error('Period starts outside provider retention');
      needed.push(day);
    }
  }
  // Four aliases per request, all for exactly one account scope. Each alias
  // covers one complete UTC date, including on a cold start late in the month.
  for (let i=0;i<needed.length;i+=4) {
    const dates=needed.slice(i,i+4);
    const fields=dates.map((d,j)=>'d'+j+':'+aggregate(scope,d,d)).join(' ');
    const answer=await queryAccount(env,fields), store=[];
    for (const [j,day] of dates.entries()) {
      const sample=sumRows(answer['d'+j]);
      if (!sample.hasRecords && historical.get(day)?.reported) throw Error('Incomplete historical meter');
      samples.push(sample);
      if (Date.parse(day)+DAY+60000<=now) store.push([env.CC_CF_ACCOUNT_ID,scope,day,sample.egressBytes,sample.ingressBytes,Number(sample.hasRecords),now]);
    }
    if (store.length) {
      const values=store.map(()=>'(?,?,?,?,?,?,?)').join(',');
      await env.DB.prepare(`INSERT INTO relay_days(provider,scope,day,egress,ingress,reported,checked) VALUES ${values}
        ON CONFLICT(provider,scope,day) DO UPDATE SET egress=excluded.egress,ingress=excluded.ingress,
        reported=excluded.reported,checked=excluded.checked WHERE excluded.checked>=checked`).bind(...store.flat()).run();
    }
  }
  const sum={egressBytes:0,ingressBytes:0,hasRecords:false};
  for (const s of samples) { sum.egressBytes+=s.egressBytes; sum.ingressBytes+=s.ingressBytes; sum.hasRecords ||= s.hasRecords; }
  if (![sum.egressBytes,sum.ingressBytes].every(Number.isSafeInteger)) throw Error('Invalid total');
  return sum;
}

export async function readTurnUsage(env,scope,now=Date.now()) {
  const period=periodAt(now,env.CC_TURN_BILLING_DAY);
  const first=period.periodStart.slice(0,10),last=new Date(now).toISOString().slice(0,10);
  let sample,basis='period';
  try { sample=sumRows((await queryAccount(env,aggregate(scope,first,last))).callsTurnUsageAdaptiveGroups); }
  catch (e) {
    if (!(e instanceof GraphQLQueryError) || first===last) throw e;
    const limits=await turnQueryLimits(env);
    const span=Date.parse(last)-Date.parse(first)+DAY;
    if (limits.maxDuration*1000>=span && now-Date.parse(first)<=limits.notOlderThan*1000) throw e;
    sample=await dailyUsage(env,scope,first,last,now,limits);
    basis='daily';
  }
  return {scope,...period,...sample,basis,checkedAt:now,source:'cloudflare-analytics'};
}

function credentialEndpoint(env, keyId) {
  if (!idPattern.test(keyId || '') || keyId !== env.CC_CF_TURN_KEY_ID || !authorized(env.CC_CF_TURN_API_TOKEN)) throw Error('TURN unavailable');
  return 'https://rtc.live.cloudflare.com/v1/turn/keys/'+keyId+'/credentials/';
}
export const issuerConfigured = env => idPattern.test(env.CC_CF_TURN_KEY_ID || '') && authorized(env.CC_CF_TURN_API_TOKEN);
export async function issueTurn(env, accountId, ttl) {
  if (!Number.isSafeInteger(ttl) || ttl < 5 || ttl > 120) throw Error('Invalid lifetime');
  const url = credentialEndpoint(env,env.CC_CF_TURN_KEY_ID)+'generate';
  const response = await fetch(url,{method:'POST',redirect:'error',signal:AbortSignal.timeout(4000),
    headers:{authorization:'Bearer '+env.CC_CF_TURN_API_TOKEN,'content-type':'application/json'},
    body:JSON.stringify({ttl, customIdentifier:accountIdentifier(accountId)})});
  if (response.status !== 201) throw Error('TURN unavailable');
  const body = await jsonBody(response);
  // The tagged /generate endpoint can return one ICE object; newer ICE lists
  // contain separate STUN and authenticated TURN entries.
  const entries = Array.isArray(body?.iceServers) ? body.iceServers : [body?.iceServers];
  for (const entry of entries) {
    if (!Array.isArray(entry?.urls) || typeof entry?.username !== 'string' || typeof entry?.credential !== 'string' ||
        !/^[a-zA-Z0-9:_=-]{1,512}$/.test(entry.username) || !/^[!-~]{1,512}$/.test(entry.credential)) continue;
    const urls = [...new Set(entry.urls.filter(url=>iceURLs.has(url)))];
    if (urls.length) return [{urls,username:entry.username,credential:entry.credential}];
  }
  throw Error('Invalid relay response');
}
export async function revokeTurn(env, keyId, username) {
  if (typeof username !== 'string' || !/^[a-zA-Z0-9:_=-]{1,512}$/.test(username)) throw Error('Invalid credential');
  const url = credentialEndpoint(env,keyId)+encodeURIComponent(username)+'/revoke';
  const response = await fetch(url,{method:'POST',redirect:'error',signal:AbortSignal.timeout(3500),
    headers:{authorization:'Bearer '+env.CC_CF_TURN_API_TOKEN}});
  await response.body?.cancel();
  if (response.status !== 204) throw Error('Revocation not confirmed');
}

export async function verifyKeyOwner(env) {
  const tag = env.CC_CF_ACCOUNT_ID, key = env.CC_CF_TURN_KEY_ID;
  if (!idPattern.test(tag || '') || !idPattern.test(key || '') || !authorized(env.CC_CF_ANALYTICS_TOKEN)) throw Error('Meter unavailable');
  const response = await fetch('https://api.cloudflare.com/client/v4/accounts/'+tag+'/calls/turn_keys/'+key,{
    redirect:'error',signal:AbortSignal.timeout(4500),headers:{authorization:'Bearer '+env.CC_CF_ANALYTICS_TOKEN}
  });
  const data = await jsonBody(response);
  if (data?.success !== true || data.result?.uid !== key) throw Error('TURN key ownership unconfirmed');
}
