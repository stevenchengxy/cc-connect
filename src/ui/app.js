'use strict';

const api = window.jianping;
const i18n = window.ccI18n;
const { t, translate } = i18n;
let localeInitialized = false;
let updateState = { phase: 'idle' };
const $ = (id) => document.getElementById(id);
const profiles = {
  smooth:   { width:1280, height:720, fps:30, bitrate:4_000_000, label:'最高 720p · 30 帧/秒' },
  balanced: { width:1920, height:1080, fps:60, bitrate:12_000_000, label:'最高 1080p · 60 帧/秒' },
  detail:   { width:2560, height:1440, fps:60, bitrate:22_000_000, label:'最高 1440p · 60 帧/秒' },
};
let info = {};
let account = {status:'signedOut'};
let registering = false;
let accountBusy = false;
let mode = 'viewer';
let phase = 'idle';
let generation = 0;
let room = null;
let peerName = '';
let pendingRequest = null;
let legacyInvite = '';
let settingsCheck = null;
let expiryTimer;
let joinTimer;
let quality = 'balanced';
try {
  const saved = localStorage.getItem('jianping-quality');
  if (Object.hasOwn(profiles, saved)) quality = saved;
} catch { /* Quality preferences are optional. */ }

function notice(id, message = '', error = false) {
  const box = $(id);
  box.textContent = translate(message);
  box.classList.toggle('error', error);
  box.hidden = !message;
}
function describeError(error) {
  return translate(String(error?.message || error || '连接失败，请重试。')
    .replace(/^Error invoking remote method '[^']+': (?:Error: )?/, ''));
}
const screenErrors = {
  'preflight-denied':'macOS 录屏预检未通过。请核对当前应用的录屏设置。',
  'permission-denied':'系统未允许本次录屏请求。请检查当前应用的录屏设置。',
  'permission-pending':'macOS 尚未确认录屏权限。请点「重新读取」或检查录屏设置。',
  'preflight-unconfirmed':'录屏预检未确认，系统也未列出屏幕。请解锁本机、唤醒显示器，再试一次。',
  'permission-restricted':'系统策略限制了录屏，请联系设备管理员。',
  'source-unavailable':'系统暂时无法列出屏幕。请解锁共享端并确认显示器已唤醒，然后重新读取。',
  'no-displays':'系统没有找到可共享的显示器。请接入或唤醒显示器，然后重新读取。'
};
function screenErrorMessage(code, permission) {
  if (info.canUseNativeScreenPicker && ['preflight-denied','permission-pending','preflight-unconfirmed'].includes(code)) {
    return t(code === 'preflight-unconfirmed' ? '录屏预检未确认，系统也未列出屏幕。可以用系统选择屏幕，实际验证能否取得画面。' :
      'macOS 预检尚未确认录屏权限。可以用系统选择屏幕，或检查当前应用的录屏设置。');
  }
  if (code === 'source-unavailable' && permission === 'granted') {
    return t('录屏权限已开启，但系统暂时无法列出屏幕。请解锁本机、唤醒显示器后重新读取。');
  }
  return t(screenErrors[code] || screenErrors['source-unavailable']);
}
function needsRecordingSettings(code) {
  return info.platform === 'darwin' && ['permission-denied','preflight-denied','permission-pending','preflight-unconfirmed'].includes(code);
}
function label(id, key) {
  $(id).dataset.i18n = key;
  $(id).textContent = t(key);
}
// Resize only when the label, locale or session controls change, never on animation frames.
const islandSizes = new ResizeObserver(entries => {
  for (const entry of entries) {
    const width = entry.borderBoxSize[0].inlineSize;
    if (entry.target === $('island-toggle')) {
      $('status-island').style.setProperty('--island-trigger-width', width + 'px');
    } else if (width > 0) {
      document.documentElement.style.setProperty('--session-actions-width', width + 'px');
    }
  }
});
islandSizes.observe($('island-toggle'));
islandSizes.observe(document.querySelector('.session-actions'));
function renderIslandDetails() {
  const platform = {darwin:'macOS', win32:'Windows', linux:'Linux'}[info.platform] || info.platform || '—';
  $('island-device-label').textContent = t(peerName ? '远端设备' : '本机设备');
  $('island-device').textContent = peerName || info.name || '—';
  $('island-device').title = $('island-device').textContent;
  $('island-context-label').textContent = t(room ? '共享权限' : peerName ? '本机设备' : '操作系统');
  $('island-context').textContent = room ? t(room.filesOnly ? '仅传文件' : room.allowControl ? '允许键鼠控制' : '仅观看') : peerName ? info.name || '—' : platform;
}
function expandIsland(expand) {
  $('island-toggle').setAttribute('aria-expanded', String(expand));
  $('status-island').classList.toggle('expanded', expand);
  $('island-details').inert = !expand;
  $('island-details').setAttribute('aria-hidden', String(!expand));
}
$('island-toggle').onclick = () => expandIsland($('island-toggle').getAttribute('aria-expanded') !== 'true');
for (const type of ['pointerdown', 'focusin']) document.addEventListener(type, event => {
  if (!$('status-island').contains(event.target)) expandIsland(false);
});
document.addEventListener('keydown', event => {
  if (event.key === 'Escape' && $('status-island').classList.contains('expanded')) {
    event.preventDefault();
    expandIsland(false);
    $('island-toggle').focus();
  }
});
function setStatus(text, state = '') {
  renderIslandDetails();
  $('top-status').dataset.i18n = text;
  $('top-status').textContent = translate(text);
  $('top-dot').className = 'state-dot' + (state ? ' ' + state : '');
}
function setMode(next) {
  mode = next;
  $('view-tab').setAttribute('aria-selected', String(mode === 'viewer'));
  $('host-tab').setAttribute('aria-selected', String(mode === 'host'));
  $('view-panel').hidden = mode !== 'viewer';
  $('host-panel').hidden = mode !== 'host';
}
function renderAccount() {
  const approved = account.status === 'approved';
  const login = account.status === 'signedOut';
  $('account-panel').hidden = approved;
  $('pairing-home').hidden = !approved;
  $('admin-button').hidden = !(approved && account.role === 'admin');
  $('settings-identity').textContent = account.username || t('未登录');
  $('account-logout').hidden = login;
  $('account-logout').title = [account.username, t('退出账号')].filter(Boolean).join(' · ');
  $('account-form').hidden = !login;
  $('account-wait').hidden = login || approved;
  $('account-title').textContent = t(login ? (registering ? '注册账号' : '登录账号')
    : account.status === 'pending' ? '等待管理员批准。' : account.status === 'suspended' ? '账号已停用，请联系管理员。' : '账号暂不可用');
  $('account-identity').textContent = account.username || '';
  $('register-invite-wrap').hidden = !registering;
  $('registration-help').hidden = !registering;
  $('register-invite').required = registering;
  $('account-password').autocomplete = registering ? 'new-password' : 'current-password';
  $('account-password').minLength = registering ? 12 : 1;
  $('account-submit').textContent = t(registering ? '注册' : '登录');
  $('account-switch').textContent = t(registering ? '返回登录' : '使用邀请码注册');
  for (const id of ['account-submit','account-switch','account-refresh']) $(id).disabled = accountBusy;
  if (account.message) notice('account-notice',account.message,true);
}

function setAccount(next) {
  if (!next || (next.revision || 0) < (account.revision || 0)) return;
  const previous = account.status;
  account = next;
  if (account.status !== 'approved') {
    info.iceServers = [];
    $('invite-input').value = '';
    $('advanced-settings').open = false;
    $('turn-password').value = '';
    if (phase !== 'idle') backHome('账号授权已结束。', true);
  } else if (previous !== 'approved') {
    Promise.resolve(api.info()).then(updateInfo).catch(() => {});
  }
  if (previous !== next.status) notice('account-notice');
  renderAccount();
  syncHome();
}
async function accountAction(action) {
  if (accountBusy) return;
  accountBusy = true;
  notice('account-notice');
  renderAccount();
  try { setAccount(await action()); }
  catch (error) { notice('account-notice', describeError(error), true); }
  finally { accountBusy = false; renderAccount(); }
}
$('account-switch').onclick = () => {
  registering = !registering;
  $('account-password').value = '';
  $('register-invite').value = '';
  notice('account-notice'); renderAccount();
};
$('account-form').onsubmit = event => {
  event.preventDefault();
  void accountAction(async () => {
    const values = {username:$('account-username').value.trim(), password:$('account-password').value};
    if (registering) {
      await api.register({...values, invite:$('register-invite').value.trim()});
      registering = false;
      $('register-invite').value = '';
    }
    $('account-password').value = '';
    return api.login(values);
  });
};
$('account-refresh').onclick = () => void accountAction(() => api.refreshAccount());
$('account-logout').onclick = () => void accountAction(async () => {
  $('account-password').value = ''; $('register-invite').value = '';
  registering = false;
  const next = await api.logout();
  if ($('settings-dialog').open) closeSettings();
  return next;
});

$('admin-button').onclick = async () => {
  if (account.status !== 'approved' || account.role !== 'admin') return;
  $('admin-button').disabled = true;
  try { await api.openAdminConsole(); }
  catch (error) { notice(phase === 'session' ? 'session-notice' : 'home-notice', describeError(error), true); }
  finally { $('admin-button').disabled = false; }
};

function syncHome() {
  const idle = phase === 'idle';
  const canPair = idle && account.status === 'approved';
  const inviting = phase === 'listening' || phase === 'request';
  $('view-tab').disabled = !idle && mode !== 'viewer';
  $('host-tab').disabled = !idle && mode !== 'host';
  $('invite-input').disabled = !canPair;
  $('join-button').disabled = !canPair;
  $('join-files').disabled = !canPair;
  $('host-button').disabled = !canPair;
  $('host-button').hidden = inviting;
  $('invite-box').hidden = phase !== 'listening';
  $('copy-legacy').hidden = phase !== 'listening' || !legacyInvite;
  $('cancel-host').hidden = phase !== 'listening';
  $('waiting').hidden = phase !== 'joining';
  $('settings-button').disabled = phase === 'request';
  $('settings-end').hidden = phase !== 'session';
  $('advanced-settings').hidden = !canPair;
  $('update-button').disabled = !idle;
}
function updateInfo(data) {
  info = data;
  setAccount(data.account);
  if (info.update?.phase) updateState = info.update;
  if (!localeInitialized) {
    i18n.initialize(info.language);
    localeInitialized = true;
    refreshLanguage();
  }
  renderUpdate();
  renderIslandDetails();
  $('settings-version').textContent = info.version || '';
  document.documentElement.dataset.platform = info.platform;
  $('device-name').textContent = info.name || t('本机');
  const names = { darwin:'macOS', win32:'Windows', linux:'Linux' };
  $('device-platform').textContent = names[info.platform] || info.platform || t('本机设备');
}
function send(channel, value) {
  if (!channel || channel.readyState !== 'open') return false;
  try { channel.send(JSON.stringify(value)); return true; }
  catch { return false; }
}
function isCurrent(value) { return room === value && value !== null; }
function cleanRoom() {
  const previous = room;
  room = null;
  if (!previous) return;
  previous.files.close();
  previous.nativeCapture?.video.close();
  $('file-tools').hidden = true;
  cancelMove(); heldButtons.clear();
  clearInterval(previous.statsTimer);
  clearTimeout(previous.connectTimer);
  clearTimeout(previous.lossTimer);
  clearTimeout(previous.grantTimer);
  if (previous.role === 'viewer') send(previous.channel, {kind:'reset'});
  previous.stream?.getTracks().forEach(track => track.stop());
  previous.pc.onconnectionstatechange = null;
  previous.pc.onicecandidate = null;
  previous.channel?.close();
  previous.pc.close();
  $('remote-video').srcObject = null;
}
function backHome(message, error = false) {
  generation++;
  pendingRequest = null;
  clearInterval(expiryTimer);
  clearTimeout(joinTimer);
  cleanRoom();
  if ($('consent').open) $('consent').close();
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  phase = 'idle';
  peerName = '';
  legacyInvite = '';
  $('host-invite').value = '';
  $('host-help').hidden = true;
  $('session').hidden = true;
  $('home').hidden = false;
  $('resume-capture').hidden = true;
  $('session-screen-settings').hidden = true;
  $('video-wait').hidden = false;
  notice('session-notice');
  notice('home-notice', message, error);
  setStatus('待连接');
  syncHome();
}
async function disconnect(message = '连接已结束。', error = false) {
  if (phase === 'closing') return;
  const token = generation;
  phase = 'closing';
  cleanRoom();
  syncHome();
  try { await api.disconnect(); }
  catch (e) { message += ' ' + describeError(e); error = true; }
  if (generation === token) backHome(message, error);
  else if (phase === 'idle') notice('home-notice', message, error);
}
function terminate(value, message) {
  if (isCurrent(value)) void disconnect(message, true);
}

for (const [id, next] of [['view-tab','viewer'],['host-tab','host']]) {
  $(id).onclick = () => { if (phase === 'idle') { setMode(next); notice('home-notice'); } };
  $(id).onkeydown = (e) => {
    if (phase !== 'idle' || !['ArrowLeft','ArrowRight'].includes(e.key)) return;
    e.preventDefault();
    const other = $(next === 'viewer' ? 'host-tab' : 'view-tab');
    other.click(); other.focus();
  };
}
$('join-form').onsubmit = async (event) => {
  event.preventDefault();
  const invite = $('invite-input').value.trim();
  if (phase !== 'idle' || account.status !== 'approved' || !invite) return;
  const token = ++generation;
  phase = 'joining';
  setStatus('正在配对', 'pending');
  syncHome(); notice('home-notice');
  joinTimer = setTimeout(() => {
    if (generation === token && phase === 'joining') void disconnect('等待时间已到，请确认对方仍在等待配对。', true);
  }, 120_000);
  try {
    await api.join(invite,event.submitter?.id === 'join-files' ? 'files' : 'screen');
    // Registration has claimed this one-use invitation, even if the host
    // later declines or the connection closes without a video frame.
    if (generation === token && $('invite-input').value.trim() === invite) $('invite-input').value = '';
  }
  catch (e) { if (generation === token) await disconnect(describeError(e), true); }
};
$('host-button').onclick = async () => {
  if (phase !== 'idle' || account.status !== 'approved') return;
  const token = ++generation;
  phase = 'opening';
  syncHome(); notice('home-notice'); setStatus('正在创建邀请', 'pending');
  try {
    const { invite, legacyInvite: compatibilityCode, expiresAt, internetAvailable, internetIssue } = await api.host();
    if (generation !== token) return;
    if (phase === 'opening') phase = 'listening';
    if (phase !== 'listening') return;
    legacyInvite = compatibilityCode || '';
    $('host-invite').value = invite;
    if (internetIssue) notice('home-notice', internetIssue, true);
    const expires = new Date(expiresAt).getTime();
    function showLifetime() {
      $('host-help').hidden = false;
      if (!Number.isFinite(expires)) {
        $('host-help').textContent = t('请只发给受邀人。');
        return;
      }
      const seconds = Math.ceil((expires - Date.now()) / 1000);
      if (seconds <= 0) {
        clearInterval(expiryTimer);
        // The pairing process owns expiry. Its consent event may already be
        // in flight when this display-only countdown reaches zero.
        $('host-help').textContent = t('配对码已过期。请生成新的配对码。');
      } else {
        const lifetime = t('剩余 {time} 有效', {time: Math.floor(seconds / 60) + ':' + String(seconds % 60).padStart(2, '0')});
        $('host-help').textContent = internetAvailable === false
          ? t('公网配对暂不可用。此码仅限局域网或 VPN。') + ' ' + lifetime
          : lifetime;
      }
    }
    showLifetime();
    expiryTimer = setInterval(showLifetime, 1000);
    syncHome();
    if (phase === 'listening') setStatus('等待配对', 'pending');
  } catch (e) {
    if (generation === token) await disconnect(describeError(e), true);
  }
};
$('cancel-join').onclick = () => disconnect('已取消配对。');
$('cancel-host').onclick = () => disconnect('邀请已取消。');
$('end-session').onclick = () => disconnect('连接已结束。');
async function copyInvite(value) {
  if (phase !== 'listening' || !value) return;
  try { await api.copy(value); if (phase === 'listening') notice('home-notice', '配对码已复制。'); }
  catch (e) { notice('home-notice', describeError(e), true); }
}
$('copy-button').onclick = () => copyInvite($('host-invite').value);
$('copy-legacy').onclick = () => copyInvite(legacyInvite);
$('host-invite').onclick = (e) => e.target.select();

$('settings-end').onclick = () => { closeSettings(); void disconnect(); };
$('settings-button').onclick = () => {
  if (phase === 'request') return;
  expandIsland(false);
  $('advanced-settings').open = false;
  $('turn-url').value = info.turnUrl || '';
  $('turn-user').value = info.turnUsername || '';
  $('turn-password').value = '';
  $('turn-password').placeholder = info.turnConfigured ? t('已保存') : '';
  notice('settings-notice');
  settingsCheck = null;
  renderScreenCheck();
  $('settings-dialog').showModal();
};
function closeSettings() { $('turn-password').value = ''; $('settings-dialog').close(); }
$('close-settings').onclick = closeSettings;
$('cancel-settings').onclick = closeSettings;
$('settings-dialog').onclose = () => {
  $('turn-password').value = '';
  if (settingsCheck?.nativeTest && settingsCheck.pending) void api.cancelNativeDisplayTest().catch(() => {});
  settingsCheck = null;
};
function renderScreenCheck() {
  const check = settingsCheck;
  $('screen-check').disabled = !!check?.pending;
  $('settings-native-display').hidden = phase !== 'idle' || !info.canUseNativeScreenPicker ||
    check?.errorCode === 'permission-restricted';
  $('settings-native-display').disabled = !!check?.pending;
  label('screen-check', check && !check.pending ? '重新读取' : '检测屏幕');
  $('settings-screen-settings').hidden = !needsRecordingSettings(check?.errorCode);
  const inputMessages = {
    granted:'键鼠控制已获辅助功能授权。',
    denied:'键鼠控制需要辅助功能授权。如果 macOS 要求管理员确认，请联系这台 Mac 的管理员。',
    unknown:'无法检查键鼠组件，请确认已完整安装 CC Connect。'
  };
  const inputMessage = inputMessages[check?.inputPermission];
  $('input-check-result').textContent = inputMessage ? t(inputMessage) : '';
  $('input-check-result').hidden = !inputMessage;
  $('settings-input-settings').hidden = check?.inputPermission !== 'denied';
  const showPath = check?.appPath && (needsRecordingSettings(check?.errorCode) || check?.inputPermission === 'denied');
  $('checked-app-path').hidden = !showPath;
  $('checked-app-path').textContent = showPath ? t('当前运行的应用：{path}', {path:check.appPath}) : '';
  if (!check) return notice('screen-check-result');
  if (check.pending) return notice('screen-check-result', check.nativeTest ? '请在 macOS 中选一块屏幕以验证画面。' : '正在读取屏幕…');
  if (check.nativeResult) {
    if (check.nativeResult.width) return notice('screen-check-result',
      t('已取得 {width} × {height} 画面。本地检测已结束。',check.nativeResult));
    return notice('screen-check-result',check.nativeResult.message,check.nativeResult.error);
  }
  if (check.errorCode) return notice('screen-check-result', screenErrorMessage(check.errorCode,check.permission), true);
  const message = info.canUseNativeScreenPicker ? '已列出 {count} 块屏幕。点「用系统选择屏幕」可验证画面。' : ['denied','not-determined'].includes(check.permission)
    ? '已列出 {count} 块屏幕。请在共享请求中点「重新读取」，选屏后由 macOS 确认本次共享。'
    : '可共享的屏幕数量：{count}。';
  notice('screen-check-result', t(message, {count:check.screenCount}));
}
$('screen-check').onclick = async () => {
  if (settingsCheck?.pending) return;
  const check = settingsCheck = {pending:true};
  renderScreenCheck();
  try {
    const result = await api.screenStatus();
    if (settingsCheck !== check || !$('settings-dialog').open) return;
    settingsCheck = result;
  } catch {
    if (settingsCheck !== check || !$('settings-dialog').open) return;
    settingsCheck = {errorCode:'source-unavailable'};
  }
  renderScreenCheck();
};
$('settings-native-display').onclick = async () => {
  if (phase !== 'idle' || settingsCheck?.pending || $('settings-native-display').hidden) return;
  const check = settingsCheck = {...settingsCheck,pending:true,nativeTest:true,nativeResult:null};
  renderScreenCheck();
  try {
    const {width,height} = await api.testNativeDisplay();
    if (settingsCheck !== check || !$('settings-dialog').open) return;
    check.nativeResult = {width,height};
    check.errorCode = null;
  } catch (e) {
    if (settingsCheck !== check || !$('settings-dialog').open) return;
    const code = describeError(e);
    if (['permission-denied','permission-restricted'].includes(code)) check.errorCode = code;
    check.nativeResult = {message:nativePickerError(code),error:code !== 'native-picker-cancelled'};
  } finally {
    if (settingsCheck === check) {
      check.pending = false;
      renderScreenCheck();
    }
  }
};
function nativePickerError(code) {
  if (code === 'native-picker-cancelled') return '已取消选择屏幕。';
  if (code === 'native-picker-unsupported') return '本机当前无法使用系统选屏。请检查 macOS 版本和 CC Connect 的安装。';
  if (code === 'permission-restricted') return screenErrorMessage(code);
  if (code === 'permission-denied') return '系统未允许本次选屏。请检查当前应用的录屏设置。';
  return '系统未能取得所选屏幕的画面。请解锁本机、唤醒显示器后重试。';
}
async function openRecordingSettings(noticeId) {
  try { await api.openScreenSettings(); }
  catch (e) { notice(noticeId,describeError(e),true); }
}
$('settings-screen-settings').onclick = () => openRecordingSettings('screen-check-result');
$('consent-screen-settings').onclick = () => openRecordingSettings('consent-notice');
$('session-screen-settings').onclick = () => openRecordingSettings('session-notice');
async function openInputSettings(noticeId) {
  try { await api.openInputSettings(); }
  catch { notice(noticeId,'无法打开辅助功能设置。',true); }
}
$('settings-input-settings').onclick = () => openInputSettings('screen-check-result');
$('consent-input-settings').onclick = () => openInputSettings('consent-notice');
$('settings-form').onsubmit = async (event) => {
  event.preventDefault();
  if (phase !== 'idle' || account.status !== 'approved' || !$('advanced-settings').open) return;
  $('save-settings').disabled = true;
  try {
    await api.settings({
      turnUrl:$('turn-url').value.trim(),
      turnUsername:$('turn-user').value.trim(), turnPassword:$('turn-password').value
    });
    updateInfo(await api.info());
    closeSettings(); notice('home-notice', '连接设置已保存。');
  } catch (e) { notice('settings-notice', describeError(e), true); }
  finally { $('save-settings').disabled = false; }
};

function currentRequest(request) {
  return request && request === pendingRequest && !request.declining && request.generation === generation && phase === 'request';
}
function showSourceFailure(code) {
  $('screens').replaceChildren(new Option(t('暂无可选屏幕'),''));
  $('screens').disabled = true;
  $('consent-input-settings').hidden = true;
  const nativePicker = info.canUseNativeScreenPicker && Object.hasOwn(screenErrors,code) && code !== 'permission-restricted';
  $('allow-control').disabled = !nativePicker || !info.inputSupported;
  if ($('allow-control').disabled) $('allow-control').checked = false;
  $('accept').disabled = true;
  $('screen-recovery').hidden = false;
  $('consent-screen-settings').hidden = !needsRecordingSettings(code);
  const offerPicker = nativePicker || (!!info.canUseSystemPicker && Object.hasOwn(screenErrors,code) && code !== 'permission-restricted');
  $('use-system-picker').hidden = !offerPicker;
  $('use-system-picker').className = 'primary';
  label('use-system-picker',nativePicker ? '用系统选择屏幕' : '选择画面 · 仅观看');
  $('accept').hidden = offerPicker;
  notice('consent-notice',screenErrorMessage(code),true);
}
async function readConsentScreens(retry = false) {
  const request = pendingRequest;
  if (!currentRequest(request) || request.busy || request.requestedFiles || request.approving) return;
  request.busy = true;
  $('retry-screens').disabled = true;
  $('screens').disabled = true;
  $('screens').replaceChildren(new Option(t('正在读取屏幕…'),''));
  $('accept').disabled = true;
  $('accept').hidden = false;
  $('use-system-picker').hidden = true;
  $('allow-control').disabled = true;
  notice('consent-notice');
  try {
    const screens = await api.screens(request.id,retry);
    if (!currentRequest(request) || request.approving) return;
    if (!screens.length) { showSourceFailure('no-displays'); return; }
    $('screens').replaceChildren(...screens.map((screen, index) =>
      new Option(screen.name ? translate(screen.name) : t('屏幕 {number}', {number:index + 1}), screen.id, false, !!screen.primary)));
    $('screens').disabled = false;
    $('screen-recovery').hidden = true;
    $('allow-control').disabled = !info.inputSupported;
    $('accept').disabled = false;
    if (info.canUseNativeScreenPicker) {
      $('use-system-picker').hidden = false;
      $('use-system-picker').className = 'secondary';
      label('use-system-picker','用系统选择屏幕');
    }
  } catch (e) {
    if (currentRequest(request) && !request.approving) showSourceFailure(describeError(e));
  } finally {
    if (currentRequest(request)) {
      request.busy = false;
      $('retry-screens').disabled = false;
    }
  }
}
async function requestConsent(event) {
  if (!['listening','opening'].includes(phase)) return;
  expandIsland(false);
  if ($('settings-dialog').open) closeSettings();
  clearInterval(expiryTimer);
  legacyInvite = '';
  $('host-invite').value = '';
  $('host-help').hidden = true;
  phase = 'request'; syncHome();
  const requestedFiles = event.requestedFiles === true;
  pendingRequest = {id:event.requestId, generation, busy:false, requestedFiles, fileSessions:event.fileSessions === true};
  peerName = event.name || t('远端设备');
  setStatus('收到连接请求', 'pending');
  $('consent-title').textContent = t(requestedFiles ? '允许与「{name}」传输文件？' : '允许「{name}」查看屏幕？', {name:peerName});
  $('consent-screen-options').hidden = requestedFiles;
  $('accept-files').hidden = !pendingRequest.fileSessions;
  $('accept-files').disabled = false;
  $('accept-files').className = requestedFiles ? 'primary' : 'secondary';
  $('accept').hidden = requestedFiles;
  $('screens').disabled = requestedFiles;
  $('use-system-picker').hidden = true;
  notice('consent-notice');
  $('allow-control').checked = false;
  $('consent-input-settings').hidden = true;
  let controlNote = '';
  if (!info.inputSupported) controlNote = '本机仅支持观看。';
  else if (info.canUseNativeScreenPicker) controlNote = '键鼠控制需要 macOS 辅助功能授权。只共享画面时可不勾选。';
  else if (info.platform === 'darwin') controlNote = '录屏权限用于共享画面。允许键鼠控制还需要 macOS 的「辅助功能」权限。';
  $('control-note').textContent = t(controlNote);
  $('control-note').hidden = !controlNote;
  $('screen-recovery').hidden = true;
  $('consent-screen-settings').hidden = true;
  $('use-system-picker').disabled = false;
  $('reject').disabled = false;
  $('consent').showModal();
  if (!requestedFiles) await readConsentScreens();
}
$('retry-screens').onclick = () => readConsentScreens(true);
async function acceptScreen(usePicker) {
  const request = pendingRequest;
  if (!currentRequest(request) || request.busy || request.approving || request.requestedFiles) return;
  if (usePicker ? $('use-system-picker').hidden : !$('screens').value || $('accept').disabled) return;
  request.busy = true;
  request.approving = true;
  $('accept-files').disabled = true;
  $('use-system-picker').disabled = true;
  $('retry-screens').disabled = true;
  $('accept').disabled = true;
  $('reject').disabled = true;
  try {
    const source = usePicker ? (info.canUseNativeScreenPicker ? 'native-display' : 'system-picker') : $('screens').value;
    await api.accept(source !== 'system-picker' && $('allow-control').checked,source,request.id);
  } catch (e) {
    if (!currentRequest(request)) return;
    const message = describeError(e);
    if (Object.hasOwn(screenErrors,message)) showSourceFailure(message);
    else {
      const needsInputAccess = message === 'control-permission';
      notice('consent-notice',needsInputAccess ? '键鼠控制尚未获准。开启辅助功能后重试，或取消勾选键鼠控制以仅共享画面。' : message,true);
      $('consent-input-settings').hidden = !needsInputAccess;
      $('screen-recovery').hidden = needsInputAccess;
      $('accept').disabled = !$('screens').value;
    }
    $('reject').disabled = false;
    $('use-system-picker').disabled = false;
    $('retry-screens').disabled = false;
    request.busy = false;
    request.approving = false;
    $('accept-files').disabled = false;
  }
}
$('consent-form').onsubmit = (event) => {
  event.preventDefault();
  void acceptScreen(false);
};
$('use-system-picker').onclick = () => acceptScreen(true);
$('accept-files').onclick = async () => {
  const request = pendingRequest;
  if (!currentRequest(request) || !request.fileSessions || request.approving) return;
  request.approving = true;
  $('accept-files').disabled = true;
  $('reject').disabled = true;
  try {
    await api.accept(false,'files',request.id);
  } catch (e) {
    if (!currentRequest(request)) return;
    request.approving = false;
    $('accept-files').disabled = false;
    $('reject').disabled = false;
    notice('consent-notice',describeError(e),true);
  }
};
async function rejectRequest() {
  if (!currentRequest(pendingRequest) || $('reject').disabled) return;
  pendingRequest.declining = true;
  $('reject').disabled = true;
  const token = generation;
  try { await api.reject(pendingRequest.id); }
  catch (e) { if (token === generation) await disconnect(describeError(e), true); return; }
  if (token === generation) backHome('已拒绝连接请求。');
}
$('consent').oncancel = (event) => { event.preventDefault(); void rejectRequest(); };
$('reject').onclick = rejectRequest;

function showPermission(value) {
  if (!isCurrent(value)) return;
  const modeText = value.filesOnly ? '仅传文件' : value.allowControl
    ? (value.role === 'host' ? '允许键鼠控制' : '可控制 · Shift + Esc 释放键鼠')
    : '仅观看';
  $('permission-state').textContent = translate(modeText);
  renderIslandDetails();
}
function sharePermission(value) {
  if (value.role === 'host') send(value.channel, {kind:'permission',allowControl:value.allowControl});
  showPermission(value);
}
function controlUnavailable(value, message) {
  if (!isCurrent(value) || value.role !== 'host') return;
  value.allowControl = false;
  sharePermission(value);
  notice('session-notice', message || '键鼠控制暂时不可用，已切换为仅观看。', true);
}
function setQuality(id) {
  if (!Object.hasOwn(profiles,id)) return;
  quality = id;
  $('quality-select').value = id;
  $('live-quality').value = id;
  window.ccSelects?.refresh();
  $('quality-detail').textContent = translate(profiles[id].label);
  try { localStorage.setItem('jianping-quality',id); } catch {}
  if (room?.role === 'viewer') send(room.channel,{kind:'quality',profile:id});
}
$('quality-select').onchange = (event) => setQuality(event.target.value);
$('live-quality').onchange = (event) => setQuality(event.target.value);
async function applyQuality(value) {
  const track = value.sender?.track;
  if (!track || !isCurrent(value) || !value.pc.currentRemoteDescription) return;
  const preset = profiles[value.profile];
  track.contentHint = value.profile === 'smooth' ? 'motion' : 'detail';
  const {width,height} = track.getSettings();
  const portrait = height > width;
  const scale = Math.max(1,(width || 1) / (portrait ? preset.height : preset.width),
    (height || 1) / (portrait ? preset.width : preset.height));
  const params = value.sender.getParameters();
  if (!params.encodings?.length) return;
  params.degradationPreference = value.profile === 'detail' ? 'maintain-resolution'
    : value.profile === 'smooth' ? 'maintain-framerate' : 'balanced';
  Object.assign(params.encodings[0], {
    maxBitrate:preset.bitrate, maxFramerate:preset.fps, scaleResolutionDownBy:scale
  });
  await value.sender.setParameters(params);
}
async function scheduleQuality(value, profile) {
  if (!Object.hasOwn(profiles,profile)) return;
  value.profile = profile;
  if (value.adjusting) return;
  value.adjusting = true;
  try {
    let last;
    do {
      last = value.profile;
      await applyQuality(value);
    } while (isCurrent(value) && value.profile !== last);
  } catch {
    if (isCurrent(value)) notice('session-notice','当前编码器未接受画质限制，将按网络状况发送。');
  } finally { value.adjusting = false; }
}
function renderFiles(files) {
  if (!room || room.files !== files) return;
  const file = files.active;
  const result = files.result;
  const hasProgress = file && ['sending','receiving','confirming','committing'].includes(file.phase);
  const progress = file?.size ? Math.floor(100 * (file.direction === 'send' ? file.confirmed : file.offset) / file.size) : 100;
  if (hasProgress) {
    // Disk acknowledgements can arrive much faster than a visible percentage changes.
    const displayState = [file.phase,progress,i18n.getLanguage()].join('/');
    if (file.displayState === displayState) return;
    file.displayState = displayState;
  }
  $('file-tools').hidden = !files.ready && !result;
  $('file-send').hidden = !files.ready || !!file;
  $('file-transfer').hidden = !file && !result;
  $('file-transfer').dataset.phase = file?.phase || (result ? 'done' : '');
  $('file-name').textContent = file?.name || result?.name || '';
  $('file-name').title = $('file-name').textContent;
  $('file-save').hidden = file?.phase !== 'incoming';
  $('file-cancel').hidden = !file || ['picking','saving','confirming','committing'].includes(file.phase);
  $('file-cancel').textContent = t(file?.phase === 'incoming' ? '拒绝' : '取消');
  $('file-progress').hidden = !hasProgress;
  if (!file) {
    $('file-status').textContent = result ? t(result.message) : '';
    return;
  }
  const statuses = {
    picking:'选择要发送的文件…', offered:'等待对方接收', incoming:'对方想发送文件',
    saving:'选择保存位置…', sending:'正在发送', receiving:'正在接收', confirming:'等待对方校验', committing:'正在校验'
  };
  const formattedSize = Intl.NumberFormat(i18n.getLanguage(), {maximumFractionDigits:1});
  const size = file.size === undefined ? '' : file.size < 1024 ? file.size + ' B' :
    file.size < 1024 ** 2 ? formattedSize.format(file.size / 1024) + ' KiB' : formattedSize.format(file.size / 1024 ** 2) + ' MiB';
  if (hasProgress) $('file-progress').value = progress;
  $('file-status').textContent = [t(statuses[file.phase]),size,hasProgress ? progress + '%' : ''].filter(Boolean).join(' · ');
}
$('file-send').onclick = () => room?.files.choose();
$('file-save').onclick = () => room?.files.accept();
$('file-cancel').onclick = () => room?.files.cancel();

function attachChannel(value, channel) {
  if (value.channel || channel.label !== 'jianping-control-v1') { channel.close(); return; }
  value.channel = channel;
  channel.onopen = () => {
    if (!isCurrent(value)) return;
    send(channel, {kind:'file-capability',version:1});
    if (value.role === 'host') sharePermission(value);
    else send(channel, {kind:'quality',profile:quality});
  };
  channel.onmessage = (event) => {
    if (!isCurrent(value) || typeof event.data !== 'string' || event.data.length > 2048) return;
    let payload;
    try { payload = JSON.parse(event.data); } catch { return; }
    if (!payload || typeof payload !== 'object') return;
    if (payload.kind === 'file-capability' && payload.version === 1) {
      if (value.role === 'host' && !value.files.channel && !value.files.closed) {
        try { value.files.attach(value.pc.createDataChannel(window.CCFileChannel.label,{ordered:true,priority:'low'})); }
        catch { value.files.close(); }
      }
      return;
    }
    if (value.role === 'viewer') {
      if (payload.kind === 'permission') { value.allowControl = payload.allowControl === true; showPermission(value); }
      return;
    }
    if (payload.kind === 'quality') { scheduleQuality(value,payload.profile); return; }
    if (!value.allowControl || !['move','button','wheel','key','reset'].includes(payload.kind)) return;
    Promise.resolve(api.input(value.requestId,payload)).catch(() => controlUnavailable(value));
  };
  channel.onclose = () => {
    if (!isCurrent(value)) return;
    if (value.role === 'host' && value.allowControl) Promise.resolve(api.input(value.requestId,{kind:'reset'})).catch(() => {});
    terminate(value,'控制通道已关闭，会话已结束。');
  };
}
async function readStats(value) {
  if (!isCurrent(value) || value.pc.connectionState !== 'connected' || value.readingStats) return;
  value.readingStats = true;
  try {
    const report = await value.pc.getStats();
    if (!isCurrent(value)) return;
    let video,pair;
    for (const stat of report.values()) {
      if (stat.kind === 'video' && stat.type === (value.role === 'host' ? 'outbound-rtp' : 'inbound-rtp')) video = stat;
      if (stat.type === 'transport' && stat.selectedCandidatePairId) pair = report.get(stat.selectedCandidatePairId);
    }
    const parts = [];
    if (pair) {
      const relay = [pair.localCandidateId,pair.remoteCandidateId].some(id => report.get(id)?.candidateType === 'relay');
      parts.push(t(relay ? '加密中继' : '加密直连'));
      if (Number.isFinite(pair.currentRoundTripTime)) parts.push(t('往返 {ms} ms', {ms:Math.round(pair.currentRoundTripTime*1000)}));
    } else parts.push(t('已加密'));
    if (video?.frameWidth && video?.frameHeight) parts.push(video.frameWidth + ' × ' + video.frameHeight);
    if (Number.isFinite(video?.framesPerSecond)) parts.push(t('{fps} 帧/秒', {fps:Math.round(video.framesPerSecond)}));
    const bytes = value.role === 'host' ? video?.bytesSent : video?.bytesReceived;
    const prev = value.previous;
    if (Number.isFinite(bytes) && Number.isFinite(video.timestamp)) {
      if (prev && bytes >= prev.bytes && video.timestamp > prev.time) parts.push(((bytes-prev.bytes)*8/(video.timestamp-prev.time)/1000).toFixed(1) + ' Mbps');
      value.previous = {bytes,time:video.timestamp};
    }
    $('session-stats').textContent = parts.join('  ·  ');
  } catch { /* An unavailable sample leaves the last completed reading visible. */ }
  finally { value.readingStats = false; }
}
function connectionChanged(value) {
  if (!isCurrent(value)) return;
  const state = value.pc.connectionState;
  if (state === 'connected') {
    if (!value.filesOnly || value.files.ready) clearTimeout(value.connectTimer);
    clearTimeout(value.lossTimer);
    value.lossTimer = null;
    setStatus(value.role === 'host' && !value.filesOnly ? '正在共享' : '已连接','live');
    if (value.role === 'host' && !value.filesOnly) {
      $('sharing-title').dataset.i18n = '你的屏幕正在共享';
      $('sharing-title').textContent = t('你的屏幕正在共享');
      value.nativeCapture?.video.refresh();
    }
    void readStats(value);
  } else if (['closed','failed'].includes(state)) {
    terminate(value, mediaFailureMessage(value));
  } else if (state === 'disconnected' && !value.lossTimer) {
    if (value.role === 'host' && value.allowControl) Promise.resolve(api.input(value.requestId,{kind:'reset'})).catch(() => {});
    setStatus('正在恢复连接','pending');
    $('session-stats').textContent = t('网络连接中断，正在等待恢复…');
    value.lossTimer = setTimeout(() => terminate(value,'网络连接超时，已结束会话。'),8000);
  }
}
function mediaFailureMessage(value) {
  if (value.filesOnly) return '文件连接失败，请检查两端网络后重试。';
  if (!value.managedWan) return '无法建立媒体连接。跨公网时，请检查两端的 TURN 中继设置。';
  if (value.managedIceUnavailable && !info.turnConfigured) return '已完成公网配对，但未能获取媒体中继凭据，画面也无法直连。请稍后重试或联系服务管理员。';
  if (value.managedTurn && !info.turnConfigured) return '已完成公网配对，但媒体中继未能连接。请稍后重试或联系服务管理员。';
  return info.turnConfigured
    ? '已完成公网配对，但画面连接失败。请检查 TURN 地址、凭据和网络可达性。'
    : '已完成公网配对，但两端无法直连，公共媒体中继尚未启用。请联系服务管理员。';
}
function scheduleGrant(value, expiresAt) {
  clearTimeout(value.grantTimer);
  if (!Number.isSafeInteger(expiresAt) || expiresAt <= Date.now()) return;
  const remaining = expiresAt - Date.now();
  value.grantExpiresAt = expiresAt;
  value.grantTimer = setTimeout(() => {
    void renewGrant(value).catch(() => terminate(value, '媒体中继授权已结束，请重新连接或联系管理员。'));
  }, Math.max(1000, remaining - Math.min(30000, remaining / 4)));
}

async function publicRelayInUse(value) {
  if (value.pc.connectionState !== 'connected') return true;
  const report = await value.pc.getStats();
  const transport = [...report.values()].find(stat => stat.type === 'transport' && stat.selectedCandidatePairId);
  const pair = report.get(transport?.selectedCandidatePairId);
  const local = report.get(pair?.localCandidateId);
  if (!local) return true;
  return local.candidateType === 'relay' && (!local.url || value.managedURLs.has(local.url));
}

async function restartIce(value) {
  if (!isCurrent(value) || value.role !== 'host' || !value.pc.remoteDescription || value.pc.signalingState !== 'stable' ||
      value.offering || Date.now() - (value.lastRestart || 0) < 4000) return;
  value.offering = true;
  value.lastRestart = Date.now();
  try {
    const offer = await value.pc.createOffer({iceRestart:true});
    if (!isCurrent(value)) return;
    await value.pc.setLocalDescription(offer);
    if (isCurrent(value)) await api.signal({type:'offer', sdp:value.pc.localDescription.sdp});
  } finally { value.offering = false; }
}

function renewGrant(value, answering = false) {
  if (!isCurrent(value)) return;
  if (value.renewing) return value.renewing;
  value.renewing = (async () => {
    const inUse = await publicRelayInUse(value);
    if (!isCurrent(value)) return;
    // A selected direct or custom route needs no further managed relay budget.
    if (!inUse) {
      value.pc.setConfiguration({...value.pc.getConfiguration(), iceServers:value.baseIce});
      value.grantExpiresAt = 0;
      return;
    }
    const {iceServers, expiresAt} = await api.renewIce();
    if (!isCurrent(value)) return;
    if (!iceServers?.length || expiresAt <= Date.now()) throw new Error('媒体中继授权已结束，请重新连接或联系管理员。');
    const previous = value.grantExpiresAt;
    value.pc.setConfiguration({...value.pc.getConfiguration(), iceServers:[...value.baseIce,...iceServers]});
    value.managedURLs = new Set(iceServers.flatMap(server => [server.urls].flat()));
    scheduleGrant(value,expiresAt);
    if (expiresAt === previous || !value.pc.remoteDescription || answering) return;
    if (value.role === 'host') await restartIce(value);
    else await api.signal({type:'ice-restart'});
  })().finally(() => { value.renewing = null; });
  return value.renewing;
}

function sessionTitle(host,filesOnly) {
  return filesOnly ? t('与「{name}」传输文件',{name:peerName}) :
    host ? t('向「{name}」共享屏幕',{name:peerName}) : peerName;
}
function startSession(event) {
  if (!['request','joining'].includes(phase)) return;
  if (event.role === 'host' && event.requestId !== pendingRequest?.id) return;
  pendingRequest = null;
  clearInterval(expiryTimer); clearTimeout(joinTimer);
  if ($('consent').open) $('consent').close();
  phase = 'session';
  $('home').hidden = true; $('session').hidden = false;
  syncHome();
  notice('session-notice');
  const host = event.role === 'host';
  const filesOnly = event.captureMode === 'files';
  $('session').dataset.mode = filesOnly ? 'files' : 'screen';
  peerName = event.name || peerName || t('远端设备');
  $('session-title').textContent = sessionTitle(host,filesOnly);
  $('viewer-stage').hidden = host || filesOnly; $('host-stage').hidden = !host || filesOnly;
  $('fullscreen').hidden = host || filesOnly; $('live-quality-wrap').hidden = host || filesOnly;
  $('sharing-title').dataset.i18n = '正在建立屏幕共享';
  $('sharing-title').textContent = t('正在建立屏幕共享');
  $('session-stats').textContent = t('正在协商加密连接…');
  setStatus('正在连接','pending');
  const iceServers = [...(info.iceServers || [])];
  const managedServers = event.managedWan && Array.isArray(event.managedIceServers) ? event.managedIceServers : [];
  if (event.managedWan) iceServers.push({urls:'stun:stun.cloudflare.com:3478'});
  const pc = new RTCPeerConnection({iceServers:[...iceServers,...managedServers]});
  const systemPicker = host && event.captureMode === 'system-picker';
  const nativePicker = host && event.captureMode === 'native-display';
  const value = room = {
    pc, baseIce:iceServers, managedURLs:new Set(managedServers.flatMap(server => [server.urls].flat())), role:host ? 'host' : 'viewer',
    requestId:event.requestId, systemPicker, nativePicker, filesOnly, controlRequested:host && event.controlRequested === true,
    allowControl:host && !systemPicker && !nativePicker && !filesOnly && event.allowControl === true,
    profile:'balanced', managedWan:event.managedWan === true,
    managedIceUnavailable:event.managedIceUnavailable === true,
    managedTurn:managedServers.some(server => [server.urls].flat().some(url => /^turns?:/i.test(url))),
    candidates:[], signaling:Promise.resolve(), adjusting:false
  };
  scheduleGrant(value,event.managedIceExpiresAt);
  value.files = new window.CCFileChannel(api,event.requestId,files => {
    renderFiles(files);
    if (filesOnly && isCurrent(value)) {
      if (files.ready && pc.connectionState === 'connected') clearTimeout(value.connectTimer);
      if (files.closed) terminate(value,'文件通道已关闭。');
    }
  });
  renderFiles(value.files);
  showPermission(value);
  pc.onicecandidate = (e) => {
    if (isCurrent(value) && e.candidate) Promise.resolve(api.signal({type:'candidate',candidate:e.candidate.toJSON()}))
      .catch((err) => terminate(value,describeError(err)));
  };
  pc.onconnectionstatechange = () => connectionChanged(value);
  pc.ondatachannel = (e) => {
    if (value.role === 'viewer' && isCurrent(value) && e.channel.label === window.CCFileChannel.label) value.files.attach(e.channel);
    else if (!filesOnly && value.role === 'viewer' && isCurrent(value)) attachChannel(value,e.channel);
    else e.channel.close();
  };
  pc.ontrack = (e) => {
    if (filesOnly) { e.track.stop(); return; }
    if (!isCurrent(value) || value.role !== 'viewer' || e.track.kind !== 'video') return;
    $('remote-video').srcObject = new MediaStream([e.track]);
    $('remote-video').play().catch(() => {});
  };
  value.statsTimer = setInterval(() => readStats(value),1500);
  value.connectTimer = setTimeout(() => {
    const negotiated = value.pc.localDescription && value.pc.remoteDescription;
    terminate(value, filesOnly || negotiated && value.managedWan ? mediaFailureMessage(value)
      : '等待画面超时。请核实录屏权限和两端的网络设置。');
  },90_000);
  if (host && filesOnly) {
    value.files.attach(pc.createDataChannel(window.CCFileChannel.label,{ordered:true,priority:'low'}));
    void sendOffer(value).catch(e => terminate(value,describeError(e)));
  } else if (host) {
    attachChannel(value,pc.createDataChannel('jianping-control-v1',{ordered:true}));
    if (systemPicker || nativePicker) {
      label('sharing-title','使用系统选择器共享画面');
      label('resume-capture','选择共享画面');
      $('resume-capture').hidden = false;
    } else void capture(value);
  }
}
async function sendOffer(value) {
  const offer = await value.pc.createOffer();
  if (!isCurrent(value)) return;
  await value.pc.setLocalDescription(offer);
  if (isCurrent(value)) await api.signal({type:'offer',sdp:value.pc.localDescription.sdp});
}
async function requestNativeFrame(value) {
  const accepted = await api.nativeFrameAck(value.requestId,value.nativeCapture.id);
  if (accepted === false) throw new Error('native-picker-failed');
}
async function captureScreen(value) {
  if (value.nativePicker) {
    const selection = await api.pickNativeDisplay(value.requestId);
    if (!isCurrent(value)) throw new Error('连接已结束。');
    try {
      const {captureId,width,height,matched} = selection;
      const video = new window.NativeDisplayVideo(width,height);
      value.nativeCapture = {id:captureId,width,height,matched,video};
      // The first credit is sent only after this exact session is prepared to
      // decode. Main keeps the next frame until the renderer acknowledges it.
      await Promise.all([video.first.promise,requestNativeFrame(value)]);
      return video.stream;
    } catch (e) {
      if (isCurrent(value)) {
        await api.stopNativeDisplay(value.requestId,selection.captureId).catch(() => {});
        terminate(value,nativePickerError('native-picker-failed'));
      }
      throw e;
    }
  }
  if (!value.systemPicker) {
    return navigator.mediaDevices.getDisplayMedia({
      audio:false, video:{frameRate:{ideal:60,max:60},width:{ideal:2560},height:{ideal:1440}}
    });
  }
  const armId = await api.armSystemPicker(value.requestId);
  let stream;
  try {
    if (isCurrent(value)) stream = await navigator.mediaDevices.getDisplayMedia({audio:false,video:true});
  } finally {
    try {
      const released = await api.disarmSystemPicker(armId);
      if (!released && stream) throw new Error('连接已结束。');
    }
    catch (e) { stream?.getTracks().forEach(track => track.stop()); throw e; }
  }
  return stream;
}
async function capture(value) {
  if (!isCurrent(value) || value.filesOnly || value.capturing || value.stream) return;
  value.capturing = true;
  $('resume-capture').hidden = true;
  $('session-screen-settings').hidden = true;
  notice('session-notice');
  try {
    const stream = await captureScreen(value);
    if (!isCurrent(value)) { stream?.getTracks().forEach(t => t.stop()); return; }
    value.stream = stream;
    const track = stream.getVideoTracks()[0];
    if (!track || track.readyState !== 'live') throw new Error('未获取到屏幕画面。');
    track.onended = () => { if (isCurrent(value)) void disconnect('本机屏幕共享已停止。'); };
    if (!value.systemPicker) {
      const allowControl = value.nativePicker ? await api.screenStreamReady(value.requestId,value.nativeCapture.id)
        : await api.screenStreamReady(value.requestId);
      if (!isCurrent(value)) return;
      if (track.readyState !== 'live') throw new Error('本机屏幕共享已停止。');
      value.allowControl = allowControl === true;
      sharePermission(value);
      if (value.nativePicker && value.controlRequested && !value.nativeCapture.matched && !value.allowControl) {
        notice('session-notice','无法确认所选显示器的键鼠坐标，本次仅共享画面。');
      }
    }
    value.sender = value.pc.addTrack(track,stream);
    await sendOffer(value);
  } catch (e) {
    if (!isCurrent(value)) return;
    if (value.stream) {
      const code = describeError(e);
      const message = Object.hasOwn(screenErrors,code) ? screenErrorMessage(code) :
        code === 'control-permission' ? '键鼠控制需要辅助功能授权。如果 macOS 要求管理员确认，请联系这台 Mac 的管理员。' : code;
      terminate(value,message); return;
    }
    let message = '';
    if (value.nativePicker) {
      const code = describeError(e);
      if (code === 'permission-restricted') { terminate(value,screenErrorMessage(code)); return; }
      message = nativePickerError(code);
    } else if (value.systemPicker) {
      const code = describeError(e);
      if (code === 'permission-restricted') { terminate(value,screenErrorMessage(code)); return; }
      message = ['NotAllowedError','AbortError'].includes(e.name)
        ? '尚未选择画面。可以重新选择，或结束连接。' : '系统暂时无法读取所选画面。请重新选择或结束连接。';
    } else if (e.name !== 'InvalidStateError') {
      message = '暂时无法读取画面。请确认所选显示器已连接并唤醒，然后重试。';
    }
    notice('session-notice',message,!!message);
    const chooseDisplay = value.systemPicker || value.nativePicker;
    label('sharing-title', chooseDisplay ? '使用系统选择器共享画面' : '点击开始共享此屏幕');
    label('resume-capture', chooseDisplay ? '选择共享画面' : '重试共享');
    $('resume-capture').hidden = false;
    $('session-screen-settings').hidden = chooseDisplay || info.platform !== 'darwin' || e.name !== 'NotAllowedError';
  } finally { value.capturing = false; }
}
$('resume-capture').onclick = () => { if (room?.role === 'host') void capture(room); };
async function receiveSignal(value, payload) {
  if (!isCurrent(value) || !payload) return;
  const pc = value.pc;
  const matchesRemote = candidate => pc.remoteDescription && (!candidate?.usernameFragment ||
    pc.remoteDescription.sdp.split(/\r?\n/).includes('a=ice-ufrag:' + candidate.usernameFragment));
  if (payload.type === 'candidate') {
    if (matchesRemote(payload.candidate)) await pc.addIceCandidate(payload.candidate);
    else if (value.candidates.length < 128) value.candidates.push(payload.candidate);
    return;
  }
  if (payload.type === 'ice-restart') {
    if (value.role === 'host') await restartIce(value);
    return;
  }
  if ((payload.type === 'offer' && pc.signalingState !== 'stable') ||
      (payload.type === 'answer' && pc.signalingState !== 'have-local-offer')) return;
  if ((value.role === 'viewer' && payload.type !== 'offer') || (value.role === 'host' && payload.type !== 'answer')) return;
  if (value.role === 'viewer' && pc.remoteDescription && value.grantExpiresAt && value.grantExpiresAt - Date.now() <= 35000) {
    await renewGrant(value, true);
    if (!isCurrent(value)) return;
  }
  await pc.setRemoteDescription({type:payload.type,sdp:payload.sdp});
  for (const candidate of value.candidates.splice(0)) {
    if (isCurrent(value) && matchesRemote(candidate)) await pc.addIceCandidate(candidate);
  }
  if (!isCurrent(value)) return;
  if (value.role === 'viewer') {
    await pc.setLocalDescription(await pc.createAnswer());
    if (isCurrent(value)) await api.signal({type:'answer',sdp:pc.localDescription.sdp});
  } else if (!value.filesOnly) scheduleQuality(value,value.profile);
}
$('remote-video').onplaying = () => { $('video-wait').hidden = true; };
$('fullscreen').onclick = async () => {
  try { if (document.fullscreenElement) await document.exitFullscreen(); else await $('session').requestFullscreen(); }
  catch (e) { notice('session-notice',describeError(e),true); }
};

function pointOnVideo(event, clamp = false) {
  const video = $('remote-video');
  const bounds = video.getBoundingClientRect();
  if (!video.videoWidth || !video.videoHeight) return null;
  const scale = Math.min(bounds.width/video.videoWidth,bounds.height/video.videoHeight);
  const width = video.videoWidth*scale, height = video.videoHeight*scale;
  if (!width || !height) return null;
  const x = (event.clientX-bounds.left-(bounds.width-width)/2)/width;
  const y = (event.clientY-bounds.top-(bounds.height-height)/2)/height;
  if (!clamp && (x<0 || x>1 || y<0 || y>1)) return null;
  return {x:Math.min(1,Math.max(0,x)), y:Math.min(1,Math.max(0,y))};
}
function sendInput(payload) {
  const value = room;
  if (value?.role !== 'viewer' || !value.allowControl) return false;
  if (payload.kind === 'move' && value.channel?.bufferedAmount > 8192) return false;
  return send(value.channel,payload);
}
const video = $('remote-video');
const heldButtons = new Set();
let pointerFrame = 0;
let nextPoint = null;
function cancelMove() {
  cancelAnimationFrame(pointerFrame); pointerFrame = 0; nextPoint = null;
}
function resetInput() { cancelMove(); heldButtons.clear(); sendInput({kind:'reset'}); }
video.onpointermove = (e) => {
  if (e.pointerType !== 'mouse' || !room?.allowControl) return;
  const point = pointOnVideo(e,video.hasPointerCapture(e.pointerId));
  if (!point) return;
  nextPoint = point;
  if (pointerFrame) return;
  pointerFrame = requestAnimationFrame(() => {
    pointerFrame = 0;
    if (nextPoint) sendInput({kind:'move',...nextPoint});
    nextPoint = null;
  });
};
video.onpointerdown = (e) => {
  if (e.pointerType === 'mouse' && room?.allowControl && pointOnVideo(e)) {
    video.setPointerCapture(e.pointerId);
  }
};
// Mouse events deliver each transition, including pressing a second button during a drag.
video.onmousedown = (e) => {
  if (!room?.allowControl || ![0,1,2].includes(e.button)) return;
  const point = pointOnVideo(e);
  if (!point) return;
  e.preventDefault(); cancelMove(); video.focus({preventScroll:true});
  if (sendInput({kind:'button',down:true,button:e.button,...point})) heldButtons.add(e.button);
};
window.addEventListener('mouseup', (e) => {
  if (!heldButtons.delete(e.button)) return;
  e.preventDefault(); cancelMove();
  const point = pointOnVideo(e,true);
  if (point) sendInput({kind:'button',down:false,button:e.button,...point});
  else resetInput();
});
video.onpointercancel = resetInput;
video.oncontextmenu = (e) => e.preventDefault();
video.addEventListener('wheel',(e) => {
  if (!room?.allowControl) return;
  const point = pointOnVideo(e);
  if (!point) return;
  e.preventDefault();
  const scale = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? video.clientHeight : 1;
  sendInput({kind:'wheel',dx:Math.round(e.deltaX*scale),dy:Math.round(e.deltaY*scale),...point});
},{passive:false});
function sendKey(e, down) {
  if (!room?.allowControl || !e.code) return;
  if (e.code === 'Escape' && e.shiftKey) {
    e.preventDefault();
    if (down) { resetInput(); $('end-session').focus(); }
    return;
  }
  e.preventDefault();
  sendInput({kind:'key',code:e.code,down});
}
video.onkeydown = (e) => sendKey(e,true);
video.onkeyup = (e) => sendKey(e,false);
video.onblur = resetInput;
window.addEventListener('blur',resetInput);
document.addEventListener('visibilitychange',() => { if (document.hidden) resetInput(); });
window.addEventListener('pagehide',() => { resetInput(); cleanRoom(); });

async function handleEvent(event) {
  switch (event.type) {
    case 'native-frame': {
      const value = room;
      const source = value?.nativeCapture;
      if (!source || value.requestId !== event.requestId || source.id !== event.captureId) break;
      try {
        if (event.width !== source.width || event.height !== source.height) throw new Error('native-picker-failed');
        if (await source.video.draw(event.bytes) && isCurrent(value)) await requestNativeFrame(value);
      } catch {
        if (isCurrent(value)) {
          void api.stopNativeDisplay(value.requestId,source.id).catch(() => {});
          terminate(value,nativePickerError('native-picker-failed'));
        }
      }
      break;
    }
    case 'account': setAccount(event.account); break;
    case 'update':
      updateState = event.state || { phase: 'idle' };
      renderUpdate();
      break;
    case 'request': await requestConsent(event); break;
    case 'accepted': {
      try { startSession(event); }
      catch (e) { await disconnect(describeError(e),true); }
      break;
    }
    case 'signal': {
      const value = room;
      if (value) value.signaling = value.signaling.then(() => receiveSignal(value,event.signal))
        .catch(e => terminate(value,describeError(e)));
      break;
    }
    case 'control-unavailable':
      if (room?.role === 'host') controlUnavailable(room,event.message);
      break;
    case 'closed':
      if (phase !== 'idle') backHome(event.reason || '对方已结束连接。', event.error === true);
      break;
    case 'error':
      if (phase !== 'idle') await disconnect(event.message || '连接出错。',true);
      else notice('home-notice', event.message || '连接出错。',true);
      break;
  }
}
function renderUpdate() {
  $('update-current-version').textContent = t('当前版本 {version}', { version: info.version || '—' });
  const state = updateState.phase;
  const progress = Math.max(0, Math.min(100, (Number(updateState.progress) || 0) * 100));
  const statuses = {
    idle: t('检查是否有新版本。'),
    checking: t('正在检查更新…'),
    current: t('你已使用最新版本。'),
    available: t('新版本 {version} 已可下载。', { version: updateState.version || '—' }),
    downloading: t('正在下载更新 · {progress}%', { progress: Math.round(progress) }),
    ready: t('更新已准备好。'),
    installing: t('正在安装更新…'),
    installed: t('安装程序已打开。'),
    error: translate(updateState.message || '检查更新失败。请检查网络连接后重试。')
  };
  const labels = { available: '下载更新', ready: '安装更新', error: '重试' };
  $('update-status').textContent = statuses[state] || statuses.idle;
  $('update-status').dataset.state = state;
  $('update-progress').hidden = state !== 'downloading';
  $('update-progress').value = progress;
  $('update-action').textContent = t(labels[state] || '检查更新');
  $('update-action').disabled = ['checking', 'downloading', 'installing'].includes(state) || phase !== 'idle';
  $('update-note').hidden = !['ready','installed'].includes(state);
  $('update-note').textContent = t(state === 'installed' ? '请按安装窗口的步骤完成更新。' : '安装时会关闭 CC Connect。');
}
async function performUpdateAction() {
  if (phase !== 'idle' || ['checking','downloading','installing'].includes(updateState.phase)) return;
  const previous = updateState.phase;
  const method = previous === 'available' ? 'downloadUpdate' : previous === 'ready' ? 'installUpdate' : 'checkUpdate';
  updateState = { ...updateState, phase: method === 'downloadUpdate' ? 'downloading' : method === 'installUpdate' ? 'installing' : 'checking', progress: 0 };
  renderUpdate();
  try {
    if (!api?.[method]) throw new Error('检查更新失败。请检查网络连接后重试。');
    const result = await api[method]();
    if (result?.state?.phase || result?.phase) {
      updateState = result.state || result;
      renderUpdate();
    }
  } catch (error) {
    const fallback = method === 'downloadUpdate' ? '下载失败。请检查网络连接后重试。'
      : method === 'installUpdate' ? '无法启动更新安装，请重试。'
      : '检查更新失败。请检查网络连接后重试。';
    updateState = { phase: 'error', message: error?.message ? String(error.message).replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '') : fallback };
    renderUpdate();
  }
}
$('update-button').onclick = () => {
  window.ccSelects?.close();
  renderUpdate();
  $('update-dialog').showModal();
  if (['idle', 'current', 'error'].includes(updateState.phase)) void performUpdateAction();
};
$('close-update').onclick = () => $('update-dialog').close();
$('update-action').onclick = () => { void performUpdateAction(); };

function refreshLanguage() {
  i18n.apply();
  renderAccount();
  $('language-select').value = i18n.getLanguage();
  window.ccSelects?.refresh();
  renderUpdate();
  renderScreenCheck();
  renderIslandDetails();
  if (room) {
    renderFiles(room.files);
    showPermission(room);
    $('session-title').textContent = sessionTitle(room.role === 'host',room.filesOnly);
  }
  setQuality(quality);
  $('device-name').textContent = info.name || t('本机');
  for (const id of ['home-notice', 'settings-notice']) notice(id);
  if (api?.setLanguage) Promise.resolve(api.setLanguage(i18n.getLanguage())).catch(() => {});
}
$('language-select').onchange = () => {
  i18n.setLanguage($('language-select').value);
  refreshLanguage();
};
i18n.apply();
$('language-select').value = i18n.getLanguage();
setStatus('待连接');
setMode('viewer');
renderAccount();
setQuality(quality);
syncHome();
if (api) {
  api.onEvent(event => { void handleEvent(event).catch(e => disconnect(describeError(e),true)); });
  Promise.resolve(api.info()).then(updateInfo).catch(e => notice('home-notice',describeError(e),true));
} else {
  $('device-name').textContent = t('请使用桌面应用');
  for (const id of ['join-button','join-files','host-button','settings-button','update-button']) $(id).disabled = true;
  notice('home-notice','请在CC Connect桌面应用中打开此页面。');
}
