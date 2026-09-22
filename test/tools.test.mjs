import assert from 'node:assert/strict'
import { test, before, after } from 'node:test'
import http from 'node:http'
import { toolBroker, check, enabledServices, googleScopes, SERVICES } from '../src/tools.mjs'
import { jobTokens } from '../src/chatgpt.mjs'

// A fake vendor MCP server: records what reaches it, answers JSON or an SSE stream, hands out a
// session id and a cookie (which must never reach the box), and rejects an access token once.
const seen = []
let reject = null
const upstream = http.createServer(async (req, res) => {
  let body = ''
  for await (const c of req) body += c
  const msg = body ? JSON.parse(body) : null
  seen.push({ method: req.method, auth: req.headers.authorization, session: req.headers['mcp-session-id'], cookie: req.headers.cookie, msg })
  if (req.headers.authorization === `Bearer ${reject}`) return res.writeHead(401).end()
  if (msg?.method === 'notifications/initialized') return res.writeHead(202).end()
  const answer = { jsonrpc: '2.0', id: msg?.id ?? null, result: msg?.method === 'tools/call' ? { content: [{ type: 'text', text: `did ${msg.params.name}` }] } : {} }
  if (msg?.method === 'tools/call' && msg.params.name === 'list_issues') {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'mcp-session-id': 's-1', 'set-cookie': 'vendor_session=secret' })
    res.write(`event: message\ndata: ${JSON.stringify(answer)}\n\n`)
    return setTimeout(() => res.end(), 5)
  }
  res.writeHead(200, { 'content-type': 'application/json', 'mcp-session-id': 's-1', 'set-cookie': 'vendor_session=secret' })
  res.end(JSON.stringify(answer))
})

const SECRET = Buffer.from('job-secret')
const jobs = jobTokens(SECRET)
const policy = { linear: { read: ['list_issues', 'get_issue'], write: ['save_comment'] }, notion: { read: ['notion-search'], write: [] }, docs: { read: [], write: [] } }
let token = 'at-1'
let refreshes = 0
const logins = {
  linear: { ready: () => true, token: async () => 'lin_api_real' },
  notion: { ready: () => true, token: async () => token, refresh: async () => (refreshes++, (token = 'at-2')) },
  google: { ready: () => false },
}
const logs = []
let broker
let base

before(async () => {
  await new Promise((r) => upstream.listen(0, '127.0.0.1', r))
  const url = `http://127.0.0.1:${upstream.address().port}/mcp`
  const services = Object.fromEntries(Object.keys(SERVICES).map((k) => [k, url]))
  // Point every service at the fake upstream (the real ones are https://…).
  for (const [k, s] of Object.entries(SERVICES)) s.url = services[k]
  broker = http.createServer(toolBroker({ secret: SECRET, jobs, logins, policy, log: (l) => logs.push(l), limits: { maxCalls: 4, maxWrites: 1 } }))
  await new Promise((r) => broker.listen(0, '127.0.0.1', r))
  base = `http://127.0.0.1:${broker.address().port}`
})
after(() => {
  broker.close()
  upstream.close()
})

const rpc = (method, params, id = 1) => ({ jsonrpc: '2.0', id, method, params })
const call = (jobToken, service, msg, { method = 'POST', headers = {} } = {}) =>
  fetch(`${base}/mcp/${service}`, {
    method,
    headers: { ...(jobToken ? { authorization: `Bearer ${jobToken}` } : {}), 'content-type': 'application/json', accept: 'application/json, text/event-stream', cookie: 'box=1', ...headers },
    ...(method === 'POST' ? { body: typeof msg === 'string' ? msg : JSON.stringify(msg) } : {}),
  })

test('broker: the session goes through with the bot’s own credential — never the job token, never a cookie either way', async () => {
  const job = { who: 'alice (U1)', tools: ['linear'], logins }
  const t = jobs.issue(60_000, 'T1/C1/1.1', job)
  const init = await call(t, 'linear', rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'codex', version: '0' } }))
  assert.equal(init.status, 200)
  assert.equal(init.headers.get('mcp-session-id'), 's-1') // MCP's session header comes back…
  assert.equal(init.headers.get('set-cookie'), null) // …the vendor's cookie doesn't
  assert.equal((await call(t, 'linear', { jsonrpc: '2.0', method: 'notifications/initialized' }, { headers: { 'mcp-session-id': 's-1' } })).status, 202)
  assert.equal((await (await call(t, 'linear', rpc('tools/list', {}))).json()).id, 1)
  for (const s of seen.slice(-3)) {
    assert.equal(s.auth, 'Bearer lin_api_real')
    assert.equal(s.cookie, undefined)
  }
  assert.equal(seen.at(-2).session, 's-1')
  jobs.revoke(t)
})

test('broker: a listed read goes through (an SSE answer streamed back) and is logged; the call is counted', async () => {
  const job = { who: 'alice (U1)', tools: ['linear'], logins }
  const t = jobs.issue(60_000, 'T1/C1/1.1', job)
  const r = await call(t, 'linear', rpc('tools/call', { name: 'list_issues', arguments: { query: 'CI' } }))
  assert.equal(r.headers.get('content-type'), 'text/event-stream')
  assert.match(await r.text(), /data: .*did list_issues/)
  assert.equal(job.toolCalls, 1)
  assert.deepEqual(job.writes, []) // a read is not a change
  assert.ok(logs.some((l) => l === 'T1/C1/1.1: linear list_issues for alice (U1)'))
  jobs.revoke(t)
})

test('broker: a tool that isn’t listed — or a method outside a tool session — never reaches the service', async () => {
  const t = jobs.issue(60_000, 'T1/C1/1.1', { who: 'mallory (U9)', tools: ['linear'], logins })
  const before = seen.length
  const refused = await (await call(t, 'linear', rpc('tools/call', { name: 'delete_issue', arguments: { id: 'LIN-1' } }, 7))).json()
  assert.deepEqual(refused, { jsonrpc: '2.0', id: 7, result: { content: [{ type: 'text', text: "delete_issue isn't allowed on this bot: it may use only the linear tools it lists" }], isError: true } })
  const other = await (await call(t, 'linear', rpc('resources/read', { uri: 'linear://everything' }, 8))).json()
  assert.deepEqual(other.error, { code: -32601, message: "resources/read isn't available through this bot" })
  assert.equal((await call(t, 'linear', [rpc('tools/call', { name: 'list_issues' })])).status, 400) // no batches
  assert.equal((await call(t, 'linear', '{not json')).status, 400)
  assert.equal(seen.length, before)
  assert.ok(logs.some((l) => /refused linear delete_issue for mallory \(U9\)/.test(l)))
  jobs.revoke(t)
})

test('broker: a listed change goes through and is recorded; the change and call budgets hold', async () => {
  const job = { who: 'bob (U2)', writes: [], tools: ['linear'], logins }
  const saved = []
  job.slack = { record: async () => { saved.push([...job.writes]) } }
  const t = jobs.issue(60_000, 'T1/C1/2.2', job)
  const ok = await (await call(t, 'linear', rpc('tools/call', { name: 'save_comment', arguments: { issueId: 'LIN-1', body: 'Fixed in #12' } }))).json()
  assert.equal(ok.result.content[0].text, 'did save_comment')
  assert.deepEqual(job.writes, ['Linear save_comment'])
  assert.deepEqual(saved, [['Linear save_comment']])
  const second = await (await call(t, 'linear', rpc('tools/call', { name: 'save_comment', arguments: {} }))).json()
  assert.match(second.result.content[0].text, /used up the changes it may make/)
  await call(t, 'linear', rpc('tools/call', { name: 'get_issue', arguments: {} }))
  await call(t, 'linear', rpc('tools/call', { name: 'get_issue', arguments: {} })) // the 4th call: the last allowed
  const over = await (await call(t, 'linear', rpc('tools/call', { name: 'get_issue', arguments: {} }))).json()
  assert.match(over.result.content[0].text, /used up its tool calls/)
  jobs.revoke(t)
})

test('broker: revocation while a personal login is loading prevents forwarding a write', async () => {
  const before = seen.length
  const own = { ready: () => true, token: async () => { jobs.revoke(t); return 'personal-token' } }
  const t = jobs.issue(60_000, 'T1/D1/1.1', { tools: ['linear'], logins: { linear: own } })
  const res = await call(t, 'linear', rpc('tools/call', { name: 'save_comment', arguments: {} }))
  assert.equal(res.status, 502)
  assert.equal(seen.length, before)
})

test('broker: no live job token → 403 (never a 401); a service not linked, unknown or with no tools allowed → 404', async () => {
  const before = seen.length
  assert.equal((await call(null, 'linear', rpc('tools/list', {}))).status, 403)
  assert.equal((await call('a.b.c', 'linear', rpc('tools/list', {}))).status, 403)
  const gone = jobs.issue(60_000, 'x')
  jobs.revoke(gone)
  assert.equal((await call(gone, 'linear', rpc('tools/list', {}))).status, 403)
  const t = jobs.issue(60_000, 'x', { tools: Object.keys(SERVICES), logins })
  for (const service of ['drive', 'docs', 'github', 'constructor', '../linear']) assert.equal((await call(t, service, rpc('tools/list', {}))).status, 404, service)
  assert.equal(seen.length, before)
  jobs.revoke(t)
})

test("broker: a turn not given a service can't reach it with its own live token — a public GitHub thread's, say", async () => {
  const before = seen.length
  const stranger = jobs.issue(60_000, 'acme/app#7', { who: '@stranger' }) // a GitHub turn with no tools
  const linearOnly = jobs.issue(60_000, 'acme/app#8', { who: '@admin', tools: ['linear'], logins })
  for (const [t, service] of [[stranger, 'linear'], [stranger, 'notion'], [linearOnly, 'notion']]) {
    const r = await call(t, service, rpc('tools/call', { name: service === 'linear' ? 'list_issues' : 'notion-search', arguments: {} }))
    assert.equal(r.status, 404, service)
    assert.match((await r.json()).error.message, /for this request/)
  }
  assert.equal(seen.length, before) // nothing reached a service
  assert.ok(logs.some((l) => l === "acme/app#7: refused linear for @stranger — this request wasn't given it"))
  assert.equal((await call(linearOnly, 'linear', rpc('tools/list', {}))).status, 200) // what it was given still works
  jobs.revoke(stranger)
  jobs.revoke(linearOnly)
})

test('broker: an access token the service rejects is refreshed once and the call retried; a login it keeps rejecting is a 502', async () => {
  const t = jobs.issue(60_000, 'T1/C1/3.3', { tools: ['notion'], logins })
  reject = 'at-1'
  const r = await call(t, 'notion', rpc('tools/call', { name: 'notion-search', arguments: { query: 'spec' } }))
  assert.equal(r.status, 200)
  assert.equal(refreshes, 1)
  assert.deepEqual(seen.slice(-2).map((s) => s.auth), ['Bearer at-1', 'Bearer at-2'])
  reject = 'at-2'
  logins.notion.refresh = async () => {} // the service rejects even a fresh one
  const bad = await call(t, 'notion', rpc('tools/call', { name: 'notion-search', arguments: {} }))
  assert.equal(bad.status, 502)
  assert.match((await bad.json()).error.message, /Notion login was rejected/)
  reject = null
  jobs.revoke(t)
})

test('enabledServices and googleScopes: only linked services that allow a tool; only the scopes the policy needs', () => {
  const on = enabledServices({ linear: { ready: () => true }, notion: { ready: () => false }, google: { ready: () => true } }, {
    linear: { read: ['get_issue'], write: ['save_comment'] }, notion: { read: ['notion-search'], write: [] },
    docs: { read: ['read_doc'], write: [] }, sheets: { read: [], write: [] },
  })
  assert.deepEqual(on, [
    { name: 'linear', label: 'Linear', tools: ['get_issue', 'save_comment'], writes: true },
    { name: 'docs', label: 'Google Docs', tools: ['read_doc'], writes: false },
  ])
  const G = 'https://www.googleapis.com/auth/'
  assert.deepEqual(googleScopes({ docs: { read: ['read_doc'], write: ['update_doc'] }, calendar: { read: ['list_events'], write: [] }, linear: { read: ['x'], write: ['y'] } }), ['openid', 'email', `${G}documents.readonly`, `${G}documents`, `${G}calendar.readonly`])
})

test('check: responses and notifications pass; tool calls are judged by name', () => {
  const allowed = { read: ['a'], write: ['b'] }
  const job = { toolCalls: 0, writes: [] }
  assert.deepEqual(check('x', JSON.stringify({ jsonrpc: '2.0', id: 3, result: {} }), allowed, job), {})
  assert.deepEqual(check('x', JSON.stringify({ jsonrpc: '2.0', method: 'notifications/cancelled', params: {} }), allowed, job), {})
  assert.deepEqual(check('x', JSON.stringify(rpc('tools/call', { name: 'a' })), allowed, job), { tool: 'a', write: false })
  assert.deepEqual(check('x', JSON.stringify(rpc('tools/call', { name: 'b' })), allowed, job), { tool: 'b', write: true })
  assert.equal(check('x', JSON.stringify(rpc('tools/call', {})), allowed, job).answer.result.isError, true)
  assert.equal(check('x', JSON.stringify(rpc('prompts/get', {})), allowed, job).answer.error.code, -32601)
})
