import assert from 'node:assert/strict'
import { test, before, after } from 'node:test'
import http from 'node:http'
import { createProxy } from '../src/proxy.mjs'
import { jobTokens } from '../src/chatgpt.mjs'

// A fake chatgpt.com: records what reaches it, rejects the first access token like an expired one,
// and streams an SSE-shaped answer in two chunks.
const seen = []
let rejectToken = 'at-expired'
const upstream = http.createServer(async (req, res) => {
  let body = ''
  for await (const c of req) body += c
  seen.push({ method: req.method, url: req.url, auth: req.headers.authorization, account: req.headers['chatgpt-account-id'], originator: req.headers.originator, body: body && JSON.parse(body) })
  if (req.headers.authorization === `Bearer ${rejectToken}`) {
    res.writeHead(401, { 'content-type': 'application/json' })
    return res.end('{"detail":"token expired"}')
  }
  res.writeHead(200, { 'content-type': 'text/event-stream', 'x-request-id': 'req_1' })
  res.write('event: response.created\ndata: {}\n\n')
  setTimeout(() => res.end('event: response.completed\ndata: {}\n\n'), 10)
})

const SECRET = Buffer.from('job-secret')
const jobs = jobTokens(SECRET)
let tokens = { access_token: 'at-expired', refresh_token: 'rt-1', account_id: 'acct-real' }
let refreshes = 0
const login = { get: () => tokens, refresh: async () => (refreshes++, (tokens = { ...tokens, access_token: 'at-fresh' })) }
let proxy
let base

before(async () => {
  await new Promise((r) => upstream.listen(0, '127.0.0.1', r))
  proxy = createProxy({ login, secret: SECRET, jobs, upstream: `http://127.0.0.1:${upstream.address().port}`, model: 'gpt-5.6-sol', maxRequestsPerJob: 3 })
  await new Promise((r) => proxy.listen(0, '127.0.0.1', r))
  base = `http://127.0.0.1:${proxy.address().port}`
})
after(() => {
  proxy.close()
  upstream.close()
})

const call = (token, { path = '/backend-api/codex/responses', method = 'POST', body = { model: 'o3-pro', input: 'hi', stream: true } } = {}) =>
  fetch(`${base}${path}`, {
    method,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), 'chatgpt-account-id': 'botlite', originator: 'codex_exec', 'content-type': 'application/json' },
    ...(method === 'POST' ? { body: JSON.stringify(body) } : {}),
  })

test('forwards the turn with the real login; an expired token is refreshed once and retried', async () => {
  const t = jobs.issue(60_000, 'acme/app#7')
  const r = await call(t)
  assert.equal(r.status, 200)
  assert.equal(r.headers.get('x-request-id'), 'req_1')
  assert.equal(await r.text(), 'event: response.created\ndata: {}\n\nevent: response.completed\ndata: {}\n\n')
  assert.equal(refreshes, 1)
  const [first, second] = seen.slice(-2)
  assert.equal(first.auth, 'Bearer at-expired')
  assert.equal(second.auth, 'Bearer at-fresh') // the box's job token never reaches ChatGPT
  assert.equal(second.account, 'acct-real') // nor its stand-in account id
  assert.equal(second.originator, 'codex_exec')
  assert.equal(second.body.model, 'gpt-5.6-sol') // pinned
  jobs.revoke(t)
})

test('only the model endpoints go through — the rest of the ChatGPT backend is a 404', async () => {
  const t = jobs.issue(60_000, 'acme/app#7')
  const before = seen.length
  for (const [method, path] of [['GET', '/backend-api/conversations'], ['GET', '/backend-api/ps/plugins/installed?limit=200'], ['POST', '/backend-api/ps/mcp'], ['GET', '/backend-api/wham/settings/user'], ['POST', '/backend-api/codex/analytics-events/events']]) {
    assert.equal((await call(t, { method, path, body: {} })).status, 404, path)
  }
  assert.equal(seen.length, before) // nothing reached ChatGPT
  assert.equal((await call(t, { method: 'GET', path: '/backend-api/codex/models?client_version=0.150.0' })).status, 200)
  jobs.revoke(t)
})

test('/git/ goes to the git push route when there is one, and is a 404 like the rest otherwise', async () => {
  const hits = []
  const withGit = createProxy({ login, secret: SECRET, jobs, upstream: 'http://127.0.0.1:9', git: (req, res) => (hits.push(req.url), res.writeHead(204).end()) })
  await new Promise((r) => withGit.listen(0, '127.0.0.1', r))
  try {
    const r = await fetch(`http://127.0.0.1:${withGit.address().port}/git/info/refs?service=git-receive-pack`)
    assert.equal(r.status, 204)
    assert.deepEqual(hits, ['/git/info/refs?service=git-receive-pack'])
  } finally {
    withGit.close()
  }
  assert.equal((await fetch(`${base}/git/info/refs?service=git-receive-pack`)).status, 404) // the proxy under test has none
})

test('no live job token → 403 (never a 401, which would send Codex into its own refresh)', async () => {
  const before = seen.length
  assert.equal((await call(null)).status, 403)
  assert.equal((await call('a.b.c')).status, 403)
  const revoked = jobs.issue(60_000, 'x#1')
  jobs.revoke(revoked)
  assert.equal((await call(revoked)).status, 403)
  const other = jobTokens(Buffer.from('another-secret')).issue(60_000, 'x#1')
  assert.equal((await call(other)).status, 403)
  assert.equal(seen.length, before)
})

test('each job has a request budget; a login ChatGPT keeps rejecting becomes a 502', async () => {
  const t = jobs.issue(60_000, 'acme/app#7')
  assert.equal((await call(t)).status, 200)
  assert.equal((await call(t)).status, 200)
  assert.equal((await call(t)).status, 200)
  assert.equal((await call(t)).status, 429)
  jobs.revoke(t)

  rejectToken = 'at-fresh' // ChatGPT now rejects even the refreshed token
  login.refresh = async () => {}
  const u = jobs.issue(60_000, 'acme/app#8')
  const r = await call(u)
  assert.equal(r.status, 502)
  assert.match((await r.json()).error.message, /run the device login again/)
})
