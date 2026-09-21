import assert from 'node:assert/strict'
import { test } from 'node:test'
import { boxlite } from '../src/boxlite.mjs'

// A scripted stand-in for the global WebSocket: records what the client sends, then plays the
// server's frames once the client has sent stdin EOF.
function fakeWs(script) {
  const made = []
  class FakeWS {
    constructor(url, opts) {
      this.url = url
      this.opts = opts
      this.sent = []
      made.push(this)
      queueMicrotask(() => this.onopen?.())
    }
    send(data) {
      this.sent.push(data)
      if (typeof data === 'string' && JSON.parse(data).type === 'stdin_eof') queueMicrotask(() => script(this))
    }
    close() {
      queueMicrotask(() => this.onclose?.())
    }
  }
  return { FakeWS, made }
}
const frame = (channel, text) => Uint8Array.from([channel, ...Buffer.from(text)]).buffer

test('attach: auth header, stdin then EOF, demuxed output, resolves with the exit code', async () => {
  const { FakeWS, made } = fakeWs((ws) => {
    ws.onmessage({ data: frame(0x01, 'out-1\n') })
    ws.onmessage({ data: frame(0x02, 'err-1\n') })
    ws.onmessage({ data: frame(0x01, 'out-2\n') })
    ws.onmessage({ data: JSON.stringify({ type: 'exit', exit_code: 3 }) })
    ws.close()
  })
  const bl = boxlite('blk_test', { WebSocketImpl: FakeWS })
  const out = []
  const err = []
  const code = await bl.attach('box-1', 'ex-1', { stdin: 'hello', onStdout: (b) => out.push(String(b)), onStderr: (b) => err.push(String(b)), timeoutMs: 5000 })

  assert.equal(code, 3)
  assert.equal(made[0].url, 'wss://api.boxlite.ai/v1/boxes/box-1/executions/ex-1/attach')
  assert.deepEqual(made[0].opts, { headers: { Authorization: 'Bearer blk_test' } })
  assert.equal(String(made[0].sent[0]), 'hello')
  assert.deepEqual(JSON.parse(made[0].sent[1]), { type: 'stdin_eof' })
  assert.deepEqual(out, ['out-1\n', 'out-2\n'])
  assert.deepEqual(err, ['err-1\n'])
})

test('attach: a close without an exit, or a server error, rejects', async () => {
  const early = boxlite('k', { WebSocketImpl: fakeWs((ws) => ws.close()).FakeWS })
  await assert.rejects(early.attach('b', 'e', { timeoutMs: 5000 }), /closed before the exec exited/)
  const failing = boxlite('k', {
    WebSocketImpl: fakeWs((ws) => {
      ws.onmessage({ data: JSON.stringify({ type: 'error', message: 'exec not found' }) })
      ws.close()
    }).FakeWS,
  })
  await assert.rejects(failing.attach('b', 'e', { timeoutMs: 5000 }), /exec error: exec not found/)
})

test('REST: base url, bearer auth, JSON body; 404 lookup → null; errors carry the status', async () => {
  const calls = []
  const fetchImpl = async (url, init) => {
    calls.push({ url, init })
    if (url.endsWith('/v1/boxes/missing')) return { ok: false, status: 404, text: async () => '' }
    if (url.endsWith('/v1/boxes')) return { ok: false, status: 408, text: async () => 'still starting' }
    return { ok: true, status: 200, json: async () => ({ id: 'box-1' }) }
  }
  const bl = boxlite('blk_test', { fetchImpl })
  assert.equal(await bl.getBox('missing'), null)
  assert.deepEqual(await bl.getBox('botlite-abc'), { id: 'box-1' })
  assert.equal(calls[1].url, 'https://api.boxlite.ai/v1/boxes/botlite-abc')
  assert.equal(calls[1].init.headers.Authorization, 'Bearer blk_test')
  const err = await bl.createBox({ name: 'x' }).catch((e) => e)
  assert.equal(err.status, 408)
  assert.match(err.message, /POST \/v1\/boxes → 408: still starting/)
  assert.deepEqual(JSON.parse(calls[2].init.body), { name: 'x' })
})
