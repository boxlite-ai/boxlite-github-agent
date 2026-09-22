import assert from 'node:assert/strict'
import { test } from 'node:test'
import { socketMode } from '../src/slack-socket.mjs'

// A scripted Slack: every apps.connections.open hands out a new ticket, every WebSocket is kept
// so the test can play server messages on it (`server`) or drop it.
function fakeSlack({ failOpens = 0 } = {}) {
  const sockets = []
  class FakeWS {
    constructor(url) {
      this.url = url
      this.sent = []
      this.closed = false
      sockets.push(this)
    }
    send(data) {
      this.sent.push(JSON.parse(data))
    }
    close() {
      if (this.closed) return
      this.closed = true
      queueMicrotask(() => this.onclose?.())
    }
    server(msg) {
      this.onmessage({ data: JSON.stringify(msg) })
    }
  }
  let opens = 0
  const open = async () => {
    if (++opens <= failOpens) throw new Error('slack apps.connections.open: invalid_auth')
    return { url: `wss://wss.slack.test/link/?ticket=${opens}` }
  }
  return { FakeWS, sockets, open, opens: () => opens }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
async function until(cond, what = 'condition') {
  for (let i = 0; i < 200; i++) {
    if (cond()) return
    await sleep(5)
  }
  throw new Error(`timed out waiting for ${what}`)
}
const hello = (n = 1) => ({ type: 'hello', num_connections: n, debug_info: { approximate_connection_time: 18060 } })
const envelope = (id, type = 'events_api', payload = { event: { type: 'app_mention' } }) => ({ envelope_id: id, type, payload, accepts_response_payload: false })

test('socket: every envelope is acked at once; Events API payloads go to onEvent', async () => {
  const slack = fakeSlack()
  const events = []
  const s = socketMode({ open: slack.open, onEvent: (p) => events.push(p), WebSocketImpl: slack.FakeWS })
  s.start()
  await until(() => slack.sockets.length === 1)
  const [ws] = slack.sockets
  assert.equal(ws.url, 'wss://wss.slack.test/link/?ticket=1')
  ws.server(hello())
  assert.equal(s.live, true)
  ws.server(envelope('e-1', 'events_api', { event_id: 'Ev1' }))
  ws.server(envelope('e-2', 'slash_commands', { command: '/x' }))
  ws.server({ type: 'unknown' })
  ws.onmessage({ data: 'not json' })
  assert.deepEqual(ws.sent, [{ envelope_id: 'e-1' }, { envelope_id: 'e-2' }])
  await until(() => events.length === 1, 'the event')
  assert.deepEqual(events, [{ event_id: 'Ev1' }])
  s.stop()
})

test('socket: a refresh dials the replacement first; the old connection closes only once it says hello', async () => {
  const slack = fakeSlack()
  const events = []
  const s = socketMode({ open: slack.open, onEvent: (p) => events.push(p.n), WebSocketImpl: slack.FakeWS })
  s.start()
  await until(() => slack.sockets.length === 1)
  const [old] = slack.sockets
  old.server(hello())
  old.server({ type: 'disconnect', reason: 'refresh_requested' })
  await until(() => slack.sockets.length === 2, 'the replacement')
  const [, fresh] = slack.sockets
  assert.equal(old.closed, false) // still listening while the replacement comes up
  old.server(envelope('e-1', 'events_api', { n: 1 }))
  fresh.server(hello(2))
  assert.equal(old.closed, true)
  fresh.server(envelope('e-2', 'events_api', { n: 2 }))
  await until(() => events.length === 2, 'both events')
  assert.deepEqual(events, [1, 2]) // nothing fell into the gap
  assert.equal(s.live, true)
  s.stop()
})

test('socket: a dropped connection is redialled; a failing open is retried and reported', async () => {
  const slack = fakeSlack({ failOpens: 1 })
  const statuses = []
  const s = socketMode({ open: slack.open, onEvent: () => {}, onStatus: (l) => statuses.push(l), WebSocketImpl: slack.FakeWS, retryMs: 1 })
  s.start()
  await until(() => slack.sockets.length === 1, 'a connection after the failed open')
  assert.match(statuses[0], /can't connect to Slack \(slack apps\.connections\.open: invalid_auth\)/)
  slack.sockets[0].server(hello())
  assert.equal(statuses.at(-1), null) // connected: nothing to report
  slack.sockets[0].close() // Slack went away without a word
  await until(() => slack.sockets.length === 2, 'a redial')
  assert.equal(s.live, false)
  slack.sockets[1].server(hello())
  assert.equal(s.live, true)
  s.stop()
})

test('socket: Socket Mode switched off is reported', async () => {
  const slack = fakeSlack()
  const statuses = []
  const s = socketMode({ open: slack.open, onEvent: () => {}, onStatus: (l) => statuses.push(l), WebSocketImpl: slack.FakeWS, retryMs: 1000 })
  s.start()
  await until(() => slack.sockets.length === 1)
  slack.sockets[0].server(hello())
  slack.sockets[0].server({ type: 'disconnect', reason: 'link_disabled' })
  assert.match(statuses.at(-1), /Socket Mode is off for this Slack app/)
  s.stop()
})

test('socket: no hello in time → that connection is dropped and another dialled', async () => {
  const slack = fakeSlack()
  const s = socketMode({ open: slack.open, onEvent: () => {}, WebSocketImpl: slack.FakeWS, helloMs: 10, retryMs: 1 })
  s.start()
  await until(() => slack.sockets.length === 2, 'a second attempt')
  assert.equal(slack.sockets[0].closed, true)
  s.stop()
})

test('socket: a connection silent for too long is replaced the same make-before-break way', async () => {
  const slack = fakeSlack()
  const logs = []
  const s = socketMode({ open: slack.open, onEvent: () => {}, WebSocketImpl: slack.FakeWS, idleMs: 20, log: (l) => logs.push(l) })
  s.start()
  await until(() => slack.sockets.length === 1)
  slack.sockets[0].server(hello())
  await until(() => slack.sockets.length === 2, 'a replacement for the quiet one')
  assert.equal(slack.sockets[0].closed, false)
  slack.sockets[1].server(hello(2))
  assert.equal(slack.sockets[0].closed, true)
  assert.ok(logs.some((l) => /nothing heard/.test(l)))
  s.stop()
})

test('socket: someone else holding a connection for this app is logged; stop closes everything for good', async () => {
  const slack = fakeSlack()
  const logs = []
  const s = socketMode({ open: slack.open, onEvent: () => {}, WebSocketImpl: slack.FakeWS, retryMs: 1, log: (l) => logs.push(l) })
  s.start()
  await until(() => slack.sockets.length === 1)
  slack.sockets[0].server(hello(3))
  assert.ok(logs.some((l) => /3 Socket Mode connections are open/.test(l)))
  s.stop()
  assert.equal(slack.sockets[0].closed, true)
  await sleep(20)
  assert.equal(slack.sockets.length, 1) // no redial after stop
  assert.equal(slack.opens(), 1)
})
