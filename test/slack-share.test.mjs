import assert from 'node:assert/strict'
import { test } from 'node:test'
import http from 'node:http'
import { jobTokens } from '../src/chatgpt.mjs'
import { toolBroker } from '../src/tools.mjs'
import { slackChannel } from '../src/slack-channel.mjs'
import { shareChannel, shareFailure } from '../src/slack-share.mjs'
import { requestFromEvent } from '../src/slack-events.mjs'

const bot = { userId: 'UBOT', url: 'https://acme.slack.com/' }
const target = { channel: 'CDEST' }
const event = (over = {}) => ({
  type: 'app_mention', user: 'U1', channel: 'CSOURCE', ts: '1712345699.000200', thread_ts: '1712345678.000100',
  text: '<@UBOT> share this channel to #CDEST', ...over,
})
const payload = (over = {}, extra = {}) => ({ team_id: 'T1', event: event(over), ...extra })
const req = requestFromEvent(payload(), bot)
const destination = { id: target.channel, is_channel: true, is_member: true, is_archived: false, is_ext_shared: false }

test('shareChannel: send only the source channel link, as a new destination message, then confirm', async () => {
  const calls = []
  const sk = { call: async (method, params) => {
    calls.push({ method, params })
    return method === 'conversations.info' ? { channel: destination } : { ts: '2.000001' }
  } }
  const result = await shareChannel(sk, req, target, bot)
  assert.deepEqual(result, { shared: true, message: 'Shared the link to <#CSOURCE> in <#CDEST>.' })
  assert.deepEqual(calls.map((c) => c.method), ['conversations.info', 'chat.postMessage'])
  assert.deepEqual(calls[0].params, { channel: target.channel })
  assert.deepEqual(calls[1].params, {
    channel: target.channel,
    text: '<@U1> shared <#CSOURCE>\n<https://acme.slack.com/archives/CSOURCE|Open channel>',
    unfurl_links: false, unfurl_media: false,
  })
  assert.ok(!('thread_ts' in calls[1].params)) // the source thread doesn't exist in the destination
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
    ['not_in_channel', /Invite me/], ['channel_not_found', /channel ID/], ['missing_scope', /reinstall/],
    ['is_archived', /archived/], ['restricted_action', /doesn't allow/], ['no_permission', /doesn't allow/],
    [undefined, /couldn't confirm/],
  ]) {
    assert.match(shareFailure({ code }, target), words)
  }
})

// Real Socket Mode acceptance, prompts, runTurn, authenticated HTTP broker and Slack client.
// Only the BoxLite/model transport and Slack Web API are simulated; no credentials are needed.
async function controller(t, { user = {}, info = {}, fail = () => null, dailyLimit = 0, usage = {}, draining = () => false, agent, history = [] } = {}) {
  const calls = [], logs = [], sockets = [], scheduled = [], pending = [], commands = [], turns = []
  const realFetch = globalThis.fetch
  const secret = Buffer.from('test-job-secret')
  const jobs = jobTokens(secret)
  const broker = http.createServer(toolBroker({ secret, jobs, logins: {}, policy: {} }))
  await new Promise((r) => broker.listen(0, '127.0.0.1', r))
  const proxyUrl = `http://127.0.0.1:${broker.address().port}`
  t.after(() => { broker.closeAllConnections(); broker.close() })
  const tool = (token) => realFetch(`${proxyUrl}/mcp/slack`, {
    method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'share_channel', arguments: { target_channel_id: 'CDEST' } } }),
  })
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
      case 'conversations.info': body = { channel: { ...destination, id: params.channel, name: 'general', ...info } }; break
      case 'conversations.replies': body = { messages: history }; break
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
  const cfg = {
    image: 'node', cpus: 2, memoryMib: 4096, boxDeleteSec: 900, slackDailyLimit: dailyLimit,
    volume: 'botlite-context', contextSecret: 'master', jobTimeoutMs: 60_000,
    slackVolume: 'botlite-slack-context', slackContextSecret: 'slack-master',
  }
  const bl = {
    getBox: async () => ({ id: 'box-1', status: 'running' }),
    startExec: async (id, exec) => { turns.push({ env: exec.env }); return { execution_id: 'ex-1' } },
    stopBox: async () => {},
    attach: async (id, exec, { stdin, onStdout, onStderr }) => {
      const turn = turns.at(-1)
      turn.prompt = JSON.parse(stdin).prompt
      turn.call = async () => {
        const response = await tool(turn.env.BOTLITE_JOB_TOKEN)
        turn.toolStatus = response.status
        return (await response.json()).result
      }
      const message = agent ? await agent(turn) : (await turn.call()).content[0].text
      if (message === null) {
        onStderr('no rollout found for thread id\n')
        onStdout(JSON.stringify({ type: 'botlite.result', code: 1 }) + '\n')
      } else {
        onStdout(JSON.stringify({ type: 'thread.started', thread_id: 'session-1' }) + '\n')
        onStdout(JSON.stringify({ type: 'botlite.result', code: 0, lastMessage: message }) + '\n')
      }
      return 0
    },
  }
  const state = { seen: new Set(), threads: {}, usage, deferred: [] }
  const channel = await slackChannel({
    tokens: { bot: 'fake-bot', app: 'fake-app' }, cfg, turnCfg: () => cfg, bl, proxyUrl,
    slackState: state, persist: () => {}, draining,
    schedule: (key, work) => { scheduled.push(key); return Promise.resolve().then(work) },
    track: (p) => pending.push(p), jobs,
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
    calls, logs, state, scheduled, commands, channel, flush, turns, tool,
    async deliver(p = payload()) {
      sockets.at(-1).onmessage({ data: JSON.stringify({ type: 'events_api', envelope_id: 'envelope', payload: p }) })
      await flush()
    },
  }
}
const destinationPosts = (c) => c.calls.filter((call) => call.method === 'chat.postMessage' && call.params.channel === target.channel)
const replies = (c) => c.calls.filter((call) => call.method === 'chat.postMessage' && call.params.channel === req.channel)

test('controller E2E: freeform request → agent → authenticated tool → destination post → reply and audit', async (t) => {
  const c = await controller(t, { dailyLimit: 5 })
  const p = payload({ text: '<@UBOT> let <#CDEST|announcements> know about this channel' })
  await c.deliver(p)
  await c.deliver(p) // Slack redelivery
  assert.equal(c.turns.length, 1)
  assert.match(c.turns[0].prompt, /let #announcements \(channel ID: CDEST\) know/)
  assert.match(c.turns[0].prompt, /mcp__slack__share_channel/)
  assert.match(c.turns[0].env.BOTLITE_ARGS, /mcp_servers.slack/)
  assert.doesNotMatch(JSON.stringify(c.turns[0].env), /fake-bot|fake-app/)
  const posts = destinationPosts(c)
  assert.equal(posts.length, 1)
  assert.equal(posts[0].params.thread_ts, undefined)
  assert.equal(posts[0].params.text, '<@U1> shared <#CSOURCE>\n<https://acme.slack.com/archives/CSOURCE|Open channel>')
  assert.equal(replies(c).length, 1)
  assert.equal(replies(c)[0].params.thread_ts, req.threadTs)
  assert.match(replies(c)[0].params.text, /^Shared the link/)
  assert.match(replies(c)[0].params.blocks, /Changed as the bot: Slack share_channel/)
  assert.equal(c.state.usage.U1.count, 1)
  assert.equal(c.state.threads[`T1/${req.channel}/${req.threadTs}`].sessionId, 'session-1')
  assert.deepEqual(c.commands, [])
  assert.equal((await c.tool(c.turns[0].env.BOTLITE_JOB_TOKEN)).status, 403) // turn finished
})

test('controller: sharing happens only if the agent calls its tool, never by matching the request', async (t) => {
  const c = await controller(t, { agent: async () => 'Here is how sharing works.' })
  await c.deliver()
  assert.equal(c.turns.length, 1)
  assert.deepEqual(destinationPosts(c), [])
  assert.equal(replies(c)[0].params.text, 'Here is how sharing works.')
  assert.doesNotMatch(replies(c)[0].params.blocks, /Changed as the bot/)
})

test('controller: resumed context keeps channel IDs and the current tool instructions', async (t) => {
  const c = await controller(t, { history: [{ user: 'U1', ts: '1712345700.000001', text: 'Use <#CDEST|announcements>' }] })
  await c.deliver()
  await c.deliver(payload({ text: '<@UBOT> do it again', ts: '1712345701.000001' }))
  assert.equal(c.turns.length, 2)
  assert.match(c.turns[1].prompt, /New request in the same thread/)
  assert.match(c.turns[1].prompt, /Use #announcements \(channel ID: CDEST\)/)
  assert.match(c.turns[1].prompt, /mcp__slack__share_channel/)
  assert.equal(destinationPosts(c).length, 2) // a new user request can intentionally share again
})

test('controller: DMs give the agent no channel-sharing capability', async (t) => {
  let denied
  const c = await controller(t, { agent: async (turn) => { denied = await turn.call(); return 'Mention me in the channel you want to share.' } })
  await c.deliver(payload({ type: 'message', channel_type: 'im', channel: 'D1' }))
  assert.equal(c.turns.length, 1)
  assert.doesNotMatch(c.turns[0].env.BOTLITE_ARGS, /mcp_servers.slack/)
  assert.doesNotMatch(c.turns[0].prompt, /mcp__slack__/)
  assert.equal(c.turns[0].toolStatus, 404)
  assert.equal(denied, undefined) // broker returned a JSON-RPC error, no tool result
  assert.deepEqual(destinationPosts(c), [])
})

test('controller: member policy and quota still run before an agent turn', async (t) => {
  for (const [name, options, p] of [
    ['guest', { user: { is_restricted: true } }, payload()],
    ['outsider', { user: { team_id: 'TOTHER' } }, payload()],
    ['Slack Connect source', {}, payload({}, { is_ext_shared_channel: true })],
    ['daily quota', { dailyLimit: 1, usage: { U1: { day: new Date().toISOString().slice(0, 10), count: 1 } } }, payload()],
  ]) await t.test(name, async (t) => {
    const c = await controller(t, options)
    await c.deliver(p)
    assert.ok(c.calls.some((call) => call.method === 'chat.postEphemeral'))
    assert.ok(!c.calls.some((call) => call.method === 'chat.postMessage' || call.method === 'conversations.info'))
    assert.equal(c.turns.length, 0)
    assert.deepEqual(c.scheduled, [])
  })
})

test('controller: Slack failures return through the tool to the agent and original thread', async (t) => {
  for (const [method, code, message] of [
    ['conversations.info', 'missing_scope', /reinstall/],
    ['conversations.info', 'channel_not_found', /channel ID/],
    ['chat.postMessage', 'not_in_channel', /Invite me/],
    ['chat.postMessage', 'restricted_action', /doesn't allow/],
  ]) await t.test(code, async (t) => {
    const c = await controller(t, { fail: (m, p) => m === method && p.channel === target.channel ? code : null })
    await c.deliver()
    assert.equal(replies(c).length, 1)
    assert.match(replies(c)[0].params.text, message)
    assert.doesNotMatch(replies(c)[0].params.blocks, /Changed as the bot/)
    if (method === 'conversations.info') assert.equal(destinationPosts(c).length, 0)
    assert.equal(c.turns.length, 1)
  })
})

test('controller: a lost model session retries with the same share cache', async (t) => {
  let n = 0
  const c = await controller(t, { agent: async (turn) => {
    n++
    if (n === 1) return 'Ready.'
    const result = await turn.call()
    return n === 2 ? null : result.content[0].text
  } })
  await c.deliver()
  await c.deliver(payload({ ts: '1712345701.000001' }))
  assert.equal(c.turns.length, 3)
  assert.equal(destinationPosts(c).length, 1)
  assert.match(replies(c).at(-1).params.blocks, /Changed as the bot: Slack share_channel/)
})

test('controller: failed reply and event redelivery never resend the destination message', async (t) => {
  const c = await controller(t, { fail: (method, params) => method === 'chat.postMessage' && params.channel === req.channel ? 'channel_not_found' : null })
  await c.deliver()
  await c.deliver()
  assert.equal(destinationPosts(c).length, 1)
  assert.equal(c.turns.length, 1)
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
  assert.equal(destinationPosts(c).length, 1)
  assert.equal(c.turns.length, 1)
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
  assert.equal(c.turns.length, 0)
  assert.deepEqual(c.scheduled, [])
})
