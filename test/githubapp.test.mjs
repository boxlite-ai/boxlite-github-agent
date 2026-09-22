import assert from 'node:assert/strict'
import { test } from 'node:test'
import { generateKeyPairSync, verify } from 'node:crypto'
import { appJwt, githubApp } from '../src/githubapp.mjs'

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs1', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } })

test('appJwt: RS256 over header.claims with the App key; iat backdated, 9 minutes of life', () => {
  const now = Date.parse('2026-09-22T10:00:00Z')
  const [h, c, s] = appJwt(123, privateKey, now).split('.')
  assert.deepEqual(JSON.parse(Buffer.from(h, 'base64url')), { alg: 'RS256', typ: 'JWT' })
  assert.deepEqual(JSON.parse(Buffer.from(c, 'base64url')), { iat: now / 1000 - 60, exp: now / 1000 + 540, iss: '123' })
  assert.equal(verify('sha256', Buffer.from(`${h}.${c}`), publicKey, Buffer.from(s, 'base64url')), true)
})

function fakeFetch(routes) {
  const calls = []
  const fetchImpl = async (url, init) => {
    const path = url.replace('https://api.github.com', '')
    calls.push({ method: init.method, path, auth: init.headers.Authorization, body: init.body && JSON.parse(init.body) })
    const route = routes[`${init.method} ${path}`]
    const [status, json] = (typeof route === 'function' ? route() : route) ?? [404, { message: 'Not Found' }]
    return { ok: status < 300, status, json: async () => json, text: async () => JSON.stringify(json) }
  }
  return { calls, fetchImpl }
}

test('githubApp: one token per fork — that repo only, its contents; its workflows only when asked and the App may', async () => {
  let installation = { id: 9, permissions: { contents: 'write', metadata: 'read' } }
  const { calls, fetchImpl } = fakeFetch({
    'GET /users/boxliteai/installation': () => [200, installation],
    'POST /app/installations/9/access_tokens': [201, { token: 'ghs_turn', expires_at: 'T+1h' }],
    'DELETE /installation/token': [204, null],
  })
  const app = githubApp({ appId: 123, privateKey, account: 'boxliteai', fetchImpl })
  assert.equal(await app.token('app'), 'ghs_turn')
  assert.equal(await app.token('app', { workflows: true }), 'ghs_turn') // asked, but the App may not
  installation = { id: 9, permissions: { contents: 'write', metadata: 'read', workflows: 'write' } } // granted since
  assert.equal(await app.token('cli', { workflows: true }), 'ghs_turn')
  assert.equal(await app.token('cli'), 'ghs_turn') // the App may, but this fork runs Actions
  assert.equal(calls.filter((c) => c.path.endsWith('/installation')).length, 4)
  const mints = calls.filter((c) => c.path.endsWith('/access_tokens'))
  assert.deepEqual(mints.map((c) => c.body), [
    { repositories: ['app'], permissions: { contents: 'write' } },
    { repositories: ['app'], permissions: { contents: 'write' } },
    { repositories: ['cli'], permissions: { contents: 'write', workflows: 'write' } },
    { repositories: ['cli'], permissions: { contents: 'write' } },
  ])
  assert.ok(mints.every((c) => /^Bearer [\w-]+\.[\w-]+\.[\w-]+$/.test(c.auth))) // as the App (JWT), not as a user

  await app.revoke('ghs_turn')
  assert.deepEqual(calls.at(-1), { method: 'DELETE', path: '/installation/token', auth: 'Bearer ghs_turn', body: undefined })
})

test('githubApp: not installed on the bot account → a message that says so', async () => {
  const { fetchImpl } = fakeFetch({})
  const app = githubApp({ appId: 123, privateKey, account: 'boxliteai', fetchImpl })
  await assert.rejects(app.token('app'), /the push App isn't installed on @boxliteai/)
})
