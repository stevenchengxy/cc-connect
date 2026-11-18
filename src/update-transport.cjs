// Electron's network stack shares the desktop's system proxy and certificate store.
// Each request performs exactly one hop; the updater validates any redirect itself.
function systemUpdateTransport(net, session, idleTimeout = 25000) {
  return (url, { signal }) => new Promise((resolve, reject) => {
    signal.throwIfAborted()
    const req = net.request({
      url, session, method: 'GET', redirect: 'manual', credentials: 'omit',
      cache: 'no-store', referrerPolicy: 'no-referrer', headers: { 'Accept-Encoding': 'identity' }
    })
    let incoming
    let timer
    let done = false
    function cleanup() {
      done = true
      clearTimeout(timer)
      signal.removeEventListener('abort', abort)
    }
    function abort() {
      if (done) return
      cleanup()
      const error = new Error('Update request interrupted')
      incoming?.destroy(error)
      req.abort()
      reject(error)
    }
    function armTimer() {
      clearTimeout(timer)
      timer = setTimeout(abort, idleTimeout)
      timer.unref()
    }
    signal.addEventListener('abort', abort, { once: true })
    req.on('error', abort)
    req.once('redirect', (statusCode, _method, location) => {
      cleanup()
      req.abort()
      resolve({ statusCode, headers: { location }, destroy() {} })
    })
    req.once('response', response => {
      incoming = response
      response.on('error', () => {}) // The async iterator propagates stream errors.
      armTimer()
      resolve({
        statusCode: response.statusCode,
        headers: response.headers,
        destroy: abort,
        async *[Symbol.asyncIterator]() {
          try {
            for await (const chunk of response) {
              armTimer()
              yield chunk
            }
          } finally {
            // Iterator consumers can stop early (e.g. failed bounds/integrity check).
            if (!response.readableEnded) abort()
            cleanup()
          }
        }
      })
    })
    armTimer()
    req.end()
  })
}
module.exports = { systemUpdateTransport }
