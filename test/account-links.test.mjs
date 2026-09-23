import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createHash } from 'node:crypto'
import { mkdtemp, rm, stat, writeFile, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { accountLinks } from '../src/account-links.mjs'
import { userLogins } from '../src/userlogins.mjs'
import { googleScopes } from '../src/tools.mjs'
import { TOOLS } from '../src/policy.mjs'
import { createProxy } from '../src/proxy.mjs'

async function setup(t) {
  const dir = await mkdtemp(path.join(tmpdir(), 'linear-link-'))
  let clock = Date.now()
  let tokenResult = { access_token: 'test-access', refresh_token: 'test-refresh', expires_in: 3600 }
  const calls = []
  const fetchImpl = async (url, init) => {
    assert.equal(init.redirect, 'error')
    calls.push({ url, body: init.body })
    return Response.json(url.endsWith('/register') ? { client_id: 'test-client' } : tokenResult)
  }
  const store = userLogins({ dir, kinds: { linear: 'key-or-oauth', notion: 'oauth', google: 'oauth' }, fetchImpl })
  const link = accountLinks({ baseUrl: () => 'https://controller.example', userLogins: store, fetchImpl, now: () => clock,
    googleScopes: googleScopes(TOOLS), googleClient: async () => ({ client_id: 'test-google-client', client_secret: 'test-google-secret' }) })
  const server = createProxy({ linking: link.handle })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  t.after(async () => { server.close(); await rm(dir, { recursive: true, force: true }) })
  const call = (url, options = {}) => fetch(`http://127.0.0.1:${server.address().port}${new URL(url).pathname}${new URL(url).search}`, { redirect: 'manual', ...options })
  async function start(user = 'U1', service = 'linear') {
    const { url } = await link.begin(service, user)
    const page = await call(url)
    assert.equal(page.status, 200)
    assert.match(page.headers.get('set-cookie'), /Secure; HttpOnly; SameSite=Lax/)
    const cookie = page.headers.get('set-cookie').split(';')[0]
    const redirect = await call(url, { method: 'POST', headers: { cookie } })
    assert.equal(redirect.status, 303)
    const auth = new URL(redirect.headers.get('location'))
    const callback = `${auth.searchParams.get('redirect_uri')}?state=${auth.searchParams.get('state')}&code=test-code&iss=${auth.origin}`
    return { url, auth, callback, cookie }
  }
  return { link, store, start, call, calls, advance: (ms) => { clock += ms }, tokenResult: (value) => { tokenResult = value } }
}

test('Linear browser consent binds only the requester; survives reload, refreshes and supports legacy keys', async (t) => {
  const { store, start, call, calls } = await setup(t)
  const { auth, callback, cookie } = await start()
  assert.equal((await call(callback)).status, 403) // another browser cannot complete the flow
  const connected = await call(callback, { headers: { cookie } })
  assert.equal(connected.status, 200)
  assert.match(await connected.text(), /Linear connected/)
  const exchange = new URLSearchParams(calls.at(-1).body)
  assert.equal(auth.searchParams.get('code_challenge'), createHash('sha256').update(exchange.get('code_verifier')).digest('base64url'))
  assert.equal(exchange.get('redirect_uri'), auth.searchParams.get('redirect_uri'))
  assert.equal((await stat(store.fileFor('linear', 'U1'))).mode & 0o777, 0o600)
  assert.equal((await store.forUser('U2')).linear.ready(), false)
  const login = (await store.forUser('U1')).linear
  assert.equal(await login.token(), 'test-access')
  await login.refresh()
  assert.equal(new URLSearchParams(calls.at(-1).body).get('grant_type'), 'refresh_token')
  const reloaded = userLogins({ dir: path.dirname(path.dirname(store.fileFor('linear', 'U1'))), kinds: store.kinds })
  assert.equal(await (await reloaded.forUser('U1')).linear.token(), 'test-access')
  assert.equal((await call(callback, { headers: { cookie } })).status, 410)
  await writeFile(store.fileFor('linear', 'U1'), 'lin_api_test-legacy')
  assert.equal(await (await store.forUser('U1')).linear.token(), 'lin_api_test-legacy')
  await rm(store.fileFor('linear', 'U1'))
  await rm(`${store.fileFor('linear', 'U1')}.live.json`)
  assert.equal((await store.forUser('U1')).linear.ready(), false)
})

test('Google aliases link one private account with offline consent, policy scopes and a web client', async (t) => {
  const { store, start, call, calls } = await setup(t)
  const { auth, callback, cookie } = await start('U1', 'drive')
  assert.equal(auth.origin, 'https://accounts.google.com')
  assert.equal(auth.pathname, '/o/oauth2/v2/auth')
  assert.equal(auth.searchParams.get('redirect_uri'), 'https://controller.example/link/google/callback')
  assert.equal(auth.searchParams.get('scope'), googleScopes(TOOLS).join(' '))
  assert.equal(auth.searchParams.get('access_type'), 'offline')
  assert.equal(auth.searchParams.get('prompt'), 'consent select_account')
  assert.equal(auth.searchParams.has('client_secret'), false)
  assert.equal(auth.searchParams.has('resource'), false)
  assert.equal((await call(callback, { headers: { cookie } })).status, 200)
  const exchange = new URLSearchParams(calls.at(-1).body)
  assert.equal(calls.at(-1).url, 'https://oauth2.googleapis.com/token')
  assert.equal(exchange.get('client_secret'), 'test-google-secret')
  assert.equal(exchange.has('resource'), false)
  assert.equal(auth.searchParams.get('code_challenge'), createHash('sha256').update(exchange.get('code_verifier')).digest('base64url'))
  assert.equal((await store.forUser('U2')).google.ready(), false)
  assert.equal((await stat(store.fileFor('google', 'U1'))).mode & 0o777, 0o600)
  const login = (await store.forUser('U1')).google
  await login.refresh()
  assert.equal(calls.at(-1).url, 'https://oauth2.googleapis.com/token')
  assert.equal(new URLSearchParams(calls.at(-1).body).get('grant_type'), 'refresh_token')
  for (const alias of ['google', 'google workspace', 'docs', 'sheets', 'slides', 'calendar']) {
    const next = await start('U1', alias)
    assert.equal(next.auth.searchParams.get('client_id'), 'test-google-client')
  }
  assert.equal(calls.some((c) => c.url.endsWith('/register')), false)
})

test('Google setup failures return actionable guidance without leaking configuration; other providers still link', async (t) => {
  const { store } = await setup(t)
  const link = accountLinks({ baseUrl: () => 'https://controller.example', userLogins: store,
    googleClient: async () => { throw new Error('test-config-secret') } })
  for (const alias of ['google', 'drive']) {
    await assert.rejects(link.begin(alias, 'U1'), (error) => /administrator setup/.test(error.message) && !error.message.includes('test-config-secret'))
  }
  assert.equal((await store.forUser('U1')).google.ready(), false)
  assert.match((await link.begin('notion', 'U1')).url, /\/link\/notion\/start/)
})

test('Linear links are private capabilities: bad state, cross-browser, expiry, denial and replacement fail closed', async (t) => {
  const { link, store, start, call, calls, advance } = await setup(t)
  const first = await start()
  assert.equal((await call(first.callback.replace(/state=[^&]+/, 'state=wrong'), { headers: { cookie: first.cookie } })).status, 410)
  const second = await start('U2')
  assert.equal((await call(first.callback, { headers: { cookie: second.cookie } })).status, 403)
  const { url: replacement } = await link.begin('linear', 'U1')
  assert.equal((await call(first.callback, { headers: { cookie: first.cookie } })).status, 410)
  assert.equal((await call(replacement, { method: 'POST' })).status, 403)
  const denied = second.callback.replace('code=test-code', 'error=access_denied')
  assert.equal((await call(denied, { headers: { cookie: second.cookie } })).status, 400)
  assert.equal((await call(second.callback, { headers: { cookie: second.cookie } })).status, 410)
  advance(600_001)
  assert.equal((await call(replacement)).status, 410)
  assert.equal(calls.filter((c) => c.url.endsWith('/token')).length, 0)
  assert.equal((await store.forUser('U1')).linear.ready(), false)
  assert.equal((await store.forUser('U2')).linear.ready(), false)
})

test('invalid issuer and incomplete tokens never replace a working login or leak provider errors', async (t) => {
  const { store, start, call, tokenResult } = await setup(t)
  const first = await start()
  assert.equal((await call(first.callback.replace('iss=https://mcp.linear.app', 'iss=https://other.example'), { headers: { cookie: first.cookie } })).status, 400)
  const second = await start()
  await call(second.callback, { headers: { cookie: second.cookie } })
  const third = await start()
  tokenResult({ error: 'test-provider-secret', access_token: 'test-rejected' })
  const failed = await call(third.callback, { headers: { cookie: third.cookie } })
  assert.equal(failed.status, 502)
  assert.doesNotMatch(await failed.text(), /test-provider-secret|test-rejected/)
  assert.equal(await (await store.forUser('U1')).linear.token(), 'test-access')
})

test('Notion keeps its registration, callback, lifetime and refreshed login separate from Linear and other people', async (t) => {
  const { link, store, start, call, calls } = await setup(t)
  await assert.rejects(link.begin('notion U2', 'U1'), /Use \/link/)
  const linear = await start()
  const notion = await start('U1', 'notion')
  assert.equal(notion.auth.origin, 'https://mcp.notion.com')
  assert.equal(notion.auth.searchParams.get('scope'), 'default')
  assert.equal(notion.auth.searchParams.get('resource'), 'https://mcp.notion.com/mcp')
  const registrations = calls.filter((c) => c.url.endsWith('/register'))
  assert.equal(registrations.length, 2)
  assert.deepEqual(JSON.parse(registrations[1].body).redirect_uris, ['https://controller.example/link/notion/callback'])
  const crossed = notion.callback.replace('/link/notion/', '/link/linear/')
  assert.equal((await call(crossed, { headers: { cookie: notion.cookie } })).status, 410)
  assert.equal((await call(notion.callback, { headers: { cookie: linear.cookie } })).status, 403)
  assert.equal((await call(notion.callback, { headers: { cookie: notion.cookie } })).status, 200)
  assert.equal(calls.at(-1).url, 'https://mcp.notion.com/token')
  const exchange = new URLSearchParams(calls.at(-1).body)
  assert.equal(notion.auth.searchParams.get('code_challenge'), createHash('sha256').update(exchange.get('code_verifier')).digest('base64url'))
  assert.equal((await stat(store.fileFor('notion', 'U1'))).mode & 0o777, 0o600)
  const record = JSON.parse(await readFile(store.fileFor('notion', 'U1'), 'utf8'))
  assert.equal(record.max_age_days, 180)
  assert.equal(record.token_endpoint, 'https://mcp.notion.com/token')
  const login = (await store.forUser('U1')).notion
  await login.refresh()
  assert.equal(new URLSearchParams(calls.at(-1).body).get('grant_type'), 'refresh_token')
  assert.equal((await store.forUser('U2')).notion.ready(), false)
  assert.equal((await call(notion.callback, { headers: { cookie: notion.cookie } })).status, 410)
  assert.equal((await call(linear.callback, { headers: { cookie: linear.cookie } })).status, 200)
})
