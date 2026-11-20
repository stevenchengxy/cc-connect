const fs = require('node:fs/promises')
const path = require('node:path')

module.exports = async context => {
  if (context.electronPlatformName !== 'darwin') return
  const resources = path.join(context.appOutDir, 'CC Connect.app', 'Contents', 'Resources')
  // The universal merger rewrites nested Info.plist files with Electron ASAR
  // metadata. Restore the plist sealed by the native screen helper's signature.
  const screenPlist = path.join('native', 'bin', 'CC Connect Screen.app', 'Contents', 'Info.plist')
  await fs.copyFile(path.join(__dirname, '..', screenPlist), path.join(resources, screenPlist))
  const descriptions = {
    en: [
      'CC Connect uses your local network to pair with a computer you invite.',
      'CC Connect captures the display you choose and shares it with the device you authorize.'
    ],
    'zh-Hans': [
      'CC Connect 使用本地网络与您邀请的电脑配对。',
      'CC Connect 采集您选择的屏幕，并与您授权的设备共享画面。'
    ],
    'zh-Hant': [
      'CC Connect 使用區域網路與您邀請的電腦配對。',
      'CC Connect 擷取您選擇的螢幕，並與您授權的裝置分享畫面。'
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
