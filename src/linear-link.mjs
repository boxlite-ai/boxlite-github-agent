// A Slack member's private, short-lived browser login. Only the controller sees the tokens.
import { createHash, randomBytes } from 'node:crypto'
import { mkdir, writeFile, rename } from 'node:fs/promises'
import path from 'node:path'

const ISSUER = 'https://mcp.linear.app'
const RESOURCE = `${ISSUER}/mcp`
const PREFIX = '/link/linear'
const fresh = () => randomBytes(32).toString('base64url')

export function linearLink({ baseUrl, userLogins, scope = 'read', fetchImpl = fetch, now = Date.now }) {
  const pending = new Map()
  let registration
  const post = async (endpoint, body, json = false) => {
    const res = await fetchImpl(`${ISSUER}/${endpoint}`, {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15_000),
      headers: { 'content-type': json ? 'application/json' : 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: json ? JSON.stringify(body) : new URLSearchParams(body).toString(),
    })
    if (!res.ok) throw new Error(`Linear ${endpoint}: HTTP ${res.status}`)
    return res.json()
  }
  const prune = () => {
    for (const [state, flow] of pending) if (flow.expires <= now()) pending.delete(state)
  }
  return {
    begin(user) {
      const file = userLogins.fileFor('linear', user)
      const base = new URL(baseUrl())
      if (base.protocol !== 'https:') throw new Error('Linear linking requires a public HTTPS URL')
      prune()
      for (const [state, flow] of pending) {
        if (flow.user !== user) continue
        if (flow.completing) throw new Error('Linear linking is completing; try again shortly')
        pending.delete(state)
      }
      if (pending.size >= 1000) throw new Error('Too many Linear logins in progress; try again later')
      const state = fresh()
      pending.set(state, { user, file, redirect: `${base.origin}${PREFIX}/callback`, browser: fresh(), verifier: fresh(), expires: now() + 600_000 })
      return `${base.origin}${PREFIX}/start?state=${state}`
    },
    async handle(req, res) {
      res.setHeader('cache-control', 'no-store')
      res.setHeader('referrer-policy', 'no-referrer')
      res.setHeader('content-security-policy', "default-src 'none'; frame-ancestors 'none'")
      res.setHeader('x-content-type-options', 'nosniff')
      const send = (status, text) => res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8' }).end(text)
      const url = new URL(req.url, 'https://controller.invalid')
      if (![`${PREFIX}/start`, `${PREFIX}/callback`].includes(url.pathname)) return send(404, 'Not found')
      if (!['GET', 'POST'].includes(req.method)) return send(405, 'Method not allowed')
      prune()
      const state = url.searchParams.get('state')
      const flow = pending.get(state)
      if (!flow || flow.completing) return send(410, 'This link expired or was already used. Run /link linear in Slack again.')
      const cookieName = `__Secure-linear-${state}`
      const cookie = `${cookieName}=${flow.browser}; Secure; HttpOnly; SameSite=Lax; Path=${PREFIX}; Max-Age=600`
      // A GET does not consume the link: Slack's link scanners may visit it before the person does.
      if (url.pathname === `${PREFIX}/start` && req.method === 'GET') {
        res.setHeader('set-cookie', cookie)
        return res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(`<!doctype html><meta charset="utf-8"><title>Connect Linear</title><h1>Connect your Linear account</h1><p>BoxLite will use your account for your requests in Slack DMs.</p><form method="post"><button>Continue to Linear</button></form>`)
      }
      if (!(req.headers.cookie ?? '').split(';').some((c) => c.trim() === `${cookieName}=${flow.browser}`)) return send(403, 'Open the private link from Slack in this browser first.')
      try {
        if (url.pathname === `${PREFIX}/start`) {
          if (flow.started) return send(409, 'This login has already started. Run /link linear again to retry.')
          flow.started = true
          registration ??= post('register', { client_name: 'BoxLite for Slack', redirect_uris: [flow.redirect], grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none' }, true).catch((e) => { registration = null; throw e })
          flow.client = await registration
          if (!flow.client.client_id) throw new Error('Linear did not register a client')
          const params = new URLSearchParams({ response_type: 'code', client_id: flow.client.client_id, redirect_uri: flow.redirect, state, scope, resource: RESOURCE, code_challenge_method: 'S256', code_challenge: createHash('sha256').update(flow.verifier).digest('base64url') })
          return res.writeHead(303, { location: `${ISSUER}/authorize?${params}` }).end()
        }
        if (req.method !== 'GET') return send(405, 'Method not allowed')
        if (!flow.client) return send(400, 'Start the login from Slack first.')
        flow.completing = true // claim once, before any network or disk await
        res.setHeader('set-cookie', cookie.replace('Max-Age=600', 'Max-Age=0'))
        if (url.searchParams.has('error')) {
          pending.delete(state)
          return send(400, 'Linear was not connected. Run /link linear again to retry.')
        }
        const code = url.searchParams.get('code')
        if (!code || (url.searchParams.has('iss') && url.searchParams.get('iss') !== ISSUER)) {
          pending.delete(state)
          return send(400, 'Invalid Linear authorization response.')
        }
        const client = flow.client
        const tokens = await post('token', { grant_type: 'authorization_code', code, client_id: client.client_id, ...(client.client_secret ? { client_secret: client.client_secret } : {}), redirect_uri: flow.redirect, code_verifier: flow.verifier, resource: RESOURCE })
        if (!tokens.access_token || !tokens.refresh_token || !(Number(tokens.expires_in) > 0)) throw new Error('Incomplete Linear token response')
        if (pending.get(state) !== flow || flow.expires <= now()) throw new Error('Login expired')
        const record = { token_endpoint: `${ISSUER}/token`, client_id: client.client_id, ...(client.client_secret ? { client_secret: client.client_secret } : {}), resource: RESOURCE, access_token: tokens.access_token, refresh_token: tokens.refresh_token, expires_at: now() + Number(tokens.expires_in) * 1000, linked_at: new Date(now()).toISOString() }
        await mkdir(path.dirname(flow.file), { recursive: true, mode: 0o700 })
        const temp = `${flow.file}.${state}.tmp`
        await writeFile(temp, JSON.stringify(record), { mode: 0o600 })
        await rename(temp, flow.file)
        pending.delete(state)
        return send(200, 'Linear connected. Return to Slack and ask BoxLite in a direct message.')
      } catch {
        pending.delete(state)
        return send(502, 'Could not connect Linear. Run /link linear in Slack again to retry.')
      }
    },
  }
}
