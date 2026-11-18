'use strict';
const messages = {
  'zh-CN': {
    release: '0.3.2 预览版', category: '远程桌面', downloads: '下载',
    macRequirements: 'macOS 13+ · Apple Silicon / Intel', winRequirements: 'Windows 10+ · x64',
    sourceCode: 'GitHub 开源', winFormat: '安装程序 · x64', updates: '可在应用内检查更新。Windows 安装程序会更新现有安装。',
    downloadMac: '下载 macOS', downloadWin: '下载 Windows', connectTitle: '如何连接',
    step1: '两台电脑都更新至 0.3.2 或更高版本。', step2: '在共享端重新生成配对码，发给另一端。', step3: '另一端粘贴配对码，被控端确认后开始连接。',
    permission: '远程操作需要被控端勾选键鼠权限。', networkTitle: '连接设置',
    networkLan: '两端的设置留空即可自动配对，包括不同网络的电脑。',
    networkWan: '画面默认尝试直连。若已配对但始终没有画面，可使用可互访的 VPN，或在设置中填写 TURN 中继。',
    networkStatus: '公共配对服务尚未配置 TURN。已有自建 WSS 的用户可继续使用原设置。', releaseTitle: '版本说明',
    releaseInfo: '支持简体中文、繁体中文与英文。macOS 包为本地签名，尚未公证。Windows 包尚未签名。',
    verification: '本机双端配对、测试画面传输与断开已验证。Windows 实机键鼠操作和真实跨公网性能仍待验证。',
    privacy: '每次共享需要本机确认。具备本机屏幕、进程或网络观察权限的工具仍可能识别远控。'
  },
  'zh-TW': {
    release: '0.3.2 預覽版', category: '遠端桌面', downloads: '下載',
    macRequirements: 'macOS 13+ · Apple Silicon / Intel', winRequirements: 'Windows 10+ · x64',
    sourceCode: 'GitHub 開源', winFormat: '安裝程式 · x64', updates: '可在應用程式內檢查更新。Windows 安裝程式會更新現有安裝。',
    downloadMac: '下載 macOS', downloadWin: '下載 Windows', connectTitle: '如何連線',
    step1: '兩台電腦都更新至 0.3.2 或更新版本。', step2: '在分享端重新產生配對碼，傳給另一端。', step3: '另一端貼上配對碼，受控端確認後開始連線。',
    permission: '遠端操作需要受控端勾選鍵盤與滑鼠權限。', networkTitle: '連線設定',
    networkLan: '兩端的設定留白即可自動配對，包括不同網路的電腦。',
    networkWan: '畫面預設嘗試直接連線。若已配對卻一直沒有畫面，可使用能互相連線的 VPN，或在設定中填入 TURN 中繼。',
    networkStatus: '公共配對服務尚未設定 TURN。已有自建 WSS 的使用者可繼續使用原設定。', releaseTitle: '版本說明',
    releaseInfo: '支援簡體中文、繁體中文與英文。macOS 套件為本機簽署，尚未經過公證。Windows 套件尚未簽署。',
    verification: '已驗證本機雙端配對、測試畫面傳輸與中斷連線。Windows 實機鍵鼠操作和真實跨網效能仍待驗證。',
    privacy: '每次分享都需要本機確認。具備本機螢幕、程序或網路觀察權限的工具仍可能辨識遠端控制。'
  },
  en: {
    release: '0.3.2 Preview', category: 'Remote desktop', downloads: 'Downloads',
    macRequirements: 'macOS 13+ · Apple Silicon / Intel', winRequirements: 'Windows 10+ · x64',
    sourceCode: 'Open source on GitHub', winFormat: 'Installer · x64', updates: 'Check for updates in the app. The Windows installer updates your existing installation.',
    downloadMac: 'Get for Mac', downloadWin: 'Get for Windows', connectTitle: 'Connect your computers',
    step1: 'Update both computers to 0.3.2 or later.', step2: 'Generate a new pairing code on the host and send it to the other computer.', step3: 'Paste the code on the other computer. Approve the request on the host to connect.',
    permission: 'Enable keyboard and mouse access on the host for remote control.', networkTitle: 'Connection settings',
    networkLan: 'Leave settings empty to pair automatically, even across different networks.',
    networkWan: 'Video uses a direct connection when possible. If pairing succeeds but video cannot connect, use a VPN that connects both computers or enter a TURN relay in settings.',
    networkStatus: 'The public pairing service currently has no TURN relay. Existing self-hosted WSS settings still work.', releaseTitle: 'Release notes',
    releaseInfo: 'Available in Simplified Chinese, Traditional Chinese and English. The macOS app is locally signed and awaits notarization. The Windows app is unsigned.',
    verification: 'Pairing, synthetic video delivery and disconnect were tested with two local app instances. Windows hardware input and real cross-network performance still require testing.',
    privacy: 'Every session requires approval on the host. Tools with permission to observe the screen, processes or network may still identify remote control.'
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
