const fs = require('node:fs')
const path = require('node:path')

module.exports = async context => {
  const filename = context.electronPlatformName === 'win32' ? 'jianping-input.exe' : 'jianping-input'
  const helper = path.join(__dirname, '..', 'native', 'bin', filename)
  if (!fs.existsSync(helper)) throw new Error('打包前需要构建对应平台的键鼠组件：' + filename)
}
