import assert from 'node:assert/strict'
import { test } from 'node:test'
import { slackChannel } from '../src/slack-channel.mjs'
import { shareChannel, shareFailure } from '../src/slack-share.mjs'
import { requestFromEvent } from '../src/slack-events.mjs'

const bot = { userId: 'UBOT', url: 'https://acme.slack.com/' }
const target = { channel: 'CDEST', language: 'zh' }
const event = (over = {}) => ({
  type: 'app_mention', user: 'U1', channel: 'CSOURCE', ts: '1712345699.000200', thread_ts: '1712345678.000100',
  text: '<@UBOT> 把这个群分享给 #CDEST', ...over,
})
const payload = (over = {}, extra = {}) => ({ team_id: 'T1', event: event(over), ...extra })
const req = requestFromEvent(payload(), bot)
const destination = { id: target.channel, is_channel: true, is_member: true, is_archived: false, is_ext_shared: false }

test('shareChannel: send only the source channel link, as a new destination message, then confirm', async () => {
  for (const language of ['zh', 'en']) {
    const calls = []
    const sk = { call: async (method, params) => {
      calls.push({ method, params })
      return method === 'conversations.info' ? { channel: destination } : { ts: '2.000001' }
    } }
    const result = await shareChannel(sk, req, { ...target, language }, bot)
    assert.equal(result.shared, true)
    assert.match(result.message, /<#CSOURCE>.*<#CDEST>/)
    assert.deepEqual(calls.map((c) => c.method), ['conversations.info', 'chat.postMessage'])
    assert.deepEqual(calls[0].params, { channel: target.channel })
    assert.deepEqual(calls[1].params, {
      channel: target.channel,
      text: language === 'zh'
        ? '<@U1> 分享了频道：<#CSOURCE>\n<https://acme.slack.com/archives/CSOURCE|打开频道>'
        : '<@U1> shared <#CSOURCE>\n<https://acme.slack.com/archives/CSOURCE|Open channel>',
      unfurl_links: false, unfurl_media: false,
    })
    assert.ok(!('thread_ts' in calls[1].params)) // the source thread doesn't exist in the destination
  }
})

test('shareChannel: DMs and sharing back to the source need no API call', async () => {
  const sk = { call: () => assert.fail('must not call Slack') }
  for (const r of [{ ...req, isDM: true }, { ...req, channel: target.channel }]) {
    assert.equal((await shareChannel(sk, r, target, bot)).shared, false)
  }
})

test('shareChannel: inaccessible, archived, external and non-channel destinations never receive a message', async () => {
  for (const channel of [
    undefined,
    { ...destination, id: 'COTHER' },
    { ...destination, is_member: false },
    { ...destination, is_archived: true },
    { ...destination, is_ext_shared: true },
    { ...destination, is_channel: false },
    { ...destination, is_im: true },
    { ...destination, is_mpim: true },
  ]) {
    const sk = { call: async (method) => {
      assert.equal(method, 'conversations.info', JSON.stringify(channel))
      return { channel }
    } }
    const result = await shareChannel(sk, req, target, bot)
    assert.equal(result.shared, false)
    assert.ok(result.message)
  }
})

test('shareFailure: Slack errors explain recovery; an ambiguous network failure never claims success', () => {
  for (const [code, words] of [
    ['not_in_channel', /邀请/], ['channel_not_found', /频道 ID/], ['missing_scope', /重新安装/],
    ['is_archived', /归档/], ['restricted_action', /不允许/], ['no_permission', /不允许/],
    [undefined, /未能确认/],
  ]) {
    assert.match(shareFailure({ code }, target), words)
    assert.ok(shareFailure({ code }, { ...target, language: 'en' }))
  }
})

// Run real event acceptance, policy, scheduling and Web API serialization against a fake Slack.
// Unexpected calls are recorded too: a share must not read a transcript, download files or run Codex.
async function controller(t, { user = {}, info = {}, fail = () => null, dailyLimit = 0, usage = {}, draining = () => false } = {}) {
  const calls = []
  const logs = []
  const sockets = []
  const scheduled = []
  const pending = []
  const saved = []
  const commands = []
  let turns = 0
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    assert.equal(new URL(url).origin, 'https://slack.com')
    const method = new URL(url).pathname.split('/').at(-1)
    const params = Object.fromEntries(new URLSearchParams(init.body))
    calls.push({ method, params })
    const error = fail(method, params)
    let body
    if (error) body = { ok: false, error }
    else switch (method) {
      case 'auth.test': body = { user_id: bot.userId, user: 'boxliteai', bot_id: 'BBOT', team_id: 'T1', team: 'Acme', url: bot.url }; break
      case 'apps.connections.open': body = { url: 'wss://slack.test/' }; break
      case 'users.info': body = { user: { id: 'U1', team_id: 'T1', name: 'alice', ...user } }; break
      case 'conversations.info': body = { channel: { ...destination, ...info } }; break
      case 'conversations.replies': body = { messages: [] }; break
      case 'chat.postMessage':
      case 'chat.postEphemeral':
      case 'reactions.add': body = { ts: '1712345700.000001' }; break
      default: throw new Error(`unexpected Slack method: ${method}`)
    }
    return new Response(JSON.stringify({ ok: true, ...body }), { headers: { 'content-type': 'application/json' } })
  })
  t.mock.method(globalThis, 'WebSocket', function () {
    const socket = { send() {}, close() {} }
    sockets.push(socket)
    return socket
  })
  const state = { seen: new Set(), threads: {}, usage, deferred: [] }
  const channel = await slackChannel({
    tokens: { bot: 'fake-bot', app: 'fake-app' }, cfg: { boxDeleteSec: 900, slackDailyLimit: dailyLimit },
    slackState: state, persist: () => saved.push(structuredClone(state)), draining,
    schedule: (key, work) => { scheduled.push(key); return Promise.resolve().then(work) },
    track: (p) => pending.push(p), jobs: { issue: () => { turns++; throw new Error('model turn reached') } },
    logins: {}, policy: {}, status: () => {}, log: (line) => logs.push(line),
    prs: { status: async () => ({ ok: false, why: 'not configured' }) },
    commands: { run: async (cmd, options) => { commands.push(cmd); await options.post('command handled') } },
  })
  t.after(() => channel.stop())
  const flush = async () => {
    await new Promise(setImmediate)
    await channel.settle()
    await Promise.all(pending)
  }
  channel.start()
  await flush()
  return {
    calls, logs, state, saved, scheduled, commands, channel, flush, turns: () => turns,
    async deliver(p = payload()) {
      sockets.at(-1).onmessage({ data: JSON.stringify({ type: 'events_api', envelope_id: 'envelope', payload: p }) })
      await flush()
    },
  }
}

test('controller: sharing sends once, confirms in its thread, and never starts a box', async (t) => {
  const c = await controller(t, { dailyLimit: 5 })
  await c.deliver()
  await c.deliver() // Slack redelivery
  const posts = c.calls.filter((call) => call.method === 'chat.postMessage')
  assert.equal(posts.length, 2)
  assert.equal(posts[0].params.channel, target.channel)
  assert.equal(posts[0].params.thread_ts, undefined)
  assert.equal(posts[1].params.channel, req.channel)
  assert.equal(posts[1].params.thread_ts, req.threadTs)
  assert.match(posts[1].params.text, /^已将/)
  assert.equal(c.calls.filter((call) => call.method === 'conversations.info').length, 1)
  assert.ok(!c.calls.some((call) => call.method === 'conversations.replies'))
  assert.equal(c.turns(), 0)
  assert.equal(c.state.usage.U1.count, 1)
  assert.ok(c.state.seen.has(req.id))
  assert.equal(c.saved.at(-1).usage.U1.count, 1) // survives restart even without a model turn
  assert.deepEqual(c.state.threads, {})
  assert.deepEqual(c.scheduled, [`T1/${req.channel}/${req.threadTs}`])
})

test('controller: /share and Slack channel mentions bypass the admin-command dispatcher', async (t) => {
  for (const text of ['<@UBOT> /share <#CDEST|general>', '<@UBOT> share this channel to <#CDEST|general>']) {
    await t.test(text, async (t) => {
      const c = await controller(t, { dailyLimit: 5 })
      await c.deliver(payload({ text }))
      assert.equal(c.calls.filter((call) => call.method === 'chat.postMessage' && call.params.channel === target.channel).length, 1)
      assert.deepEqual(c.commands, [])
      assert.equal(c.state.usage.U1.count, 1)
      assert.equal(c.turns(), 0)
    })
  }
})

test('controller: member policy and quota still run before sharing', async (t) => {
  for (const [name, options, p] of [
    ['guest', { user: { is_restricted: true } }, payload()],
    ['outsider', { user: { team_id: 'TOTHER' } }, payload()],
    ['Slack Connect source', {}, payload({}, { is_ext_shared_channel: true })],
    ['daily quota', { dailyLimit: 1, usage: { U1: { day: new Date().toISOString().slice(0, 10), count: 1 } } }, payload({ text: '<@UBOT> /share #CDEST' })],
  ]) await t.test(name, async (t) => {
    const c = await controller(t, options)
    await c.deliver(p)
    assert.ok(c.calls.some((call) => call.method === 'chat.postEphemeral'))
    assert.ok(!c.calls.some((call) => call.method === 'chat.postMessage' || call.method === 'conversations.info'))
    assert.equal(c.turns(), 0)
    assert.deepEqual(c.scheduled, [])
  })
})

test('controller: API failures are reported in the original thread without success or a model fallback', async (t) => {
  for (const [method, code, message] of [
    ['conversations.info', 'missing_scope', /重新安装/],
    ['conversations.info', 'channel_not_found', /频道 ID/],
    ['chat.postMessage', 'not_in_channel', /邀请/],
    ['chat.postMessage', 'restricted_action', /不允许/],
  ]) await t.test(code, async (t) => {
    const c = await controller(t, { fail: (m, p) => m === method && p.channel === target.channel ? code : null })
    await c.deliver()
    const confirmations = c.calls.filter((call) => call.method === 'chat.postMessage' && call.params.channel === req.channel)
    assert.equal(confirmations.length, 1)
    assert.equal(confirmations[0].params.thread_ts, req.threadTs)
    assert.match(confirmations[0].params.text, message)
    assert.doesNotMatch(confirmations[0].params.text, /^已将/)
    if (method === 'conversations.info') assert.ok(!c.calls.some((call) => call.method === 'chat.postMessage' && call.params.channel === target.channel))
    assert.equal(c.turns(), 0)
  })
})

test('controller: a failed confirmation and event redelivery never resend the destination message', async (t) => {
  const c = await controller(t, { fail: (method, params) => method === 'chat.postMessage' && params.channel === req.channel ? 'channel_not_found' : null })
  await c.deliver()
  await c.deliver()
  assert.equal(c.calls.filter((call) => call.method === 'chat.postMessage' && call.params.channel === target.channel).length, 1)
  assert.ok(c.logs.some((line) => /share to .*: sent$/.test(line)))
})

test('controller: a share received while draining is deferred once and handled on restart', async (t) => {
  let draining = true
  const c = await controller(t, { draining: () => draining })
  await c.deliver()
  await c.deliver()
  assert.equal(c.state.deferred.length, 1)
  assert.equal(c.state.seen.size, 0)
  assert.deepEqual(c.scheduled, [])
  c.channel.stop()
  draining = false
  c.channel.start()
  await c.flush()
  assert.equal(c.state.deferred.length, 0)
  assert.equal(c.calls.filter((call) => call.method === 'chat.postMessage' && call.params.channel === target.channel).length, 1)
  assert.equal(c.turns(), 0)
})

test('controller: asking to implement sharing stays a coding request', async (t) => {
  const c = await controller(t)
  await c.deliver(payload({ text: '<@UBOT> 实现把这个群分享给 #CDEST 的功能' }))
  assert.equal(c.turns(), 1)
  assert.ok(!c.calls.some((call) => call.method === 'chat.postMessage' && call.params.channel === target.channel))
})

test('controller: admin commands and help retain their existing dispatch', async (t) => {
  const c = await controller(t, { user: { is_admin: true } })
  await c.deliver(payload({ text: '<@UBOT> /model' }))
  assert.deepEqual(c.commands, [{ name: 'model', arg: '' }])
  await c.deliver(payload({ text: '<@UBOT> help', ts: '1712345701.000001' }))
  const help = c.calls.filter((call) => call.method === 'chat.postMessage').at(-1).params.text
  assert.match(help, /share this channel/)
  assert.match(help, /PRs: not now/)
  assert.match(help, /As an admin/)
  assert.equal(c.turns(), 0)
  assert.deepEqual(c.scheduled, [])
})
