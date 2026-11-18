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
let mode = 'viewer';
let phase = 'idle';
let generation = 0;
let room = null;
let peerName = '';
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
function setStatus(text, state = '') {
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
function syncHome() {
  const idle = phase === 'idle';
  const inviting = phase === 'listening' || phase === 'request';
  $('view-tab').disabled = !idle && mode !== 'viewer';
  $('host-tab').disabled = !idle && mode !== 'host';
  $('invite-input').disabled = !idle;
  $('join-button').disabled = !idle;
  $('host-button').disabled = !idle;
  $('host-button').hidden = inviting;
  $('invite-box').hidden = !inviting;
  $('cancel-host').hidden = !inviting;
  $('waiting').hidden = phase !== 'joining';
  $('settings-button').disabled = !idle;
  $('update-button').disabled = !idle;
  $('language-select').disabled = !idle;
}
function updateInfo(data) {
  info = data;
  if (info.update?.phase) updateState = info.update;
  if (!localeInitialized) {
    i18n.initialize(info.language);
    localeInitialized = true;
    refreshLanguage();
  }
  renderUpdate();
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
  cancelMove(); heldButtons.clear();
  clearInterval(previous.statsTimer);
  clearTimeout(previous.connectTimer);
  clearTimeout(previous.lossTimer);
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
  clearInterval(expiryTimer);
  clearTimeout(joinTimer);
  cleanRoom();
  if ($('consent').open) $('consent').close();
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  phase = 'idle';
  peerName = '';
  $('host-invite').value = '';
  $('host-help').hidden = true;
  $('session').hidden = true;
  $('home').hidden = false;
  $('resume-capture').hidden = true;
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
  if (phase !== 'idle' || !invite) return;
  const token = ++generation;
  phase = 'joining';
  setStatus('正在配对', 'pending');
  syncHome(); notice('home-notice');
  joinTimer = setTimeout(() => {
    if (generation === token && phase === 'joining') void disconnect('等待时间已到，请确认对方仍在等待配对。', true);
  }, 120_000);
  try { await api.join(invite); }
  catch (e) { if (generation === token) await disconnect(describeError(e), true); }
};
$('host-button').onclick = async () => {
  if (phase !== 'idle') return;
  const token = ++generation;
  phase = 'opening';
  syncHome(); notice('home-notice'); setStatus('正在创建邀请', 'pending');
  try {
    const { invite, expiresAt, internetAvailable, internetIssue } = await api.host();
    if (generation !== token) return;
    if (phase === 'opening') phase = 'listening';
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
        if (phase === 'listening') void disconnect('配对码已过期。请生成新的配对码。');
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
$('copy-button').onclick = async () => {
  try { await api.copy($('host-invite').value); notice('home-notice', '配对码已复制。'); }
  catch (e) { notice('home-notice', describeError(e), true); }
};
$('host-invite').onclick = (e) => e.target.select();

$('settings-button').onclick = () => {
  if (phase !== 'idle') return;
  $('relay-url').value = info.relayUrl || '';
  $('turn-url').value = info.turnUrl || '';
  $('turn-user').value = info.turnUsername || '';
  $('turn-password').value = '';
  $('turn-password').placeholder = info.turnConfigured ? t('已保存') : '';
  notice('settings-notice');
  $('settings-dialog').showModal();
};
function closeSettings() { $('turn-password').value = ''; $('settings-dialog').close(); }
$('close-settings').onclick = closeSettings;
$('cancel-settings').onclick = closeSettings;
$('settings-dialog').onclose = () => { $('turn-password').value = ''; };
$('settings-form').onsubmit = async (event) => {
  event.preventDefault();
  if (phase !== 'idle') return;
  $('save-settings').disabled = true;
  try {
    await api.settings({
      relayUrl:$('relay-url').value.trim(), turnUrl:$('turn-url').value.trim(),
      turnUsername:$('turn-user').value.trim(), turnPassword:$('turn-password').value
    });
    updateInfo(await api.info());
    closeSettings(); notice('home-notice', '连接设置已保存。');
  } catch (e) { notice('settings-notice', describeError(e), true); }
  finally { $('save-settings').disabled = false; }
};

async function requestConsent(event) {
  if (!['listening','opening'].includes(phase)) return;
  phase = 'request'; syncHome();
  const token = generation;
  peerName = event.name || t('远端设备');
  setStatus('收到连接请求', 'pending');
  $('consent-title').textContent = t('允许「{name}」查看屏幕？', {name:peerName});
  $('allow-control').checked = false;
  $('allow-control').disabled = !info.inputSupported;
  $('control-note').textContent = info.inputSupported ? '' : t('本机仅支持观看。');
  $('control-note').hidden = !!info.inputSupported;
  $('screens').replaceChildren(new Option(t('正在读取屏幕…'),''));
  $('accept').disabled = true;
  notice('consent-notice');
  $('consent').showModal();
  try {
    const screens = await api.screens();
    if (generation !== token || phase !== 'request') return;
    $('screens').replaceChildren(...screens.map((screen, index) =>
      new Option(screen.name ? translate(screen.name) : t('屏幕 {number}', {number:index + 1}), screen.id, false, !!screen.primary)));
    if (!screens.length) throw new Error('未找到可共享的屏幕，请检查系统屏幕录制权限。');
    $('accept').disabled = false;
  } catch (e) { if (generation === token) notice('consent-notice', describeError(e), true); }
}
$('consent-form').onsubmit = async (event) => {
  event.preventDefault();
  if (phase !== 'request' || !$('screens').value) return;
  const token = generation;
  $('accept').disabled = true;
  try { await api.accept($('allow-control').checked, $('screens').value); }
  catch (e) {
    if (generation === token && phase === 'request') {
      notice('consent-notice', describeError(e), true);
      $('accept').disabled = false;
    }
  }
};
async function rejectRequest() {
  if (phase !== 'request') return;
  const token = generation;
  try { await api.reject(); }
  catch (e) { if (token === generation) await disconnect(describeError(e), true); return; }
  if (token === generation) backHome('已拒绝连接请求。');
}
$('consent').oncancel = (event) => { event.preventDefault(); void rejectRequest(); };
$('reject').onclick = rejectRequest;

function showPermission(value) {
  if (!isCurrent(value)) return;
  const modeText = value.allowControl
    ? (value.role === 'host' ? '允许键鼠控制' : '可控制 · Shift + Esc 释放键鼠')
    : '仅观看';
  $('permission-state').textContent = translate(modeText);
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
function attachChannel(value, channel) {
  if (value.channel || channel.label !== 'jianping-control-v1') { channel.close(); return; }
  value.channel = channel;
  channel.onopen = () => {
    if (!isCurrent(value)) return;
    if (value.role === 'host') sharePermission(value);
    else send(channel, {kind:'quality',profile:quality});
  };
  channel.onmessage = (event) => {
    if (!isCurrent(value) || typeof event.data !== 'string' || event.data.length > 2048) return;
    let payload;
    try { payload = JSON.parse(event.data); } catch { return; }
    if (!payload || typeof payload !== 'object') return;
    if (value.role === 'viewer') {
      if (payload.kind === 'permission') { value.allowControl = payload.allowControl === true; showPermission(value); }
      return;
    }
    if (payload.kind === 'quality') { scheduleQuality(value,payload.profile); return; }
    if (!value.allowControl || !['move','button','wheel','key','reset'].includes(payload.kind)) return;
    Promise.resolve(api.input(payload)).catch(() => controlUnavailable(value));
  };
  channel.onclose = () => {
    if (!isCurrent(value)) return;
    if (value.role === 'host' && value.allowControl) Promise.resolve(api.input({kind:'reset'})).catch(() => {});
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
    clearTimeout(value.connectTimer); clearTimeout(value.lossTimer);
    value.lossTimer = null;
    setStatus(value.role === 'host' ? '正在共享' : '已连接','live');
    if (value.role === 'host') $('sharing-title').textContent = t('你的屏幕正在共享');
    void readStats(value);
  } else if (['closed','failed'].includes(state)) {
    terminate(value, mediaFailureMessage(value));
  } else if (state === 'disconnected' && !value.lossTimer) {
    if (value.role === 'host' && value.allowControl) Promise.resolve(api.input({kind:'reset'})).catch(() => {});
    setStatus('正在恢复连接','pending');
    $('session-stats').textContent = t('网络连接中断，正在等待恢复…');
    value.lossTimer = setTimeout(() => terminate(value,'网络连接超时，已结束会话。'),8000);
  }
}
function mediaFailureMessage(value) {
  if (!value.managedWan) return '无法建立媒体连接。跨公网时，请检查两端的 TURN 中继设置。';
  if (value.managedIceUnavailable && !info.turnConfigured) return '已完成公网配对，但未能获取媒体中继凭据，画面也无法直连。请稍后重试或联系服务管理员。';
  if (value.managedTurn && !info.turnConfigured) return '已完成公网配对，但媒体中继未能连接。请稍后重试，或在连接设置中使用自己的 TURN 中继。';
  return info.turnConfigured
    ? '已完成公网配对，但画面连接失败。请检查 TURN 地址、凭据和网络可达性。'
    : '已完成公网配对，但两端无法直连。请在连接设置中填写可用的 TURN 中继，或让两台电脑加入同一 VPN。';
}
function startSession(event) {
  if (!['request','joining'].includes(phase)) return;
  clearInterval(expiryTimer); clearTimeout(joinTimer);
  if ($('consent').open) $('consent').close();
  phase = 'session';
  $('home').hidden = true; $('session').hidden = false;
  $('settings-button').disabled = true;
  notice('session-notice');
  const host = event.role === 'host';
  peerName = event.name || peerName || t('远端设备');
  $('session-title').textContent = host ? t('向「{name}」共享屏幕', {name:peerName}) : peerName;
  $('viewer-stage').hidden = host; $('host-stage').hidden = !host;
  $('fullscreen').hidden = host; $('live-quality-wrap').hidden = host;
  $('sharing-title').textContent = t('正在建立屏幕共享');
  $('session-stats').textContent = t('正在协商加密连接…');
  setStatus('正在连接','pending');
  const iceServers = [...(info.iceServers || [])];
  const managedServers = event.managedWan && Array.isArray(event.managedIceServers) ? event.managedIceServers : [];
  if (event.managedWan) iceServers.push({urls:'stun:stun.cloudflare.com:3478'}, ...managedServers);
  const pc = new RTCPeerConnection({iceServers});
  const value = room = {
    pc, role:host ? 'host' : 'viewer', allowControl:host && event.allowControl === true,
    profile:'balanced', managedWan:event.managedWan === true,
    managedIceUnavailable:event.managedIceUnavailable === true,
    managedTurn:managedServers.some(server => [server.urls].flat().some(url => /^turns?:/i.test(url))),
    candidates:[], signaling:Promise.resolve(), adjusting:false
  };
  showPermission(value);
  pc.onicecandidate = (e) => {
    if (isCurrent(value) && e.candidate) Promise.resolve(api.signal({type:'candidate',candidate:e.candidate.toJSON()}))
      .catch((err) => terminate(value,describeError(err)));
  };
  pc.onconnectionstatechange = () => connectionChanged(value);
  pc.ondatachannel = (e) => {
    if (value.role === 'viewer' && isCurrent(value)) attachChannel(value,e.channel);
    else e.channel.close();
  };
  pc.ontrack = (e) => {
    if (!isCurrent(value) || value.role !== 'viewer' || e.track.kind !== 'video') return;
    $('remote-video').srcObject = new MediaStream([e.track]);
    $('remote-video').play().catch(() => {});
  };
  value.statsTimer = setInterval(() => readStats(value),1500);
  value.connectTimer = setTimeout(() => {
    const negotiated = value.pc.localDescription && value.pc.remoteDescription;
    terminate(value, negotiated && value.managedWan ? mediaFailureMessage(value)
      : '等待画面超时。请核实录屏权限和两端的网络设置。');
  },90_000);
  if (host) {
    attachChannel(value,pc.createDataChannel('jianping-control-v1',{ordered:true}));
    void capture(value);
  }
}
async function capture(value) {
  if (!isCurrent(value) || value.capturing || value.stream) return;
  value.capturing = true;
  $('resume-capture').hidden = true;
  try {
    const stream = await navigator.mediaDevices.getDisplayMedia({
      audio:false, video:{frameRate:{ideal:60,max:60},width:{ideal:2560},height:{ideal:1440}},
    });
    if (!isCurrent(value)) { stream.getTracks().forEach(t => t.stop()); return; }
    value.stream = stream;
    const track = stream.getVideoTracks()[0];
    if (!track) throw new Error('未获取到屏幕画面。');
    track.onended = () => { if (isCurrent(value)) void disconnect('本机屏幕共享已停止。'); };
    value.sender = value.pc.addTrack(track,stream);
    const offer = await value.pc.createOffer();
    if (!isCurrent(value)) return;
    await value.pc.setLocalDescription(offer);
    if (isCurrent(value)) await api.signal({type:'offer',sdp:value.pc.localDescription.sdp});
  } catch (e) {
    if (!isCurrent(value)) return;
    if (e.name === 'InvalidStateError' && !value.stream) {
      $('sharing-title').textContent = t('点击开始共享此屏幕');
      $('resume-capture').hidden = false;
    } else {
      terminate(value, e.name === 'NotAllowedError' || e.name === 'NotReadableError'
        ? '系统未允许读取屏幕。请在系统设置中允许CC Connect录制屏幕，重新打开应用后再连接。'
        : describeError(e));
    }
  } finally { value.capturing = false; }
}
$('resume-capture').onclick = () => { if (room?.role === 'host') void capture(room); };
async function receiveSignal(value, payload) {
  if (!isCurrent(value) || !payload) return;
  const pc = value.pc;
  if (payload.type === 'candidate') {
    if (pc.remoteDescription) await pc.addIceCandidate(payload.candidate);
    else if (value.candidates.length < 128) value.candidates.push(payload.candidate);
    return;
  }
  if (pc.remoteDescription) return;
  if ((value.role === 'viewer' && payload.type !== 'offer') || (value.role === 'host' && payload.type !== 'answer')) return;
  await pc.setRemoteDescription({type:payload.type,sdp:payload.sdp});
  for (const candidate of value.candidates.splice(0)) { if (isCurrent(value)) await pc.addIceCandidate(candidate); }
  if (!isCurrent(value)) return;
  if (value.role === 'viewer') {
    await pc.setLocalDescription(await pc.createAnswer());
    if (isCurrent(value)) await api.signal({type:'answer',sdp:pc.localDescription.sdp});
  } else scheduleQuality(value,value.profile);
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
  $('language-select').value = i18n.getLanguage();
  window.ccSelects?.refresh();
  renderUpdate();
  setStatus('待连接');
  setQuality(quality);
  $('device-name').textContent = info.name || t('本机');
  for (const id of ['home-notice', 'settings-notice']) notice(id);
  if (api?.setLanguage) Promise.resolve(api.setLanguage(i18n.getLanguage())).catch(() => {});
}
$('language-select').onchange = () => {
  if (phase !== 'idle') return;
  i18n.setLanguage($('language-select').value);
  refreshLanguage();
};
i18n.apply();
$('language-select').value = i18n.getLanguage();
setStatus('待连接');
setMode('viewer');
setQuality(quality);
syncHome();
if (api) {
  api.onEvent(event => { void handleEvent(event).catch(e => disconnect(describeError(e),true)); });
  Promise.resolve(api.info()).then(updateInfo).catch(e => notice('home-notice',describeError(e),true));
} else {
  $('device-name').textContent = t('请使用桌面应用');
  for (const id of ['join-button','host-button','settings-button','update-button']) $(id).disabled = true;
  notice('home-notice','请在CC Connect桌面应用中打开此页面。');
}
