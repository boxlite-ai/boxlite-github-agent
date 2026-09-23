import assert from 'node:assert/strict'
import { test } from 'node:test'
import http from 'node:http'
import { jobTokens } from '../src/chatgpt.mjs'
import { TOOLS } from '../src/policy.mjs'
import { toolBroker, googleScopes, enabledServices } from '../src/tools.mjs'

test('Google policy enables requested creations and edits, but no mail sending or deletion', () => {
  const services = enabledServices({ google: { ready: () => true } }, TOOLS)
  for (const [service, tool] of [['gmail', 'create_draft'], ['calendars', 'create_calendar'], ['calendar', 'create_event'], ['calendar', 'update_event'], ['drive', 'create_file'], ['docs', 'update_doc'], ['sheets', 'update_values'], ['slides', 'update_presentation']]) {
    assert.ok(services.find((s) => s.name === service)?.tools.includes(tool), `${service}.${tool}`)
  }
  assert.deepEqual(TOOLS.gmail, { read: [], write: ['create_draft'] })
  assert.equal(TOOLS.calendar.write.includes('delete_event'), false)
  const scopes = googleScopes(TOOLS)
  for (const scope of ['gmail.compose', 'calendar.app.created', 'calendar.events', 'drive.file', 'documents', 'spreadsheets', 'presentations']) {
    assert.ok(scopes.includes(`https://www.googleapis.com/auth/${scope}`), scope)
  }
  assert.equal(scopes.includes('https://mail.google.com/'), false)
})

async function fixture(t) {
  const secret = Buffer.from('google-job-secret')
  const jobs = jobTokens(secret)
  const requests = []
  let status = 200
  const fetchImpl = async (url, options) => {
    requests.push({ url, ...options, body: JSON.parse(options.body) })
    if (status !== 200) return Response.json({ error: { message: 'vendor failure' } }, { status })
    return Response.json({ id: 'calendar-1', summary: 'Team planning' })
  }
  const server = http.createServer(toolBroker({ secret, jobs, policy: TOOLS, fetchImpl, limits: { maxWrites: 1 } }))
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => server.close())
  const issue = (user, tools = ['calendars']) => {
    const job = { who: user, tools, logins: { google: { ready: () => true, token: async () => `google-${user}` } } }
    return { job, token: jobs.issue(60_000, `T/C/thread/${user}`, job) }
  }
  const call = async (token, service, method, params = {}) => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/mcp/${service}`, {
      method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 7, method, params }),
    })
    return { status: response.status, body: await response.json() }
  }
  return { jobs, requests, issue, call, setStatus: (value) => { status = value } }
}

test('calendar MCP advertises creation, uses each requester token, and enforces the write budget', async (t) => {
  const f = await fixture(t)
  const alice = f.issue('alice'), bob = f.issue('bob')
  const init = await f.call(alice.token, 'calendars', 'initialize', { protocolVersion: '2025-06-18' })
  assert.equal(init.body.result.protocolVersion, '2025-06-18')
  const listed = await f.call(alice.token, 'calendars', 'tools/list')
  assert.deepEqual(listed.body.result.tools.map((tool) => tool.name), ['create_calendar'])
  assert.equal(f.requests.length, 0)
  for (const person of [alice, bob]) {
    const result = await f.call(person.token, 'calendars', 'tools/call', { name: 'create_calendar', arguments: { summary: 'Team planning', timeZone: 'Asia/Shanghai' } })
    assert.equal(result.status, 200)
    assert.match(result.body.result.content[0].text, /calendar-1/)
    assert.deepEqual(person.job.writes, ['Google Calendars create_calendar'])
  }
  assert.deepEqual(f.requests.map((r) => r.headers.authorization), ['Bearer google-alice', 'Bearer google-bob'])
  assert.equal(f.requests[0].url, 'https://www.googleapis.com/calendar/v3/calendars')
  assert.deepEqual(f.requests[0].body, { summary: 'Team planning', timeZone: 'Asia/Shanghai' })
  assert.equal(f.requests[0].headers['mcp-session-id'], undefined)
  const over = await f.call(alice.token, 'calendars', 'tools/call', { name: 'create_calendar', arguments: { summary: 'Extra' } })
  assert.match(over.body.result.content[0].text, /used up the changes/)
  assert.equal(f.requests.length, 2)
})

test('calendar creation rejects invalid fields, unauthorized services and revoked jobs before Google', async (t) => {
  const f = await fixture(t)
  for (const args of [{}, { summary: ' ' }, { summary: { trim: 42 } }, { summary: 'x'.repeat(1025) }, { summary: 'x', timeZone: 'not/a-zone' }, { summary: 'x', description: 4 }, { summary: 'x', owner: 'bob' }, { summary: 'x', url: 'https://attacker.test' }]) {
    const { token, job } = f.issue('alice')
    const result = await f.call(token, 'calendars', 'tools/call', { name: 'create_calendar', arguments: args })
    assert.equal(result.status, 400)
    assert.equal(result.body.error.code, -32602)
    assert.deepEqual(job.writes, [])
  }
  const denied = f.issue('alice', ['calendar'])
  assert.equal((await f.call(denied.token, 'calendars', 'tools/list')).status, 404)
  f.jobs.revoke(denied.token)
  assert.equal((await f.call(denied.token, 'calendars', 'tools/list')).status, 403)
  const gmail = f.issue('alice', ['gmail'])
  const send = await f.call(gmail.token, 'gmail', 'tools/call', { name: 'send_message', arguments: {} })
  assert.equal(send.body.result.isError, true)
  assert.equal(f.requests.length, 0)
})

test('Google MCP writes keep the requested arguments and requester credentials', async (t) => {
  const f = await fixture(t)
  for (const [service, name, args] of [
    ['gmail', 'create_draft', { to: ['alice@polygala.ai'], subject: 'Planning', body: 'Draft only' }],
    ['calendar', 'create_event', { summary: 'Planning', attendees: [{ email: 'alice@polygala.ai' }], notificationLevel: 'ALL' }],
    ['drive', 'create_file', { title: 'Planning', contentMimeType: 'application/vnd.google-apps.document' }],
    ['docs', 'update_doc', { documentId: 'doc-1' }],
    ['sheets', 'update_values', { spreadsheetId: 'sheet-1' }],
    ['slides', 'update_presentation', { presentationId: 'deck-1' }],
  ]) {
    const { token, job } = f.issue('alice', [service])
    const result = await f.call(token, service, 'tools/call', { name, arguments: args })
    assert.equal(result.status, 200)
    const request = f.requests.at(-1)
    assert.equal(request.headers.authorization, 'Bearer google-alice')
    assert.deepEqual(request.body.params, { name, arguments: args })
    assert.equal(job.writes.length, 1)
  }
})

test('calendar creation refreshes a rejected token once, without retrying other failures', async (t) => {
  const f = await fixture(t)
  const { token, job } = f.issue('alice')
  let refreshes = 0
  job.logins.google.refresh = async () => { refreshes++; f.setStatus(200) }
  f.setStatus(401)
  const result = await f.call(token, 'calendars', 'tools/call', { name: 'create_calendar', arguments: { summary: 'Team planning' } })
  assert.equal(result.status, 200)
  assert.equal(refreshes, 1)
  assert.equal(f.requests.length, 2)
  f.setStatus(503)
  const another = f.issue('bob')
  const failed = await f.call(another.token, 'calendars', 'tools/call', { name: 'create_calendar', arguments: { summary: 'Team planning' } })
  assert.equal(failed.status, 503)
  assert.deepEqual(another.job.writes, [])
  assert.equal(f.requests.length, 3)
})
