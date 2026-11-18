'use strict';
const labels = {
  language:['语言','語言','Language'], console:['管理控制台','管理控制台','Admin console'], signin:['管理员登录','管理員登入','Admin sign in'], user:['账号','帳號','Username'], password:['密码','密碼','Password'],
  logout:['退出','登出','Sign out'], usage:['本期中继用量','本期中繼用量','Relay usage this period'], refresh:['刷新','重新整理','Refresh'], budgetUsage:['预算已用','預算已用','Usage against budget'],providerUsage:['Cloudflare 全账户 TURN','Cloudflare 全帳戶 TURN','Cloudflare account TURN'],outgoing:['中继出站流量','中繼輸出流量','Relay outbound traffic'],billingPeriod:['账期（UTC）','帳期（UTC）','Billing period (UTC)'], budget:['中继预算','中繼預算','Relay budget'], relay:['公共中继','公共中繼','Public relay'],
  off:['已关闭','已關閉','Off'], protected:['保护模式','保護模式','Protected'], quotaSettings:['中继设置','中繼設定','Relay settings'], accounts:['账号管理','帳號管理','Accounts'], newInvite:['创建邀请码','建立邀請碼','Create invite'], filter:['筛选状态','篩選狀態','Filter by status'], all:['全部状态','全部狀態','All statuses'], approved:['已批准','已核准','Approved'], pending:['待审批','待審核','Pending approval'], suspended:['已停用','已停用','Suspended'], revoked:['已撤销','已撤銷','Revoked'],
  more:['加载更多','載入更多','Load more'], manage:['管理','管理','Manage'], noAccounts:['此状态下没有账号。','此狀態下沒有帳號。','No accounts in this view.'], admin:['管理员','管理員','Administrator'], approveAndSave:['批准账号并保存配额','核准帳號並儲存配額','Approve account and save quota'], approve:['批准使用','核准使用','Approve access'], suspend:['停用账号','停用帳號','Suspend account'], revoke:['永久撤销','永久撤銷','Revoke permanently'], sessions:['退出所有设备','登出所有裝置','Sign out all devices'], quota:['账号配额','帳號配額','Account quota'], copy:['复制','複製','Copy'], copied:['已复制','已複製','Copied'], invite:['一次性邀请码','一次性邀請碼','Single-use invite'], expires:['有效期至','有效期至','Expires'], singleUse:['注册后仍需管理员批准。','註冊後仍需管理員核准。','New accounts require administrator approval.'],
  save:['保存设置','儲存設定','Save settings'], concurrency:['最多同时有效的中继凭据','最多同時有效的中繼憑證','Maximum simultaneous relay credentials'], gb:['本期预算（GB）','本期預算（GB）','Budget for this period (GB)'], policy:['公共中继模式','公共中繼模式','Public relay mode'], check:['统计时间','統計時間','Measured'], active:['有效凭据','有效憑證','Active credentials'], unavailable:['用量暂不可用','用量暫不可用','Usage unavailable'], noData:['Cloudflare 本次查询暂无记录','Cloudflare 本次查詢暫無紀錄','No records in this Cloudflare query'],
  boundary:['达到预算的 90% 后停止签发凭据。流量统计存在延迟。同一 Cloudflare 账户的其他 Realtime 服务也占用免费额度。','達到預算的 90% 後停止簽發憑證。流量統計存在延遲。同一 Cloudflare 帳戶的其他 Realtime 服務也佔用免費額度。','New credentials stop at 90% of the budget. Metering is delayed. Other Realtime services on the same Cloudflare account also use the shared allowance.'],
  memberBudget:['账号和全局均有可用配额时才能使用中继。配额为零时仍可直连。','帳號和全域均有可用配額時才能使用中繼。配額為零時仍可直連。','Relay needs available account and global quotas. A zero relay quota still allows direct connections.'],
  failed:['操作失败，请刷新后重试。','操作失敗，請重新整理後再試。','Could not complete the action. Refresh and retry.'], unavailableAction:['服务或流量计量暂不可用，请检查服务端配置。','服務或流量計量暫不可用，請檢查伺服器設定。','Service or metering unavailable. Check the server configuration.'], denied:['请使用已批准的管理员账号。','請使用已核准的管理員帳號。','Use an approved administrator account.'], credentials:['账号或密码有误。','帳號或密碼有誤。','Check your username and password.'], expired:['登录已失效，请重新登录。','登入已失效，請重新登入。','Your session expired. Sign in again.'], busy:['请求过于频繁，请稍后再试。','請求過於頻繁，請稍後再試。','Too many requests. Try again later.'], invalid:['请检查数值和预算余量。','請檢查數值和預算餘額。','Check the values and remaining budget.'], done:['已保存。','已儲存。','Saved.'],
  irreversible:['永久撤销后，账号将无法重新启用。','永久撤銷後，帳號將無法重新啟用。','Revocation is permanent. This account cannot be reactivated.'], confirm:['确认撤销','確認撤銷','Confirm revocation'], cancel:['取消','取消','Cancel'], net:['正在读取…','讀取中…','Loading…'], enter:['重新登录','重新登入','Sign in again'], close:['关闭','關閉','Close']
};
const $=id=>document.getElementById(id);
let locale=localStorage.getItem('cc.admin.language') || (navigator.language.toLowerCase().startsWith('zh') ? (/tw|hk|hant/i.test(navigator.language)?'zh-TW':'zh-CN'):'en');
if (!['zh-CN','zh-TW','en'].includes(locale)) locale='zh-CN';
const t=k=>labels[k]?.[['zh-CN','zh-TW','en'].indexOf(locale)] || k;
let token='', accounts=[], cursor=null, globalInfo=null, generation=0, detailVersion=0, busy=false;
function element(tag,txt,cls) {const e=document.createElement(tag);if(txt!==undefined)e.textContent=txt;if(cls)e.className=cls;return e;}
function localize(){document.documentElement.lang=locale;$('lang').value=locale;document.querySelectorAll('[data-t]').forEach(n=>n.textContent=t(n.dataset.t));document.querySelector('.close').setAttribute('aria-label',t('close'));render();}
function notice(key,inDialog=false){$(inDialog?'dialog-msg':'notice').textContent=key ? t(key):'';}
function clear(){generation++; token='';accounts=[];cursor=null;globalInfo=null;$('details').close();$('workspace').hidden=true;$('logout').hidden=true;$('signin').hidden=false;render();}
async function api(url,method='GET',data) {
  const headers={}; if(token)headers.Authorization='Bearer '+token;
  if(data!==undefined)headers['Content-Type']='application/json';
  const r=await fetch('/v1/'+url,{method,headers,body:data===undefined?undefined:JSON.stringify(data),credentials:'omit',cache:'no-store',redirect:'error',signal:AbortSignal.timeout(20000)});
  if(!r.ok){const signedIn=Boolean(headers.Authorization);if(r.status===401 && signedIn && headers.Authorization==='Bearer '+token){clear();notice('expired');}
    throw new Error(({400:'invalid',401:signedIn?'expired':'credentials',403:'denied',409:'invalid',429:'busy',503:'unavailableAction'})[r.status]||'failed');}
  return r.status===204 ? null:r.json();
}
async function action(button,fn,inDialog=false) {
  if(button.disabled)return;button.disabled=true;notice('',inDialog);
  try{await fn();}catch(e){notice(labels[e.message]?e.message:'failed',inDialog && $('details').open);}
  finally{button.disabled=false;}
}
function btn(label,fn,cls){const b=element('button',t(label),cls);b.type='button';b.onclick=()=>action(b,fn,true);return b;}
function decimal(bytes){return new Intl.NumberFormat(locale,{maximumFractionDigits:3}).format(bytes / 1e9)+' GB';}
function traffic(bytes){
  const [size,unit]=bytes>=1e9?[1e9,'GB']:bytes>=1e6?[1e6,'MB']:bytes>=1e3?[1e3,'kB']:[1,'B'];
  return new Intl.NumberFormat(locale,{maximumFractionDigits:2}).format(bytes/size)+' '+unit;
}
function usageStamp(info){if(!info?.usage)return t('unavailable');const u=info.usage;
  const day=d=>new Date(d).toISOString().slice(0,10);
  const period=t('billingPeriod')+' '+day(u.periodStart)+' – '+day(Date.parse(u.periodEnd)-1);
  return (u.hasRecords?'':t('noData')+' · ')+period+' · '+t('check')+' '+new Date(u.checkedAt).toLocaleString(locale);}
function render(){
  $('bytes').textContent=globalInfo?.usage?traffic(globalInfo.usage.budgetEgressBytes ?? globalInfo.usage.egressBytes):'—';
  $('budget').textContent=globalInfo?decimal(globalInfo.limitBytes):'—';$('mode').textContent=globalInfo?t(globalInfo.mode):'—';
  const measured=globalInfo?.usage;
  const raw=measured && measured.budgetEgressBytes>measured.egressBytes ? t('providerUsage')+' '+traffic(measured.egressBytes)+' · ' : '';
  $('stamp').textContent=globalInfo?raw+usageStamp(globalInfo):'';const rows=$('rows');rows.replaceChildren();
  for(const a of accounts.filter(a=>$('filter').value==='all'||a.status===$('filter').value)){
    const el=element('div',undefined,'account'),ident=element('div',undefined,'identity');
    ident.append(element('span',a.username,'name'),element('span',(a.role==='admin'?t('admin')+' · ':'')+t(a.status),'sub'));
    const reading=element('span',t('budgetUsage')+' · '+(a.relayUsedBytes==null?'—':traffic(a.relayUsedBytes))+' / '+decimal(a.relayBudgetBytes ?? 0),'sub');
    if(a.relayCheckedAt)reading.title=t('check')+' '+new Date(a.relayCheckedAt).toLocaleString(locale);ident.append(reading);
    const b=element('button',t('manage'));b.onclick=()=>showAccount(a);el.append(ident,b);rows.append(el);
  }
  if(!rows.childElementCount)rows.append(element('p',t('noAccounts'),'fine'));$('more').hidden=!cursor;
}
async function refresh(append=false){
  if(!token)return;const id=++generation;
  const params=new URLSearchParams();if(append&&cursor)params.set('cursor',cursor);if($('filter').value!=='all')params.set('status',$('filter').value);
  const page=await api('admin/accounts'+(params.size?'?'+params:''));
  if(id!==generation || !token)return;
  accounts=append?[...accounts,...page.accounts]:page.accounts;cursor=page.nextCursor;render();
  if(!append){const usage=await api('admin/usage');if(id===generation && token){globalInfo=usage;render();}}
}
function dialog(title){detailVersion++;$('dialog-title').textContent=title;$('dialog-body').replaceChildren();notice('',true);if(!$('details').open)$('details').showModal();return $('dialog-body');}
function titled(label,control){const f=element('label',undefined,'field');f.append(element('span',t(label)),control);return f;}
function number(value,max,step){const i=element('input');i.type='number';i.step=step;i.max=max;i.min='0';i.required=true;i.value=String(value);return i;}
function quotaForm(body,info,id,approvePending=false){
  const form=element('form');const bytes=number(approvePending && !info.limitBytes && !info.maxConcurrent ? 10 : info.limitBytes/1e9,1000,0.001),con=number(approvePending && !info.limitBytes && !info.maxConcurrent ? 2 : info.maxConcurrent,id==='global'?16:8,1);let mode;
  if(id==='global'){mode=element('select');for(const v of ['off','protected'])mode.append(new Option(t(v),v));mode.value=info.mode;form.append(titled('policy',mode));}
  form.append(titled('gb',bytes),titled('concurrency',con),element('p',t(id==='global'?'boundary':'memberBudget'),'fine'));
  const save=element('button',t(approvePending?'approveAndSave':'save'),'primary');form.append(save);
  form.onsubmit=e=>{e.preventDefault();void action(save,async()=>{const data={limitBytes:Math.round(bytes.valueAsNumber*1e9),maxConcurrent:con.valueAsNumber};if(mode)data.mode=mode.value;
    const updated=await api('admin/quotas/'+id,'PATCH',data);if(approvePending){await api('admin/accounts/'+id,'PATCH',{status:'approved'});await refresh();}else if(id==='global'){globalInfo=updated;render();}
    $('details').close();notice('done');},true);};body.append(form);
}
async function showAccount(a){
  const body=dialog(a.username),view=detailVersion;
  body.append(element('p',t(a.status),'fine'));
  const controls=element('div',undefined,'buttons');body.append(controls);
  async function change(status){await api('admin/accounts/'+a.id,'PATCH',{status});$('details').close();await refresh();}
  if(a.role!=='admin' && a.status!=='revoked'){
    if(a.status==='suspended')controls.append(btn('approve',()=>change('approved'),'primary'));
    if(a.status==='approved')controls.append(btn('suspend',()=>change('suspended')));
    controls.append(btn('revoke',()=>{const confirmBody=dialog(a.username);confirmBody.append(element('p',t('irreversible')),btn('confirm',()=>change('revoked'),'warn'),btn('cancel',()=>$('details').close()));},'warn'));
  }
  if(a.status==='approved')controls.append(btn('sessions',async()=>{await api('admin/accounts/'+a.id+'/revoke-sessions','POST');$('details').close();await refresh();}));
  try{const info=await api('admin/usage?accountId='+encodeURIComponent(a.id));if(view!==detailVersion||!$('details').open)return;
    body.append(element('h3',t('quota')),element('p',t('outgoing')+' · '+(info.usage?traffic(info.usage.egressBytes):'—')),element('p',usageStamp(info)+' · '+t('active')+' '+info.activeGrants,'fine'));
    if(a.status!=='revoked')quotaForm(body,info,a.id,a.status==='pending');
  }catch(e){if(view===detailVersion)notice(labels[e.message]?e.message:'failed',true);}
}
$('login-form').onsubmit=e=>{e.preventDefault();if(busy)return;busy=true;const form=e.currentTarget,pw=form.elements.password;const data={username:form.elements.username.value.trim(),password:pw.value};pw.value='';
  void action(form.querySelector('button'),async()=>{const auth=await api('auth/login','POST',data);token=auth.token;
    if(auth.account?.role!=='admin'||auth.account?.status!=='approved'){try{await api('auth/logout','POST');}finally{clear();}throw new Error('denied');}
    $('signin').hidden=true;$('workspace').hidden=false;$('logout').hidden=false;await refresh();
  }).finally(()=>{busy=false;});};
$('logout').onclick=()=>action($('logout'),async()=>{try{await api('auth/logout','POST');}finally{clear();}});
$('refresh').onclick=()=>action($('refresh'),()=>refresh());$('more').onclick=()=>action($('more'),()=>refresh(true));$('filter').onchange=()=>{cursor=null;accounts=[];render();void refresh().catch(e=>notice(labels[e.message]?e.message:'failed'));};
$('edit-global').onclick=()=>action($('edit-global'),async()=>{const info=await api('admin/usage');quotaForm(dialog(t('quotaSettings')),info,'global');});
$('invite').onclick=()=>action($('invite'),async()=>{const r=await api('admin/invites','POST');const body=dialog(t('invite')),box=element('input');box.readOnly=true;box.value=r.invite;box.setAttribute('aria-label',t('invite'));body.append(box,element('p',t('expires')+' '+new Date(r.expiresAt*1000).toLocaleString(locale)+' · '+t('singleUse'),'fine'),btn('copy',async()=>{await navigator.clipboard.writeText(box.value);notice('copied',true);}));});
$('details').addEventListener('close',()=>{detailVersion++;$('dialog-body').replaceChildren();notice('',true);});
$('lang').onchange=()=>{locale=$('lang').value;localStorage.setItem('cc.admin.language',locale);$('details').close();localize();};
localize();
