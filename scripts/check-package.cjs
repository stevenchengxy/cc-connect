const fs = require('node:fs')
const path = require('node:path')

module.exports = async context => {
  const filename = context.electronPlatformName === 'win32' ? 'jianping-input.exe' : 'cc-mac-input.node'
  const helper = path.join(__dirname, '..', 'native', 'bin', filename)
  if (!fs.existsSync(helper)) throw new Error('打包前需要构建对应平台的键鼠组件：' + filename)
  if (context.electronPlatformName === 'darwin') {
    const picker = path.join(path.dirname(helper), 'CC Connect Screen.app', 'Contents', 'MacOS', 'cc-connect-screen')
    if (!fs.existsSync(picker)) throw new Error('打包前需要构建 macOS 系统屏幕选择器')
  }
}
