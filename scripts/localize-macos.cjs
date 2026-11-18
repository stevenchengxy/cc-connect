const fs = require('node:fs/promises')
const path = require('node:path')

module.exports = async context => {
  if (context.electronPlatformName !== 'darwin') return
  const resources = path.join(context.appOutDir, 'CC Connect.app', 'Contents', 'Resources')
  const descriptions = {
    en: [
      'CC Connect uses your local network to pair with a computer you invite.',
      'CC Connect shares the selected display after you approve the connection.'
    ],
    'zh-Hans': [
      'CC Connect 使用本地网络与您邀请的电脑配对。',
      'CC Connect 在您确认共享后向已配对的设备传送选定屏幕。'
    ],
    'zh-Hant': [
      'CC Connect 使用區域網路與您邀請的電腦配對。',
      'CC Connect 在您確認分享後向已配對的裝置傳送選定螢幕。'
    ]
  }
  for (const [locale, [network, capture]] of Object.entries(descriptions)) {
    const folder = path.join(resources, locale + '.lproj')
    await fs.mkdir(folder, { recursive: true })
    await fs.writeFile(path.join(folder, 'InfoPlist.strings'),
      '"NSLocalNetworkUsageDescription" = ' + JSON.stringify(network) + ';\n' +
      '"NSScreenCaptureUsageDescription" = ' + JSON.stringify(capture) + ';\n')
  }
}
