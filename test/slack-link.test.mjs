import assert from 'node:assert/strict'
import { test } from 'node:test'
import { slackChannel } from '../src/slack-channel.mjs'

test('a non-admin links only themselves through a private reply, without a Codex turn or quota', async (t) => {
  const calls = []
  const bound = []
  const begin = async (service, user) => {
    bound.push([service, user])
    if (!['linear', 'notion', 'google'].includes(service)) throw new Error('Use /link linear or /link notion.')
    return { url: 'https://controller.example/private-link', label: service === 'google' ? 'Google Workspace' : service === 'notion' ? 'Notion' : 'Linear' }
  }
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    const method = new URL(url).pathname.split('/').pop()
    const params = Object.fromEntries(new URLSearchParams(init.body))
    calls.push({ method, params })
    const data = method === 'auth.test' ? { user_id: 'UBOT', team_id: 'T1', user: 'boxliteai' }
      : method === 'users.info' ? { user: { id: params.user, team_id: 'T1', is_restricted: params.user === 'UGUEST' } }
        : method === 'apps.connections.open' ? { url: 'wss://slack.example' } : {}
    return Response.json({ ok: true, ...data })
  })
  let opened
  const ready = new Promise((r) => { opened = r })
  const original = globalThis.WebSocket
  globalThis.WebSocket = class {
    constructor() { queueMicrotask(() => opened(this)) }
    send() {}
    close() { this.onclose?.() }
  }
  t.after(() => { globalThis.WebSocket = original })
  const state = { seen: new Set(), deferred: [], usage: {} }
  const channel = await slackChannel({
    tokens: { bot: 'test', app: 'test' }, cfg: { boxDeleteSec: 900, slackDailyLimit: 1 }, slackState: state,
    persist() {}, draining: () => false, log() {}, status() {},
    schedule: () => assert.fail('linking must not start a turn'), commands: { run: () => assert.fail('linking must not require an admin') },
    links: { begin },
  })
  t.after(() => channel.stop())
  channel.start()
  const ws = await ready
  async function message(user, text, isDM = false) {
    const ts = `${calls.length}.000001`
    ws.onmessage({ data: JSON.stringify({ type: 'events_api', envelope_id: ts, payload: { team_id: 'T1', event: { type: isDM ? 'message' : 'app_mention', channel_type: isDM ? 'im' : 'channel', channel: isDM ? 'D1' : 'C1', user, ts, text } } }) })
    await Promise.resolve() // Socket Mode delivers after acknowledging the envelope
    await channel.settle()
  }
  await message('U1', '<@UBOT> /link linear')
  assert.deepEqual(bound, [['linear', 'U1']])
  assert.deepEqual(calls.at(-1), { method: 'chat.postEphemeral', params: { channel: 'C1', user: 'U1', text: '<https://controller.example/private-link|Connect your Linear account>. This private link expires in 10 minutes. Only you can use this connection.' } })
  await message('U2', '/link linear', true)
  assert.deepEqual(bound, [['linear', 'U1'], ['linear', 'U2']])
  await message('U2', '<@UBOT> /link notion')
  assert.deepEqual(bound.at(-1), ['notion', 'U2'])
  assert.match(calls.at(-1).params.text, /Connect your Notion account/)
  assert.equal(calls.at(-1).params.user, 'U2')
  await message('U1', '<@UBOT> /link google')
  assert.deepEqual(bound.at(-1), ['google', 'U1'])
  assert.match(calls.at(-1).params.text, /Connect your Google Workspace account/)
  await message('U1', '<@UBOT> /link linear U2')
  await message('UGUEST', '<@UBOT> /link linear')
  assert.equal(bound.filter(([service]) => service === 'notion').length, 1)
  assert.equal(bound.some(([, user]) => user === 'UGUEST'), false)
  assert.equal(calls.some((c) => c.method === 'chat.postMessage'), false)
  assert.deepEqual(state.usage, {})
})
