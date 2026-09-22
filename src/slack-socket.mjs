// Slack Socket Mode — how Slack events reach the controller. The controller dials out: it asks
// slack.com for a connection URL with the app-level token (apps.connections.open) and opens a
// WebSocket to it. So nothing about Slack needs a public URL, and the token — a BoxLite secret
// placeholder in the deployed controller — only ever goes to slack.com. Every envelope is acked the
// moment it arrives (Slack redelivers what isn't acked within seconds); the event is handled after.
//
// Slack retires each connection every few hours (a `disconnect` message: `warning` ~10 s ahead, or
// `refresh_requested`) and allows up to 10 at once. So a replacement is dialled first, and the old
// connection is closed only once the new one says hello: no event falls into the gap. The
// browser-style WebSocket API shows no pings, so a connection silent for `idleMs` is replaced the
// same way — a dead TCP link would otherwise leave the bot deaf without anyone noticing.

/**
 * `open()` → { url } (apps.connections.open with the app token); `onEvent(payload)` gets each
 * Events API payload; `onStatus(line | null)` hears when the bot can't be reached from Slack.
 */
export function socketMode({ open, onEvent, onStatus = () => {}, log = () => {}, WebSocketImpl = globalThis.WebSocket, idleMs = 30 * 60_000, helloMs = 30_000, retryMs = 2000, maxRetryMs = 60_000 }) {
  let current = null // the live connection
  let pending = null // dialled, waiting for its hello
  let stopped = true
  let failures = 0
  let retryTimer = null
  let watchdog = null
  const sockets = new Set() // every open WebSocket, the one being retired included

  function retryLater() {
    if (stopped || retryTimer || pending) return
    retryTimer = setTimeout(() => {
      retryTimer = null
      dial()
    }, Math.min(maxRetryMs, retryMs * 2 ** failures++))
  }

  async function dial() {
    if (stopped || pending) return
    const conn = { ws: null, lastFrame: Date.now(), helloTimer: null }
    pending = conn
    let ws
    try {
      const { url } = await open()
      if (stopped) return void (pending = null)
      ws = new WebSocketImpl(url)
    } catch (e) {
      log(`slack: can't open a Socket Mode connection: ${e.message}`)
      onStatus(`can't connect to Slack (${e.message}) — retrying`)
      pending = null
      return retryLater()
    }
    conn.ws = ws
    sockets.add(ws)
    conn.helloTimer = setTimeout(() => ws.close(), helloMs) // no hello: give up on this one
    ws.onmessage = ({ data }) => receive(conn, data)
    ws.onerror = () => {} // onclose follows
    ws.onclose = () => closed(conn)
  }

  function closed(conn) {
    clearTimeout(conn.helloTimer)
    sockets.delete(conn.ws)
    if (conn === pending) {
      pending = null
      retryLater()
    } else if (conn === current) {
      current = null
      if (stopped) return
      log('slack: connection closed; reconnecting')
      retryLater()
    }
  }

  function receive(conn, data) {
    conn.lastFrame = Date.now()
    let msg
    try {
      msg = JSON.parse(String(data))
    } catch {
      return
    }
    if (msg.envelope_id) {
      try {
        conn.ws.send(JSON.stringify({ envelope_id: msg.envelope_id })) // ack first, whatever happens next
      } catch (e) {
        log(`slack: ack failed (${e.message}); Slack will redeliver, and a message is handled once`)
      }
      if (msg.type === 'events_api') {
        Promise.resolve()
          .then(() => onEvent(msg.payload))
          .catch((e) => log(`slack: event handler: ${e.stack || e.message}`))
      }
      return
    }
    if (msg.type === 'hello' && conn === pending) {
      clearTimeout(conn.helloTimer)
      pending = null
      failures = 0
      const old = current
      current = conn
      old?.ws.close() // retired only now that its replacement is live
      onStatus(null)
      // Our own count is 2 while one is being retired; more means someone else holds this app's token.
      if (msg.num_connections > sockets.size) log(`slack: ${msg.num_connections} Socket Mode connections are open for this app — another controller (or a dev run) is receiving some of the events`)
    } else if (msg.type === 'disconnect') {
      if (msg.reason === 'link_disabled') onStatus("Socket Mode is off for this Slack app — turn it on in the app's settings (Socket Mode)")
      else if (conn === current) dial() // warning / refresh_requested: dial the replacement now
    }
  }

  return {
    start() {
      stopped = false
      dial()
      watchdog = setInterval(() => {
        if (!current || pending || Date.now() - current.lastFrame < idleMs) return
        log(`slack: nothing heard for ${Math.round(idleMs / 60_000)} min; replacing the connection`)
        current.lastFrame = Date.now()
        dial()
      }, Math.max(1, Math.min(idleMs / 4, 60_000)))
    },
    stop() {
      stopped = true
      clearInterval(watchdog)
      clearTimeout(retryTimer)
      if (pending) clearTimeout(pending.helloTimer)
      for (const ws of sockets) ws.close()
    },
    get live() {
      return Boolean(current)
    },
  }
}
