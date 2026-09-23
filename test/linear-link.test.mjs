import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createHash } from 'node:crypto'
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { linearLink } from '../src/linear-link.mjs'
import { userLogins } from '../src/userlogins.mjs'
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
  const store = userLogins({ dir, kinds: { linear: 'key-or-oauth' }, fetchImpl })
  const link = linearLink({ baseUrl: () => 'https://controller.example', userLogins: store, fetchImpl, now: () => clock })
  const server = createProxy({ linking: link.handle })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  t.after(async () => { server.close(); await rm(dir, { recursive: true, force: true }) })
  const call = (url, options = {}) => fetch(`http://127.0.0.1:${server.address().port}${new URL(url).pathname}${new URL(url).search}`, { redirect: 'manual', ...options })
  async function start(user = 'U1') {
    const url = link.begin(user)
    const page = await call(url)
    assert.equal(page.status, 200)
    assert.match(page.headers.get('set-cookie'), /Secure; HttpOnly; SameSite=Lax/)
    const cookie = page.headers.get('set-cookie').split(';')[0]
    const redirect = await call(url, { method: 'POST', headers: { cookie } })
    assert.equal(redirect.status, 303)
    const auth = new URL(redirect.headers.get('location'))
    const callback = `${auth.searchParams.get('redirect_uri')}?state=${auth.searchParams.get('state')}&code=test-code&iss=https://mcp.linear.app`
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

test('Linear links are private capabilities: bad state, cross-browser, expiry, denial and replacement fail closed', async (t) => {
  const { link, store, start, call, calls, advance } = await setup(t)
  const first = await start()
  assert.equal((await call(first.callback.replace(/state=[^&]+/, 'state=wrong'), { headers: { cookie: first.cookie } })).status, 410)
  const second = await start('U2')
  assert.equal((await call(first.callback, { headers: { cookie: second.cookie } })).status, 403)
  const replacement = link.begin('U1')
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
