'use strict'

const permissionErrors = {
  denied: 'permission-denied',
  restricted: 'permission-restricted',
  'not-determined': 'permission-pending'
}

class ScreenCapture {
  constructor({ platform, systemVersion, getPermission, getSources }) {
    this.hasPermissionStatus = ['darwin', 'win32'].includes(platform)
    this.canUseSystemPicker = platform === 'darwin' && Number.parseInt(systemVersion, 10) >= 15
    this.getPermission = getPermission
    this.getSources = getSources
  }

  permission() {
    if (!this.hasPermissionStatus) return 'unknown'
    try {
      const value = this.getPermission('screen')
      if (['granted', 'denied', 'restricted', 'not-determined'].includes(value)) return value
    } catch {}
    return 'unknown'
  }

  async inspect(explicitCheck) {
    let permission = this.permission()
    let sources = []
    let errorCode = null
    if (permission === 'restricted' || (permissionErrors[permission] && !explicitCheck)) {
      errorCode = permissionErrors[permission]
    } else {
      try {
        sources = await this.getSources({ types: ['screen'], thumbnailSize: { width: 0, height: 0 } })
        if (!sources.length) errorCode = 'no-displays'
      } catch {
        errorCode = 'source-unavailable'
      }
      // Electron can reject before returning any sources. Read the OS decision
      // again after the request, including when a privacy prompt has just closed.
      permission = this.permission()
      if (permission === 'denied' || permission === 'restricted' || (errorCode && permission === 'not-determined')) {
        sources = []
        errorCode = permissionErrors[permission]
      }
    }
    const report = { permission, screenCount: sources.length, errorCode,
      canUseSystemPicker: this.canUseSystemPicker && permission !== 'restricted' }
    return { sources, report }
  }
}

class ScreenChoices {
  constructor(sources, displays, primaryId, revision) {
    this.revision = revision
    this.matches = new Map()
    this.options = sources.map((source, index) => {
      const display = displays.find(item => String(item.id) === source.display_id)
      this.matches.set(source.id, { source, displayId: display?.id })
      return { id: source.id, name: display?.label || source.name || ('屏幕 ' + (index + 1)),
        primary: display?.id === primaryId }
    })
  }

  select(sourceId, displays, revision) {
    const match = this.matches.get(sourceId)
    if (!match || revision !== this.revision) throw new Error('source-unavailable')
    const display = displays.find(item => item.id === match.displayId)
    if (match.displayId !== undefined && !display) throw new Error('source-unavailable')
    return { source: match.source, display }
  }
}

module.exports = { ScreenCapture, ScreenChoices, permissionErrors }
