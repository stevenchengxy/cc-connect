'use strict';
const messages = {
  'zh-CN': {
    release: '0.4.9 预览版', category: '远程桌面', downloads: '下载',
    macRequirements: 'macOS 13+ · Apple Silicon / Intel', winRequirements: 'Windows 10+ · x64',
    sourceCode: 'GitHub 开源', winFormat: '安装程序 · x64', updates: '可在应用内检查更新。Windows 安装程序会更新现有安装。',
    downloadMac: '下载 macOS', downloadWin: '下载 Windows', connectTitle: '如何连接',
    step1: '在两台电脑安装 CC Connect。', step2: '两端登录已获批的账号。新用户使用管理员提供的邀请码注册，每个账号审批一次。', step3: '共享端开启共享，对方输入固定配对码即可连接。可在设置里手动换码。',
    permission: '远程操作需要被控端勾选键鼠权限。', networkTitle: '连接设置',
    networkLan: '两端连接同一账号服务完成配对，可使用不同网络。',
    networkWan: '画面优先直连。严格 NAT 或防火墙可能需要 TURN 媒体中继。',
    networkStatus: '公共中继由管理员按额度启用。也可使用自己的 TURN 或可互访的 VPN。', releaseTitle: '版本说明',
    releaseInfo: '支持简体中文、繁体中文与英文。macOS 包为本地签名，尚未公证。Windows 包尚未签名。',
    administration: '管理员登录后，点「用户管理」即可创建邀请码和审批账号。',
    privacy: '共享端可随时取消邀请或结束连接。具备本机屏幕、进程或网络观察权限的工具仍可能识别远控。'
  },
  'zh-TW': {
    release: '0.4.9 預覽版', category: '遠端桌面', downloads: '下載',
    macRequirements: 'macOS 13+ · Apple Silicon / Intel', winRequirements: 'Windows 10+ · x64',
    sourceCode: 'GitHub 開源', winFormat: '安裝程式 · x64', updates: '可在應用程式內檢查更新。Windows 安裝程式會更新現有安裝。',
    downloadMac: '下載 macOS', downloadWin: '下載 Windows', connectTitle: '如何連線',
    step1: '在兩台電腦安裝 CC Connect。', step2: '兩端登入已核准的帳號。新使用者透過管理員提供的邀請碼註冊，每個帳號核准一次。', step3: '分享端開啟分享，對方輸入固定配對碼即可連線。可在設定裡手動換碼。',
    permission: '遠端操作需要受控端勾選鍵盤與滑鼠權限。', networkTitle: '連線設定',
    networkLan: '兩端連到相同帳號服務完成配對，可使用不同網路。',
    networkWan: '畫面優先直接連線。嚴格 NAT 或防火牆可能需要 TURN 媒體中繼。',
    networkStatus: '公共中繼由管理員按額度啟用。也可使用自己的 TURN 或可互連的 VPN。', releaseTitle: '版本說明',
    releaseInfo: '支援簡體中文、繁體中文與英文。macOS 套件為本機簽署，尚未經過公證。Windows 套件尚未簽署。',
    administration: '管理員登入後，點「使用者管理」即可建立邀請碼和核准帳號。',
    privacy: '分享端可隨時取消邀請或結束連線。具備本機螢幕、程序或網路觀察權限的工具仍可能辨識遠端控制。'
  },
  en: {
    release: '0.4.9 Preview', category: 'Remote desktop', downloads: 'Downloads',
    macRequirements: 'macOS 13+ · Apple Silicon / Intel', winRequirements: 'Windows 10+ · x64',
    sourceCode: 'Open source on GitHub', winFormat: 'Installer · x64', updates: 'Check for updates in the app. The Windows installer updates your existing installation.',
    downloadMac: 'Get for Mac', downloadWin: 'Get for Windows', connectTitle: 'Connect your computers',
    step1: 'Install CC Connect on both computers.', step2: 'Sign in on both devices. New users register with an admin invite and need approval once per account.', step3: 'Start sharing on the host and enter its device code on the other computer. Change the code in Settings at any time between sessions.',
    permission: 'Enable keyboard and mouse access on the host for remote control.', networkTitle: 'Connection settings',
    networkLan: 'Both devices pair through the account service and can use different networks.',
    networkWan: 'Video uses a direct connection when possible. Strict NAT or firewall rules may require a TURN media relay.',
    networkStatus: 'An administrator can enable managed relay service within its budget. You can also use your own TURN relay or a VPN that connects both devices.', releaseTitle: 'Release notes',
    releaseInfo: 'Available in Simplified Chinese, Traditional Chinese and English. The macOS app is locally signed and awaits notarization. The Windows app is unsigned.',
    administration: 'Sign in as an administrator and choose Manage users to create invites or approve accounts.',
    privacy: 'The host can cancel an invitation or end a session at any time. Tools with permission to observe the screen, processes or network may still identify remote control.'
  }
};
const languageButtons = Array.from(document.querySelectorAll('[data-language]'));

function setLanguage(locale) {
  const language = Object.hasOwn(messages, locale) ? locale : 'en';
  document.documentElement.lang = language;
  languageButtons.forEach(button => {
    button.setAttribute('aria-pressed', String(button.dataset.language === language));
  });
  document.querySelectorAll('[data-i18n]').forEach(node => {
    node.textContent = messages[language][node.dataset.i18n];
  });
  document.querySelectorAll('[data-label]').forEach(node => {
    node.setAttribute('aria-label', messages[language][node.dataset.label]);
  });
  try { localStorage.setItem('cc-connect-language', language); } catch {}
}

const browserLanguage = navigator.language || 'en';
let language = browserLanguage.startsWith('zh')
  ? (/TW|HK|Hant/i.test(browserLanguage) ? 'zh-TW' : 'zh-CN')
  : 'en';
try { language = localStorage.getItem('cc-connect-language') || language; } catch {}
setLanguage(language);
languageButtons.forEach(button => {
  button.addEventListener('click', () => setLanguage(button.dataset.language));
});
