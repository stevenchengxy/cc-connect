const { contextBridge, ipcRenderer } = require('electron')

const call = name => (...args) => ipcRenderer.invoke('jianping:' + name, ...args).catch(error => {
  const message = String(error.message).replace(/^Error invoking remote method .*?: (?:Error: )?/, '')
  throw new Error(message)
})
contextBridge.exposeInMainWorld('jianping', {
  info: call('info'),
  login: call('account-login'),
  register: call('account-register'),
  refreshAccount: call('account-refresh'),
  logout: call('account-logout'),
  openAdminConsole: call('open-admin-console'),
  renewIce: call('renew-ice'),
  setLanguage: call('language'),
  checkUpdate: call('check-update'),
  downloadUpdate: call('download-update'),
  installUpdate: call('install-update'),
  host: call('host'),
  join: call('join'),
  accept: call('accept'),
  reject: call('reject'),
  screens: call('screens'),
  screenStatus: call('screen-status'),
  screenStreamReady: call('screen-stream-ready'),
  openInputSettings: call('open-input-settings'),
  openScreenSettings: call('open-screen-settings'),
  armSystemPicker: call('arm-system-picker'),
  disarmSystemPicker: call('disarm-system-picker'),
  signal: call('signal'),
  filePick: call('file-pick'),
  fileSave: call('file-save'),
  fileRead: call('file-read'),
  fileWrite: call('file-write'),
  fileSentDigest: call('file-sent-digest'),
  fileCommit: call('file-commit'),
  fileCancel: call('file-cancel'),
  input: payload => ipcRenderer.send('jianping:input', payload),
  disconnect: call('disconnect'),
  copy: call('copy'),
  settings: call('settings'),
  saveSettings: call('settings'),
  onEvent(listener) {
    const handle = (_event, update) => listener(update)
    ipcRenderer.on('jianping:event', handle)
    return () => ipcRenderer.removeListener('jianping:event', handle)
  }
})
