'use strict';
const messages = {
  'zh-CN': {
    release: '0.3.0 预览版', category: '远程桌面', downloads: '下载',
    macRequirements: 'macOS 13+ · Apple Silicon / Intel', winRequirements: 'Windows 10+ · x64',
    sourceCode: 'GitHub 开源', winFormat: '安装程序 · x64', updates: '可在应用内检查更新。Windows 安装程序会更新现有安装。',
    downloadMac: '下载 macOS', downloadWin: '下载 Windows', connectTitle: '如何连接',
    step1: '两台电脑分别打开 CC Connect。', step2: '被控端选择「共享此机」，将配对码发给另一端。', step3: '另一端粘贴配对码，被控端确认后开始连接。',
    permission: '远程操作需要被控端勾选键鼠权限。', networkTitle: '连接设置',
    networkLan: '同一局域网或可互访的 VPN 内，设置留空即可。',
    networkWan: '跨公网时，两端填写同一个 WSS 配对服务地址。无法直连时，再填写 TURN 中继地址、用户名和密码。这些值由你部署的服务或服务提供方给出。',
    networkStatus: '此版本需配置自己的公网服务。', releaseTitle: '版本说明',
    releaseInfo: '支持简体中文、繁体中文与英文。macOS 包为本地签名，尚未公证。Windows 包尚未签名。',
    verification: '本机双端配对、测试画面传输与断开已验证。Windows 实机键鼠操作和真实跨公网性能仍待验证。',
    privacy: '每次共享需要本机确认。具备本机屏幕、进程或网络观察权限的工具仍可能识别远控。'
  },
  'zh-TW': {
    release: '0.3.0 預覽版', category: '遠端桌面', downloads: '下載',
    macRequirements: 'macOS 13+ · Apple Silicon / Intel', winRequirements: 'Windows 10+ · x64',
    sourceCode: 'GitHub 開源', winFormat: '安裝程式 · x64', updates: '可在應用程式內檢查更新。Windows 安裝程式會更新現有安裝。',
    downloadMac: '下載 macOS', downloadWin: '下載 Windows', connectTitle: '如何連線',
    step1: '兩台電腦分別開啟 CC Connect。', step2: '受控端選擇「分享此機」，將配對碼傳給另一端。', step3: '另一端貼上配對碼，受控端確認後開始連線。',
    permission: '遠端操作需要受控端勾選鍵盤與滑鼠權限。', networkTitle: '連線設定',
    networkLan: '在同一區域網路或可互相存取的 VPN 內，設定留白即可。',
    networkWan: '跨網際網路時，兩端填入同一個 WSS 配對服務位址。無法直接連線時，再填入 TURN 中繼位址、使用者名稱和密碼。這些值由你部署的服務或服務供應商提供。',
    networkStatus: '此版本需要設定自己的網際網路服務。', releaseTitle: '版本說明',
    releaseInfo: '支援簡體中文、繁體中文與英文。macOS 套件為本機簽署，尚未經過公證。Windows 套件尚未簽署。',
    verification: '已驗證本機雙端配對、測試畫面傳輸與中斷連線。Windows 實機鍵鼠操作和真實跨網效能仍待驗證。',
    privacy: '每次分享都需要本機確認。具備本機螢幕、程序或網路觀察權限的工具仍可能辨識遠端控制。'
  },
  en: {
    release: '0.3.0 Preview', category: 'Remote desktop', downloads: 'Downloads',
    macRequirements: 'macOS 13+ · Apple Silicon / Intel', winRequirements: 'Windows 10+ · x64',
    sourceCode: 'Open source on GitHub', winFormat: 'Installer · x64', updates: 'Check for updates in the app. The Windows installer updates your existing installation.',
    downloadMac: 'Get for Mac', downloadWin: 'Get for Windows', connectTitle: 'Connect your computers',
    step1: 'Open CC Connect on both computers.', step2: 'On the host, choose “Share this computer” and send the pairing code to the other computer.', step3: 'Paste the code on the other computer. Approve the request on the host to connect.',
    permission: 'Enable keyboard and mouse access on the host for remote control.', networkTitle: 'Connection settings',
    networkLan: 'Leave settings empty on the same local network or a VPN where both computers can reach each other.',
    networkWan: 'Across the internet, enter the same WSS pairing service address on both computers. If a direct connection fails, add a TURN relay address, username and password. Get these values from your own deployment or your service provider.',
    networkStatus: 'This version requires your own internet pairing service.', releaseTitle: 'Release notes',
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
