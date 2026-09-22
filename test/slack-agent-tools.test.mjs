import assert from 'node:assert/strict'
import http from 'node:http'
import { test } from 'node:test'
import { jobTokens } from '../src/chatgpt.mjs'
import { toolBroker } from '../src/tools.mjs'
import { slackTools, slackService } from '../src/slack-tools.mjs'
import { validate } from '../src/local-mcp.mjs'

const request = { user: 'U1', team: 'T1', channel: 'C1', threadTs: '1.000001', isDM: false }
const bot = { userId: 'UBOT' }
async function setup(t, { req = request, channel = {}, api, limits } = {}) {
  const calls = []
  const sk = { call: async (method, args) => {
    calls.push({ method, args })
    if (api) return api(method, args)
    if (method === 'conversations.info') return { channel: { id: args.channel, is_channel: true, is_member: true, ...channel } }
    if (method === 'conversations.members') return { members: ['U1'] }
    return { ok: true, channel: args.channel, ts: '2.000001' }
  } }
  const secret = Buffer.from('test-secret'), jobs = jobTokens(secret)
  const tools = slackTools({ sk, req, bot })
  const job = { tools: ['slack'], slack: { tools } }
  const token = jobs.issue(60_000, 'T1/C1/1.000001', job)
  const server = http.createServer(toolBroker({ secret, jobs, policy: {}, limits }))
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  t.after(() => { server.closeAllConnections(); server.close() })
  const call = (msg, auth = token, method = 'POST') => fetch(`http://127.0.0.1:${server.address().port}/mcp/slack`, { method,
    headers: { authorization: `Bearer ${auth}`, 'content-type': 'application/json' },
    ...(method === 'POST' ? { body: typeof msg === 'string' ? msg : JSON.stringify(msg) } : {}),
  })
  const invoke = async (name, args = {}) => (await (await call(rpc('tools/call', { name, arguments: args }))).json()).result
  return { call, invoke, job, jobs, calls, tools, token }
}
const rpc = (method, params = {}) => ({ jsonrpc: '2.0', id: 1, method, params })
const post = { channel: 'CDEST', text: 'A useful update', thread_ts: '1.000001' }

test('Slack MCP discovers reusable tools without exposing implementation or credentials', async (t) => {
  const c = await setup(t)
  const init = await (await c.call(rpc('initialize', { protocolVersion: '2025-03-26' }))).json()
  assert.equal(init.result.protocolVersion, '2025-03-26')
  assert.equal((await c.call({ jsonrpc: '2.0', method: 'notifications/initialized' })).status, 202)
  const list = (await (await c.call(rpc('tools/list'))).json()).result.tools
  assert.ok(list.some((t) => t.name === 'post_message'))
  assert.ok(list.every((t) => !('run' in t) && t.inputSchema.additionalProperties === false))
  assert.ok(!list.some((t) => t.name === 'search'))
  assert.deepEqual(slackService(c.tools).tools, list.map((t) => t.name))
  assert.equal(c.job.toolCalls, 0)
})

test('Slack MCP refuses missing, revoked, expired, GitHub and ungranted capabilities', async (t) => {
  const c = await setup(t)
  const expired = c.jobs.issue(-1000, 'x', c.job)
  const revoked = c.jobs.issue(60_000, 'x', c.job); c.jobs.revoke(revoked)
  for (const token of ['', 'bad', expired, revoked]) assert.equal((await c.call(rpc('tools/list'), token)).status, 403)
  for (const job of [{}, { tools: ['slack'] }, { slack: c.job.slack }]) assert.equal((await c.call(rpc('tools/list'), c.jobs.issue(60_000, 'acme/app#1', job))).status, 404)
  assert.deepEqual(c.calls, [])
})

test('Slack MCP rejects malformed messages, unknown methods, and extra identity/API fields', async (t) => {
  const c = await setup(t)
  for (const body of ['x', [rpc('ping')], { method: 'ping', id: 1 }, { jsonrpc: '2.0', method: 'tools/call', params: { name: 'post_message', arguments: post } }]) assert.equal((await c.call(body)).status, 400)
  assert.equal((await c.call('x'.repeat(70_000))).status, 413)
  assert.equal((await c.call(null, c.token, 'GET')).status, 405)
  assert.equal((await (await c.call(rpc('resources/read'))).json()).error.code, -32601)
  for (const args of [{ ...post, token: 'x' }, { ...post, username: 'someone' }, { ...post, channel: '../C1' }, { ...post, thread_ts: '1' }, { ...post, text: '' }]) assert.equal((await c.invoke('post_message', args)).isError, true)
  assert.equal((await c.invoke('delete_channel')).isError, true)
  assert.equal(validate({ type: 'integer', minimum: 1, maximum: 100 }, 1000), 'Integer outside allowed range.')
  assert.deepEqual(c.calls, [])
})

test('Slack MCP posts as the bot, caches concurrent duplicates and records one change', async (t) => {
  const c = await setup(t)
  const results = await Promise.all([c.invoke('post_message', post), c.invoke('post_message', { text: post.text, thread_ts: post.thread_ts, channel: post.channel })])
  assert.equal(results[0].isError, false)
  assert.deepEqual(results[0], results[1])
  assert.deepEqual(c.calls.map((c) => c.method), ['conversations.info', 'chat.postMessage'])
  assert.deepEqual(c.calls[1].args, { ...post, unfurl_links: false, unfurl_media: false })
  assert.deepEqual(c.job.writes, ['Slack post_message'])
})

test('Slack tools reject external, nonmember, archived and unrelated DM destinations', async (t) => {
  for (const channel of [{ is_ext_shared: true }, { is_member: false }, { is_archived: true }, { is_channel: false }, { is_im: true }]) await t.test(JSON.stringify(channel), async (t) => {
    const c = await setup(t, { channel })
    assert.equal((await c.invoke('post_message', post)).isError, true)
    assert.deepEqual(c.calls.map((c) => c.method), ['conversations.info'])
  })
})

test('Slack tools require requester membership for private reads and writes', async (t) => {
  const c = await setup(t, { req: { ...request, channel: 'D1', isDM: true }, api: async (method, args) => method === 'conversations.info' ? { channel: { id: args.channel, is_member: true, is_group: true } } : { members: ['UOTHER'] } })
  assert.equal((await c.invoke('read_thread', { channel: 'GPRIVATE', ts: '1.000001' })).isError, true)
  assert.equal((await c.invoke('post_message', { ...post, channel: 'GPRIVATE' })).isError, true)
  assert.ok(c.calls.some((c) => c.method === 'conversations.members'))
  assert.ok(!c.calls.some((c) => c.method === 'conversations.replies'))
  assert.ok(!c.calls.some((c) => c.method === 'chat.postMessage'))
})

test('private contents enter only their own channel session or the requester’s DM', async (t) => {
  const shared = await setup(t, { channel: { is_private: true } })
  assert.match((await shared.invoke('read_history', { channel: 'COTHER' })).content[0].text, /in a DM/)
  assert.equal((await shared.invoke('read_history', { channel: 'C1' })).isError, false)
  const dm = await setup(t, { req: { ...request, channel: 'D1', isDM: true }, channel: { is_private: true } })
  assert.equal((await dm.invoke('read_thread', { channel: 'COTHER', ts: '1.000001' })).isError, false)
})

test('Slack tools allow this request’s DM, bound reads, and interaction-scoped public search', async (t) => {
  const c = await setup(t, { req: { ...request, channel: 'D1', isDM: true, actionToken: 'controller-only-action' } })
  await c.invoke('read_history', { channel: 'D1' })
  assert.deepEqual(c.calls[0], { method: 'conversations.history', args: { channel: 'D1', limit: 100 } })
  await c.invoke('search', { query: 'project decisions' })
  assert.deepEqual(c.calls[1].args, { query: 'project decisions', action_token: 'controller-only-action', channel_types: 'public_channel', include_context_messages: true, limit: 20 })
  assert.doesNotMatch(JSON.stringify((await (await c.call(rpc('tools/list'))).json())), /controller-only-action/)
})

test('Slack MCP caches ambiguous failures and stops additional writes at the budget', async (t) => {
  const c = await setup(t, { limits: { maxCalls: 4, maxWrites: 1 }, api: async (method, args) => {
    if (method === 'conversations.info') return { channel: { id: args.channel, is_member: true, is_channel: true } }
    throw new Error('Lost response; check the destination before retrying.')
  } })
  assert.equal((await c.invoke('post_message', post)).isError, true)
  await c.invoke('post_message', post)
  assert.equal(c.calls.filter((c) => c.method === 'chat.postMessage').length, 1)
  c.job.writes.push('Linear save_issue')
  assert.match((await c.invoke('post_message', { ...post, text: 'next' })).content[0].text, /budget/)
  await c.invoke('channel_info', { channel: 'C1' })
  assert.match((await c.invoke('channel_info', { channel: 'C1' })).content[0].text, /budget/)
})

test('Slack MCP rechecks revocation after a lookup, before posting', async (t) => {
  let started, release
  const entered = new Promise((r) => { started = r }), barrier = new Promise((r) => { release = r })
  const c = await setup(t, { api: async (method, args) => {
    assert.equal(method, 'conversations.info')
    started(); await barrier
    return { channel: { id: args.channel, is_channel: true, is_member: true } }
  } })
  const pending = c.invoke('post_message', post)
  await entered; c.jobs.revoke(c.token); release()
  assert.equal((await pending).isError, true)
  assert.equal(c.calls.length, 1)
  assert.deepEqual(c.job.writes, [])
})
