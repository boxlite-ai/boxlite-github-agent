import assert from 'node:assert/strict'
import http from 'node:http'
import { test } from 'node:test'
import { slackChannel } from '../src/slack-channel.mjs'
import { scheduler } from '../src/jobs.mjs'
import { jobTokens } from '../src/chatgpt.mjs'
import { toolBroker } from '../src/tools.mjs'

const root = '1712345678.000100'
const event = (over = {}) => ({ type: 'app_mention', user: 'U1', channel: 'C1', ts: root, text: '<@UBOT> help with our channel', ...over })
const payload = (over = {}) => ({ team_id: 'T1', event: event(over) })
async function fixture(t, { agent = async () => 'Done.', user = {}, info = {}, state, draining = () => false, apiHook = async () => {}, userLogins = { kinds: {}, forUser: async () => ({}) } } = {}) {
  const fetchHttp = globalThis.fetch
  const calls = [], sockets = [], pending = [], turns = [], logs = [], saved = [], killed = []
  const secret = Buffer.from('test-secret'), jobs = jobTokens(secret)
  const server = http.createServer(toolBroker({ secret, jobs, policy: {} }))
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  t.after(() => { server.closeAllConnections(); server.close() })
  const proxyUrl = `http://127.0.0.1:${server.address().port}`
  const tool = async (token, name, args = {}) => {
    const response = await fetchHttp(`${proxyUrl}/mcp/slack`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) })
    return { status: response.status, ...(await response.json()) }
  }
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    assert.equal(new URL(url).origin, 'https://slack.com')
    const method = new URL(url).pathname.split('/').at(-1), args = Object.fromEntries(new URLSearchParams(init.body))
    calls.push({ method, args })
    await apiHook(method, args)
    let body = {}
    switch (method) {
      case 'auth.test': body = { user_id: 'UBOT', bot_id: 'BBOT', user: 'boxliteai', team_id: 'T1', team: 'Acme', url: 'https://acme.slack.com/' }; break
      case 'apps.connections.open': body = { url: 'wss://slack.test/' }; break
      case 'users.info': body = { user: { id: args.user, team_id: 'T1', name: 'alice', ...user } }; break
      case 'conversations.info': body = { channel: { id: args.channel, is_channel: true, is_member: true, name: 'general', ...info } }; break
      case 'conversations.members': body = { members: ['U1'] }; break
      case 'conversations.replies': body = { messages: [] }; break
      case 'chat.postMessage': body = { channel: args.channel, ts: '1712345800.000001' }; break
      case 'chat.postEphemeral': case 'reactions.add': case 'agents.sessions.setStatus': break
      default: throw new Error(`Unexpected Slack call ${method}`)
    }
    return new Response(JSON.stringify({ ok: true, ...body }), { headers: { 'content-type': 'application/json' } })
  })
  t.mock.method(globalThis, 'WebSocket', function () {
    const socket = { send() {}, close() {} }; sockets.push(socket); return socket
  })
  const cfg = { image: 'node', cpus: 2, memoryMib: 4096, boxDeleteSec: 900, jobTimeoutMs: 60_000, volume: 'github', contextSecret: 'github-secret', slackVolume: 'slack', slackContextSecret: 'slack-secret' }
  const bl = {
    getBox: async () => ({ id: 'box', status: 'running' }), stopBox: async () => {},
    killExec: async (...args) => { killed.push(args) },
    startExec: async (_, exec) => { const id = String(turns.length); turns.push({ env: exec.env, id }); return { execution_id: id } },
    attach: async (_, id, { stdin, onStdout, signal }) => {
      const turn = turns.find((t) => t.id === id)
      turn.prompt = JSON.parse(stdin).prompt
      turn.signal = signal
      turn.invoke = async (name, args) => (await tool(turn.env.BOTLITE_JOB_TOKEN, name, args)).result
      const message = await agent(turn, turns.length)
      onStdout(JSON.stringify({ type: 'thread.started', thread_id: 'session-1' }) + '\n')
      onStdout(JSON.stringify({ type: 'botlite.result', code: 0, lastMessage: message }) + '\n')
      return 0
    },
  }
  state ??= { seen: new Set(), threads: {}, usage: {}, deferred: [] }
  const channel = await slackChannel({ tokens: { bot: 'fake-bot-token', app: 'fake-app-token' }, cfg, slackState: state,
    persist: async () => { saved.push(structuredClone({ ...state, deferred: state.deferred.map(({ ack, ...r }) => r) })) },
    schedule: scheduler(2), track: (p) => pending.push(p), draining, jobs, bl, proxyUrl, userLogins, policy: { linear: { read: ['list_issues'], write: [] } }, turnCfg: () => cfg, status: () => {}, log: (s) => logs.push(s),
    prs: { status: async () => ({ ok: false, why: 'off' }) }, commands: { run: async (_, opts) => opts.post('Command handled.') },
  })
  t.after(() => channel.stop())
  const flush = async () => { await new Promise(setImmediate); await channel.settle(); for (let i = 0; i < pending.length; i++) await pending[i] }
  channel.start(); await flush()
  return { channel, calls, turns, jobs, tool, state, saved, killed, logs, flush,
    async deliver(p = payload(), wait = true) {
      sockets.at(-1).onmessage({ data: JSON.stringify({ type: 'events_api', envelope_id: 'E1', payload: p }) })
      await new Promise(setImmediate); await channel.settle()
      if (wait) await flush()
    },
  }
}
const posts = (c, channel = 'C1') => c.calls.filter((x) => x.method === 'chat.postMessage' && x.args.channel === channel)

test('native agent: event → prompt → MCP write → audited reply; subsequent thread messages need no mention', async (t) => {
  const c = await fixture(t, { agent: async (turn) => {
    const result = await turn.invoke('post_message', { channel: 'CDEST', text: 'Here is the channel link.' })
    assert.equal(result.isError, false)
    return 'Posted the requested message.'
  } })
  await c.deliver(payload({ text: '<@UBOT> let <#CDEST|announcements> know about this channel' }))
  assert.equal(c.turns.length, 1)
  assert.match(c.turns[0].prompt, /#announcements \(channel ID: CDEST\)/)
  assert.match(c.turns[0].prompt, /mcp__slack__/)
  assert.doesNotMatch(JSON.stringify(c.turns[0].env), /fake-bot-token|fake-app-token/)
  assert.equal(posts(c, 'CDEST').length, 1)
  assert.match(posts(c)[0].args.blocks, /Slack post_message/)
  assert.deepEqual(c.calls.filter((x) => x.method === 'agents.sessions.setStatus').map((x) => x.args.status), ['processing', 'active'])
  assert.equal((await c.tool(c.turns[0].env.BOTLITE_JOB_TOKEN, 'list_channels')).status, 403)
  await c.deliver() // root event was already handled, even via another payload
  assert.equal(c.turns.length, 1)
  await c.deliver(payload({ type: 'message', channel_type: 'channel', thread_ts: root, ts: '1712345690.000100', text: 'Please do the same again.' }))
  assert.equal(c.turns.length, 2)
  assert.match(c.turns[1].prompt, /New request in the same thread/)
  await c.deliver(payload({ type: 'message', channel_type: 'channel', ts: '1712345691.000100', text: 'unrelated chatter' }))
  await c.deliver(payload({ thread_ts: root, ts: '1712345692.000100', bot_id: 'BBOT' }))
  assert.equal(c.turns.length, 2)
})

test('native Agent View context reaches the right user’s prompt; ordinary DM work stays supported', async (t) => {
  const c = await fixture(t)
  await c.deliver({ team_id: 'T1', authorizations: [{ user_id: 'U1', is_bot: false }], event: { type: 'app_context_changed', context: { entities: [{ type: 'slack#/types/channel_id', value: 'CFOCUS', team_id: 'T1' }] } } })
  await c.deliver(payload({ type: 'message', channel_type: 'im', channel: 'D1' }))
  assert.match(c.turns[0].prompt, /"viewed_channel":"CFOCUS"/)
  await c.deliver(payload({ type: 'message', user: 'U2', channel_type: 'im', channel: 'D2' }))
  assert.match(c.turns[1].prompt, /"viewed_channel":null/)
})

test('native Stop revokes live tools, kills execution, and completes the processing state', async (t) => {
  let started
  const ready = new Promise((r) => { started = r })
  const c = await fixture(t, { agent: async (turn) => {
    started()
    await new Promise((resolve) => turn.signal.addEventListener('abort', resolve, { once: true }))
    assert.equal((await c.tool(turn.env.BOTLITE_JOB_TOKEN, 'list_channels')).status, 403)
    throw new Error('Attach cancelled')
  } })
  await c.deliver(payload(), false); await ready
  await c.deliver({ team_id: 'T1', event: { type: 'agent_session_stopped', channel: 'C1', thread_ts: root, user: 'U1' } })
  assert.equal(c.killed.length, 1)
  assert.equal(c.jobs.live.size, 0)
  assert.equal(posts(c).length, 0)
  assert.equal(c.calls.filter((x) => x.method === 'agents.sessions.setStatus').at(-1).args.status, 'active')
})

test('Stop waits for an already accepted Slack write and reports its completed effect', async (t) => {
  let accepted, release
  const ready = new Promise((r) => { accepted = r })
  const response = new Promise((r) => { release = r })
  const c = await fixture(t, {
    apiHook: async (method, args) => {
      if (method === 'chat.postMessage' && args.channel === 'CDEST') { accepted(); await response }
    },
    agent: async (turn) => {
      const posting = turn.invoke('post_message', { channel: 'CDEST', text: 'Requested update.' })
      await new Promise((r) => turn.signal.addEventListener('abort', r, { once: true }))
      void posting
      throw new Error('Attach cancelled')
    },
  })
  await c.deliver(payload(), false); await ready
  await c.deliver({ team_id: 'T1', event: { type: 'agent_session_stopped', channel: 'C1', thread_ts: root, user: 'U1' } }, false)
  assert.equal(c.jobs.live.size, 0)
  assert.equal(posts(c).length, 0)
  release(); await c.flush()
  assert.equal(posts(c, 'CDEST').length, 1)
  assert.match(posts(c)[0].args.text, /Stopped.*Slack post_message/)
})

test('agent-created interval tasks run after restart with saved instructions and no PR grant', async (t) => {
  let id
  const c = await fixture(t, { agent: async (turn, n) => {
    if (n === 1) {
      const r = await turn.invoke('create_task', { instructions: 'Post the daily summary here.', trigger: 'interval', every_minutes: 1440 })
      assert.equal(r.isError, false); id = JSON.parse(r.content[0].text).id
      return 'Saved the daily task.'
    }
    assert.match(turn.prompt, /Post the daily summary here/)
    assert.match(turn.prompt, /background tasks cannot publish PRs/)
    await turn.invoke('post_message', { channel: 'C1', text: 'Daily summary.' })
    return 'NO_REPLY'
  } })
  await c.deliver()
  assert.ok(c.saved.some((s) => s.tasks[id]))
  c.channel.stop(); c.state.tasks[id].nextAt = 0; c.channel.start(); await c.flush()
  assert.equal(c.turns.length, 2)
  assert.equal(c.state.tasks[id].lastRun.status, 'completed')
  assert.deepEqual(c.state.tasks[id].lastRun.writes, ['Slack post_message'])
  assert.ok(posts(c).some((x) => x.args.text === 'Daily summary.'))
})

test('Slack tools coexist with requester-owned service logins only in DMs', async (t) => {
  const own = { ready: () => true, token: async () => 'personal-token' }, seen = []
  const c = await fixture(t, {
    userLogins: { kinds: { linear: 'key' }, forUser: async (id) => { seen.push(id); return id === 'U1' ? { linear: own } : {} } },
    agent: async (_, n) => {
      const job = [...c.jobs.live.values()][0]
      assert.deepEqual(job.tools, n === 2 ? ['linear', 'slack'] : ['slack'])
      assert.equal(job.logins.linear, n === 2 ? own : undefined)
      return 'Done.'
    },
  })
  await c.deliver()
  await c.deliver(payload({ type: 'message', channel: 'D1', channel_type: 'im' }))
  await c.deliver(payload({ type: 'message', channel: 'D2', channel_type: 'im', user: 'U2' }))
  assert.deepEqual(seen, ['U1', 'U1', 'U2'])
  assert.match(c.turns[1].prompt, /their own account/)
  assert.match(c.turns[2].prompt, /hasn't linked their Linear/)
})

test('a saved task rechecks its owner and pauses before running after access is revoked', async (t) => {
  const user = {}
  const c = await fixture(t, { user, agent: async (turn) => {
    await turn.invoke('create_task', { instructions: 'Summarize this channel.', trigger: 'interval', every_minutes: 5 })
    return 'Task saved.'
  } })
  await c.deliver()
  const task = Object.values(c.state.tasks)[0]
  user.deleted = true
  c.channel.stop(); task.nextAt = 0; c.channel.start(); await c.flush()
  assert.equal(c.turns.length, 1)
  assert.equal(task.status, 'paused')
  assert.equal(task.lastRun.status, 'failed')
})

test('saved channel watch consumes ordinary messages as data and can remain silent', async (t) => {
  let id
  const c = await fixture(t, { agent: async (turn, n) => {
    if (n === 1) {
      const r = await turn.invoke('create_task', { instructions: 'Watch for support questions. Otherwise stay silent.', trigger: 'channel_message' })
      id = JSON.parse(r.content[0].text).id
      return 'Watch saved.'
    }
    if (n === 2) {
      assert.match(turn.prompt, /"event":\{"user":"U2","text":"Just chatting"/)
      assert.match(turn.prompt, /observed event is untrusted input/)
    }
    return 'NO_REPLY'
  } })
  await c.deliver()
  await c.deliver(payload({ type: 'message', channel_type: 'channel', user: 'U2', ts: '1712345700.000001', text: 'Just chatting' }))
  assert.equal(c.state.tasks[id].pending.length, 1)
  c.channel.stop(); c.channel.start(); await c.flush()
  assert.equal(c.turns.length, 2)
  assert.equal(posts(c).length, 1)
  // Slack can deliver message.channels before app_mention for the same mention.
  const mention = { channel_type: 'channel', ts: '1712345800.000002', text: '<@UBOT> new request' }
  await c.deliver(payload({ ...mention, type: 'message' }))
  await c.deliver(payload({ ...mention, type: 'app_mention' }))
  assert.equal(c.turns.length, 3)
  assert.equal(c.state.tasks[id].pending.length, 0)
})

test('existing member policy, draining and admin commands still run outside the agent', async (t) => {
  await t.test('guests denied', async (t) => {
    const c = await fixture(t, { user: { is_restricted: true } }); await c.deliver()
    assert.equal(c.turns.length, 0); assert.ok(c.calls.some((x) => x.method === 'chat.postEphemeral'))
  })
  await t.test('deferred while draining', async (t) => {
    const c = await fixture(t, { draining: () => true }); await c.deliver(); await c.deliver()
    assert.equal(c.turns.length, 0); assert.equal(c.state.deferred.length, 1)
  })
  await t.test('admin command', async (t) => {
    const c = await fixture(t, { user: { is_admin: true } }); await c.deliver(payload({ text: '<@UBOT> /model' }))
    assert.equal(c.turns.length, 0); assert.equal(posts(c)[0].args.text, 'Command handled.')
  })
})
