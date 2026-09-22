// The bot's one-time OAuth logins to Notion and Google Workspace, done from your machine: a
// browser for the consent, signed in as the bot's own account, and a redirect caught on
// 127.0.0.1. PKCE means an authorization code is worthless to anyone who sees it without this
// process's verifier. The tokens go straight to the controller (ctl.mjs); this machine keeps nothing.
// After that the controller keeps the login alive by itself (src/oauth.mjs).
import http from 'node:http'
import { spawn } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'

const b64u = (buf) => Buffer.from(buf).toString('base64url')

/** A PKCE verifier and its S256 challenge. */
export function pkce() {
  const verifier = b64u(randomBytes(32))
  return { verifier, challenge: b64u(createHash('sha256').update(verifier).digest()) }
}

/** Waits for one redirect to 127.0.0.1:<free port><path>: { redirectUri, code (a promise), close }. */
export async function loopback({ path = '/callback', state }) {
  let settle
  const code = new Promise((resolve, reject) => (settle = { resolve, reject }))
  code.catch(() => {}) // the caller awaits it; don't count it unhandled meanwhile
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://127.0.0.1')
    if (u.pathname !== path) return res.writeHead(404).end()
    res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' })
    const error = u.searchParams.get('error')
    if (error) {
      res.end(`Not linked: ${error}. You can close this tab.`)
      return settle.reject(new Error(`the login was refused: ${error}`))
    }
    if (u.searchParams.get('state') !== state) {
      res.end('This isn’t the login in progress — run it again.')
      return settle.reject(new Error('the redirect is for another login (state mismatch)'))
    }
    res.end('Linked — you can close this tab.')
    settle.resolve(u.searchParams.get('code'))
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return { redirectUri: `http://127.0.0.1:${server.address().port}${path}`, code, close: () => server.close() }
}

async function getJson(url, fetchImpl) {
  const res = await fetchImpl(url, { headers: { accept: 'application/json' } })
  if (!res.ok) throw new Error(`GET ${url}: ${res.status}`)
  return res.json()
}
async function post(url, body, fetchImpl, type = 'form') {
  const res = await fetchImpl(url, {
    method: 'POST',
    headers: { accept: 'application/json', 'content-type': type === 'json' ? 'application/json' : 'application/x-www-form-urlencoded' },
    body: type === 'json' ? JSON.stringify(body) : new URLSearchParams(body).toString(),
  })
  if (!res.ok) throw new Error(`POST ${url}: ${res.status} ${(await res.text().catch(() => '')).slice(0, 300)}`)
  return res.json()
}

/** An MCP server's authorization server metadata: RFC 9728, then RFC 8414 (path-aware first). */
export async function discover(resource, fetchImpl = fetch) {
  const r = new URL(resource)
  const path = r.pathname === '/' ? '' : r.pathname
  const prm = await getJson(`${r.origin}/.well-known/oauth-protected-resource${path}`, fetchImpl).catch(() => getJson(`${r.origin}/.well-known/oauth-protected-resource`, fetchImpl))
  const as = new URL(prm.authorization_servers[0])
  const asPath = as.pathname === '/' ? '' : as.pathname.replace(/\/+$/, '')
  return getJson(`${as.origin}/.well-known/oauth-authorization-server${asPath}`, fetchImpl)
}

/** One authorization-code round trip: show (and open) the consent link, catch the code, trade it. */
async function consent({ authorizationEndpoint, params, redirect, exchange, open, print, state }) {
  const url = new URL(authorizationEndpoint)
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v)
  url.searchParams.set('state', state)
  print(`\nOpen this link, signed in as the bot's own account, and approve:\n\n  ${url}\n`)
  open(String(url))
  const code = await Promise.race([redirect.code, new Promise((_, reject) => setTimeout(() => reject(new Error('no approval within 10 minutes')), 600_000).unref())])
  return exchange(code)
}

/** Notion's hosted MCP: discovery, dynamic client registration (a public client), PKCE. */
export async function notionLogin({ resource = 'https://mcp.notion.com/mcp', fetchImpl = fetch, open = openBrowser, print = console.log } = {}) {
  const meta = await discover(resource, fetchImpl)
  const state = b64u(randomBytes(16))
  const { verifier, challenge } = pkce()
  const redirect = await loopback({ path: '/callback', state })
  try {
    const client = await post(meta.registration_endpoint, { client_name: 'boxliteai for Slack', redirect_uris: [redirect.redirectUri], grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none' }, fetchImpl, 'json')
    const t = await consent({
      authorizationEndpoint: meta.authorization_endpoint,
      params: { response_type: 'code', client_id: client.client_id, redirect_uri: redirect.redirectUri, code_challenge: challenge, code_challenge_method: 'S256', resource },
      redirect,
      state,
      open,
      print,
      exchange: (code) => post(meta.token_endpoint, { grant_type: 'authorization_code', code, redirect_uri: redirect.redirectUri, client_id: client.client_id, code_verifier: verifier, resource }, fetchImpl),
    })
    if (!t.refresh_token) throw new Error('Notion issued no refresh token')
    const login = { token_endpoint: meta.token_endpoint, client_id: client.client_id, resource, access_token: t.access_token, refresh_token: t.refresh_token, expires_at: Date.now() + (t.expires_in ?? 3600) * 1000, linked_at: new Date().toISOString(), max_age_days: 180 }
    if (client.client_secret) login.client_secret = client.client_secret
    return login
  } finally {
    redirect.close()
  }
}

/**
 * Google Workspace: your own OAuth client (Desktop app, in the Cloud project where the Workspace
 * MCP servers are enabled), PKCE, and only the scopes the tool policy needs (tools.mjs googleScopes).
 */
export async function googleLogin({ clientId, clientSecret, scopes, fetchImpl = fetch, open = openBrowser, print = console.log, authorizationEndpoint = 'https://accounts.google.com/o/oauth2/v2/auth', tokenEndpoint = 'https://oauth2.googleapis.com/token' }) {
  const state = b64u(randomBytes(16))
  const { verifier, challenge } = pkce()
  const redirect = await loopback({ path: '/', state })
  try {
    const t = await consent({
      authorizationEndpoint,
      params: { response_type: 'code', client_id: clientId, redirect_uri: redirect.redirectUri, scope: scopes.join(' '), access_type: 'offline', prompt: 'consent', code_challenge: challenge, code_challenge_method: 'S256' },
      redirect,
      state,
      open,
      print,
      exchange: (code) => post(tokenEndpoint, { grant_type: 'authorization_code', code, redirect_uri: redirect.redirectUri, client_id: clientId, client_secret: clientSecret, code_verifier: verifier }, fetchImpl),
    })
    if (!t.refresh_token) throw new Error('Google issued no refresh token')
    // The ID token came straight from Google's token endpoint over TLS: its claims need no signature check here.
    const email = t.id_token ? JSON.parse(Buffer.from(t.id_token.split('.')[1], 'base64url')).email : undefined
    return { token_endpoint: tokenEndpoint, client_id: clientId, client_secret: clientSecret, access_token: t.access_token, refresh_token: t.refresh_token, expires_at: Date.now() + (t.expires_in ?? 3600) * 1000, linked_at: new Date().toISOString(), account: email, scope: t.scope }
  } finally {
    redirect.close()
  }
}

function openBrowser(url) {
  const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'explorer' : 'xdg-open'
  spawn(cmd, [url], { stdio: 'ignore', detached: true }).on('error', () => {}).unref()
}
