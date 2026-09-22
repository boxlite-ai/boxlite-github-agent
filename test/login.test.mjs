import assert from 'node:assert/strict'
import { test } from 'node:test'
import http from 'node:http'
import { createHash } from 'node:crypto'
import { pkce, loopback, discover, notionLogin, googleLogin } from '../deploy/login.mjs'

// A fake authorization server shaped like Notion's (the metadata it really serves) — and, for
// Google, one token endpoint. The "browser" follows the consent link and lands on the redirect.
function fakeAuthServer() {
  const seen = { registrations: [], tokens: [], authorizations: [] }
  const codes = new Map() // code → the challenge it was issued for
  const server = http.createServer(async (req, res) => {
    const u = new URL(req.url, 'http://x')
    let body = ''
    for await (const c of req) body += c
    const origin = `http://127.0.0.1:${server.address().port}`
    const json = (o, status = 200) => res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(o))
    if (u.pathname === '/.well-known/oauth-protected-resource/mcp') return json({ resource: `${origin}/mcp`, authorization_servers: [origin] })
    if (u.pathname === '/.well-known/oauth-authorization-server') return json({ issuer: origin, authorization_endpoint: `${origin}/authorize`, token_endpoint: `${origin}/token`, registration_endpoint: `${origin}/register` })
    if (u.pathname === '/register') {
      seen.registrations.push(JSON.parse(body))
      return json({ client_id: 'dcr-client-1' }, 201)
    }
    if (u.pathname === '/authorize') {
      seen.authorizations.push(Object.fromEntries(u.searchParams))
      const code = `code-${codes.size + 1}`
      codes.set(code, u.searchParams.get('code_challenge'))
      const back = new URL(u.searchParams.get('redirect_uri'))
      back.searchParams.set('code', code)
      back.searchParams.set('state', u.searchParams.get('state'))
      return res.writeHead(302, { location: String(back) }).end()
    }
    if (u.pathname === '/token') {
      const form = Object.fromEntries(new URLSearchParams(body))
      seen.tokens.push(form)
      const challenge = createHash('sha256').update(form.code_verifier ?? '').digest('base64url')
      if (codes.get(form.code) !== challenge) return json({ error: 'invalid_grant' }, 400) // PKCE checked
      const idToken = `x.${Buffer.from(JSON.stringify({ email: 'botlite@acme.test' })).toString('base64url')}.sig`
      return json({ access_token: 'at-1', refresh_token: 'rt-1', expires_in: 3600, scope: form.scope, id_token: idToken })
    }
    res.writeHead(404).end()
  })
  return { server, seen, listen: () => new Promise((r) => server.listen(0, '127.0.0.1', r)), origin: () => `http://127.0.0.1:${server.address().port}` }
}
const browser = (url) => fetch(url).catch(() => {}) // follows the redirect to the loopback, like a person's browser would

test('pkce: an S256 challenge of a fresh verifier', () => {
  const a = pkce()
  assert.equal(a.challenge, createHash('sha256').update(a.verifier).digest('base64url'))
  assert.notEqual(pkce().verifier, a.verifier)
  assert.match(a.verifier, /^[\w-]{43}$/)
})

test('loopback: the code from the right redirect; a wrong state or a refusal is an error', async () => {
  const ok = await loopback({ state: 's1' })
  assert.match(ok.redirectUri, /^http:\/\/127\.0\.0\.1:\d+\/callback$/)
  await fetch(`${ok.redirectUri}?code=c1&state=s1`)
  assert.equal(await ok.code, 'c1')
  ok.close()
  const forged = await loopback({ state: 's2' })
  await fetch(`${forged.redirectUri}?code=c2&state=evil`)
  await assert.rejects(forged.code, /state mismatch/)
  forged.close()
  const refused = await loopback({ state: 's3' })
  await fetch(`${refused.redirectUri}?error=access_denied&state=s3`)
  await assert.rejects(refused.code, /refused: access_denied/)
  refused.close()
})

test('notionLogin: discovery, a public client registered for the loopback, PKCE, the resource — and a login the controller can refresh', async () => {
  const as = fakeAuthServer()
  await as.listen()
  try {
    const resource = `${as.origin()}/mcp`
    assert.equal((await discover(resource)).token_endpoint, `${as.origin()}/token`)
    const login = await notionLogin({ resource, open: browser, print: () => {} })
    const [reg] = as.seen.registrations
    assert.equal(reg.token_endpoint_auth_method, 'none')
    assert.match(reg.redirect_uris[0], /^http:\/\/127\.0\.0\.1:\d+\/callback$/)
    const [auth] = as.seen.authorizations
    assert.deepEqual([auth.client_id, auth.code_challenge_method, auth.resource, auth.redirect_uri], ['dcr-client-1', 'S256', resource, reg.redirect_uris[0]])
    assert.equal(as.seen.tokens[0].resource, resource)
    assert.deepEqual(
      { ...login, expires_at: typeof login.expires_at, linked_at: typeof login.linked_at },
      { token_endpoint: `${as.origin()}/token`, client_id: 'dcr-client-1', resource, access_token: 'at-1', refresh_token: 'rt-1', expires_at: 'number', linked_at: 'string', max_age_days: 180 },
    )
  } finally {
    as.server.close()
  }
})

test('googleLogin: your client, offline access with the policy’s scopes, PKCE; the account from the ID token', async () => {
  const as = fakeAuthServer()
  await as.listen()
  try {
    const login = await googleLogin({
      clientId: 'gc-1', clientSecret: 'gs-1', scopes: ['openid', 'email', 'https://www.googleapis.com/auth/documents.readonly'],
      authorizationEndpoint: `${as.origin()}/authorize`, tokenEndpoint: `${as.origin()}/token`, open: browser, print: () => {},
    })
    const [auth] = as.seen.authorizations
    assert.deepEqual([auth.client_id, auth.access_type, auth.prompt, auth.code_challenge_method], ['gc-1', 'offline', 'consent', 'S256'])
    assert.equal(auth.scope, 'openid email https://www.googleapis.com/auth/documents.readonly')
    assert.match(auth.redirect_uri, /^http:\/\/127\.0\.0\.1:\d+\/$/)
    assert.equal(as.seen.tokens[0].client_secret, 'gs-1')
    assert.deepEqual([login.account, login.client_id, login.client_secret, login.refresh_token, login.token_endpoint], ['botlite@acme.test', 'gc-1', 'gs-1', 'rt-1', `${as.origin()}/token`])
  } finally {
    as.server.close()
  }
})
