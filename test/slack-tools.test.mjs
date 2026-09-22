import assert from 'node:assert/strict'
import http from 'node:http'
import { test } from 'node:test'
import { jobTokens } from '../src/chatgpt.mjs'
import { toolBroker } from '../src/tools.mjs'

const rpc = (method, params = {}) => ({ jsonrpc: '2.0', id: 1, method, params })
const share = (target = 'CDEST', extra = {}) => rpc('tools/call', { name: 'share_channel', arguments: { target_channel_id: target, ...extra } })
const success = { shared: true, message: 'Shared the link.' }
async function setup(t, { shareChannel = async () => success, limits } = {}) {
  const secret = Buffer.from('test-job-secret')
  const jobs = jobTokens(secret)
  const seen = []
  const job = { tools: ['slack'], slack: { shareChannel: async (id) => { seen.push(id); return shareChannel(id) } } }
  const token = jobs.issue(60_000, 'T1/CSOURCE/1.000001', job)
  const server = http.createServer(toolBroker({ secret, jobs, logins: {}, policy: {}, limits }))
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  t.after(() => { server.closeAllConnections(); server.close() })
  const call = (msg, auth = token, method = 'POST') => fetch(`http://127.0.0.1:${server.address().port}/mcp/slack`, {
    method, headers: { authorization: `Bearer ${auth}`, 'content-type': 'application/json' },
    ...(method === 'POST' ? { body: typeof msg === 'string' ? msg : JSON.stringify(msg) } : {}),
  })
  const result = async (msg) => (await (await call(msg)).json()).result
  return { call, result, seen, jobs, job, token }
}

test('Slack MCP: initialize, notify, ping and discover the one channel-sharing tool', async (t) => {
  const c = await setup(t)
  const init = await c.result(rpc('initialize', { protocolVersion: '2025-03-26' }))
  assert.equal(init.protocolVersion, '2025-03-26')
  assert.deepEqual(init.capabilities, { tools: {} })
  assert.equal((await c.call({ jsonrpc: '2.0', method: 'notifications/initialized' })).status, 202)
  assert.deepEqual(await c.result(rpc('ping')), {})
  const list = await c.result(rpc('tools/list'))
  assert.equal(list.tools.length, 1)
  assert.equal(list.tools[0].name, 'share_channel')
  assert.deepEqual(list.tools[0].inputSchema.required, ['target_channel_id'])
  assert.equal(list.tools[0].inputSchema.additionalProperties, false)
  assert.deepEqual(c.seen, [])
  assert.equal(c.job.toolCalls, 0)
})

test('Slack MCP: only a live token with a controller-bound capability gets access', async (t) => {
  const c = await setup(t)
  const revoked = c.jobs.issue(60_000, 'T1/CSOURCE/2.000001', c.job)
  c.jobs.revoke(revoked)
  const expired = c.jobs.issue(-1000, 'T1/CSOURCE/3.000001', c.job)
  for (const token of ['', 'bad.token.sig', revoked, expired]) {
    assert.equal((await c.call(share(), token)).status, 403)
  }
  for (const job of [{}, { tools: ['slack'] }, { slack: c.job.slack }]) {
    const token = c.jobs.issue(60_000, 'acme/app#7', job)
    assert.equal((await c.call(share(), token)).status, 404)
  }
  assert.deepEqual(c.seen, [])
})

test('Slack MCP: malformed requests, unknown tools and source/text overrides cannot post', async (t) => {
  const c = await setup(t)
  for (const msg of ['not json', [share()], { method: 'tools/list', id: 1 }, { ...share(), id: null }, { jsonrpc: '2.0', method: 'tools/call', params: share().params }]) {
    assert.equal((await c.call(msg)).status, 400)
  }
  assert.equal((await c.call('x'.repeat(70_000))).status, 413)
  assert.equal((await c.call(null, c.token, 'GET')).status, 405)
  assert.equal((await (await c.call(rpc('resources/read'))).json()).error.code, -32601)
  for (const msg of [
    rpc('tools/call', { name: 'post_message' }), share('D123'), share('#general'), share('C1/../C2'),
    share('CDEST', { source_channel_id: 'COTHER' }), share('CDEST', { text: 'forward this' }),
    rpc('tools/call', { name: 'share_channel', arguments: null }),
  ]) assert.equal((await c.result(msg)).isError, true)
  assert.deepEqual(c.seen, [])
  assert.deepEqual(c.job.writes, [])
})

test('Slack MCP: concurrent duplicates post once, return the same result, and record one change', async (t) => {
  const c = await setup(t)
  const answers = await Promise.all(Array.from({ length: 5 }, () => c.result(share())))
  for (const answer of answers) assert.deepEqual(answer, { content: [{ type: 'text', text: success.message }], isError: false })
  assert.deepEqual(c.seen, ['CDEST'])
  assert.deepEqual(c.job.writes, ['Slack share_channel'])
  // The same job may be reissued after losing a model session: its cache survives that retry.
  c.jobs.revoke(c.token)
  const retry = c.jobs.issue(60_000, 'T1/CSOURCE/1.000001', c.job)
  assert.equal((await (await c.call(share(), retry)).json()).result.isError, false)
  assert.deepEqual(c.seen, ['CDEST'])
})

test('Slack MCP: refusals and ambiguous failures are cached, never counted as successful writes', async (t) => {
  for (const [shareChannel, message] of [
    [async () => ({ shared: false, message: 'The destination is archived.' }), /archived/],
    [async () => { throw Object.assign(new Error('scope'), { code: 'missing_scope' }) }, /reinstall/],
    [async () => { throw new Error('lost response') }, /couldn.t confirm/],
  ]) await t.test(String(message), async (t) => {
    const c = await setup(t, { shareChannel })
    for (let i = 0; i < 2; i++) {
      const answer = await c.result(share())
      assert.equal(answer.isError, true)
      assert.match(answer.content[0].text, message)
    }
    assert.deepEqual(c.seen, ['CDEST'])
    assert.deepEqual(c.job.writes, [])
  })
})

test('Slack MCP: serial writes respect call and write budgets, with cached success at the write limit', async (t) => {
  const c = await setup(t, { limits: { maxCalls: 3, maxWrites: 1 } })
  const answers = await Promise.all([c.result(share()), c.result(share('COTHER')), c.result(share())])
  assert.equal(answers[0].isError, false)
  assert.match(answers[1].content[0].text, /used up the changes/)
  assert.equal(answers[2].isError, false)
  assert.match((await c.result(share('CTHIRD'))).content[0].text, /used up its tool calls/)
  assert.deepEqual(c.seen, ['CDEST'])
  assert.deepEqual(c.job.writes, ['Slack share_channel'])
})

test('Slack MCP: a call queued before revocation cannot start afterward', async (t) => {
  const c = await setup(t)
  let release
  c.job.slack.queue = new Promise((r) => { release = r })
  let queued
  const received = new Promise((r) => { queued = r })
  // Observe the handler attaching work behind the barrier, without timing-dependent sleeps.
  const barrier = c.job.slack.queue
  barrier.then = (...args) => { queued(); return Promise.prototype.then.apply(barrier, args) }
  const pending = c.result(share())
  await received
  c.jobs.revoke(c.token)
  release()
  assert.match((await pending).content[0].text, /no longer active/)
  assert.deepEqual(c.seen, [])
})

test('Slack MCP: separate jobs have separate bound sources and destination caches', async (t) => {
  const c = await setup(t)
  const otherCalls = []
  const other = { tools: ['slack'], slack: { shareChannel: async (id) => { otherCalls.push(id); return success } } }
  const token = c.jobs.issue(60_000, 'T1/COTHER/1.000001', other)
  await c.result(share())
  await c.call(share(), token)
  assert.deepEqual(c.seen, ['CDEST'])
  assert.deepEqual(otherCalls, ['CDEST'])
  assert.deepEqual(other.writes, ['Slack share_channel'])
})
