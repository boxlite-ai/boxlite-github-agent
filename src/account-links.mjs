// A Slack member's private, short-lived browser login. Only the controller sees the tokens.
import { createHash, randomBytes } from 'node:crypto'
import { mkdir, writeFile, rename } from 'node:fs/promises'
import path from 'node:path'

const fresh = () => randomBytes(32).toString('base64url')

export function accountLinks({ baseUrl, userLogins, linearScope = 'read', fetchImpl = fetch, now = Date.now }) {
  const providers = {
    linear: { label: 'Linear', issuer: 'https://mcp.linear.app', resource: 'https://mcp.linear.app/mcp', scope: linearScope },
    notion: { label: 'Notion', issuer: 'https://mcp.notion.com', resource: 'https://mcp.notion.com/mcp', scope: 'default', max_age_days: 180 },
  }
  const pending = new Map()
  const registrations = new Map()
  const post = async (url, body, json = false) => {
    const res = await fetchImpl(url, {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15_000),
      headers: { 'content-type': json ? 'application/json' : 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: json ? JSON.stringify(body) : new URLSearchParams(body).toString(),
    })
    if (!res.ok) throw new Error(`OAuth request failed: HTTP ${res.status}`)
    return res.json()
  }
  const prune = () => {
    for (const [state, flow] of pending) if (flow.expires <= now()) pending.delete(state)
  }
  return {
    begin(service, user) {
      if (!Object.hasOwn(providers, service)) throw new Error('Use /link linear or /link notion to connect your own account.')
      const provider = providers[service]
      const file = userLogins.fileFor(service, user)
      const base = new URL(baseUrl())
      if (base.protocol !== 'https:') throw new Error('Account linking requires a public HTTPS URL')
      prune()
      for (const [state, flow] of pending) {
        if (flow.user !== user || flow.service !== service) continue
        if (flow.completing) throw new Error('Account linking is completing; try again shortly')
        pending.delete(state)
      }
      if (pending.size >= 1000) throw new Error('Too many logins in progress; try again later')
      const state = fresh()
      const prefix = `/link/${service}`
      pending.set(state, { user, service, file, redirect: `${base.origin}${prefix}/callback`, browser: fresh(), verifier: fresh(), expires: now() + 600_000 })
      return { url: `${base.origin}${prefix}/start?state=${state}`, label: provider.label }
    },
    async handle(req, res) {
      res.setHeader('cache-control', 'no-store')
      res.setHeader('referrer-policy', 'no-referrer')
      res.setHeader('content-security-policy', "default-src 'none'; frame-ancestors 'none'")
      res.setHeader('x-content-type-options', 'nosniff')
      const send = (status, text) => res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8' }).end(text)
      const url = new URL(req.url, 'https://controller.invalid')
      const [, service, step] = /^\/link\/([a-z]+)\/(start|callback)$/.exec(url.pathname) ?? []
      if (!Object.hasOwn(providers, service)) return send(404, 'Not found')
      const { label, issuer, resource, scope, max_age_days } = providers[service]
      const prefix = `/link/${service}`
      const retry = `Run /link ${service} in Slack again.`
      if (!['GET', 'POST'].includes(req.method)) return send(405, 'Method not allowed')
      prune()
      const state = url.searchParams.get('state')
      const flow = pending.get(state)
      if (!flow || flow.service !== service || flow.completing) return send(410, `This link expired or was already used. ${retry}`)
      const cookieName = `__Secure-${service}-${state}`
      const cookie = `${cookieName}=${flow.browser}; Secure; HttpOnly; SameSite=Lax; Path=${prefix}; Max-Age=600`
      // A GET does not consume the link: Slack's link scanners may visit it before the person does.
      if (step === 'start' && req.method === 'GET') {
        res.setHeader('set-cookie', cookie)
        return res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(`<!doctype html><meta charset="utf-8"><title>Connect ${label}</title><h1>Connect your ${label} account</h1><p>BoxLite will use your account for your requests in Slack DMs.</p><form method="post"><button>Continue to ${label}</button></form>`)
      }
      if (!(req.headers.cookie ?? '').split(';').some((c) => c.trim() === `${cookieName}=${flow.browser}`)) return send(403, 'Open the private link from Slack in this browser first.')
      try {
        if (step === 'start') {
          if (flow.started) return send(409, `This login has already started. ${retry}`)
          flow.started = true
          if (!registrations.has(flow.redirect)) {
            const registration = post(`${issuer}/register`, { client_name: 'BoxLite for Slack', redirect_uris: [flow.redirect], grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none' }, true).catch((e) => { registrations.delete(flow.redirect); throw e })
            registrations.set(flow.redirect, registration)
          }
          flow.client = await registrations.get(flow.redirect)
          if (!flow.client.client_id) throw new Error('Provider did not register a client')
          const params = new URLSearchParams({ response_type: 'code', client_id: flow.client.client_id, redirect_uri: flow.redirect, state, scope, resource, code_challenge_method: 'S256', code_challenge: createHash('sha256').update(flow.verifier).digest('base64url') })
          return res.writeHead(303, { location: `${issuer}/authorize?${params}` }).end()
        }
        if (req.method !== 'GET') return send(405, 'Method not allowed')
        if (!flow.client) return send(400, 'Start the login from Slack first.')
        flow.completing = true // claim once, before any network or disk await
        res.setHeader('set-cookie', cookie.replace('Max-Age=600', 'Max-Age=0'))
        if (url.searchParams.has('error')) {
          pending.delete(state)
          return send(400, `${label} was not connected. ${retry}`)
        }
        const code = url.searchParams.get('code')
        if (!code || (url.searchParams.has('iss') && url.searchParams.get('iss') !== issuer)) {
          pending.delete(state)
          return send(400, `Invalid ${label} authorization response.`)
        }
        const client = flow.client
        const tokens = await post(`${issuer}/token`, { grant_type: 'authorization_code', code, client_id: client.client_id, ...(client.client_secret ? { client_secret: client.client_secret } : {}), redirect_uri: flow.redirect, code_verifier: flow.verifier, resource })
        if (!tokens.access_token || !tokens.refresh_token || !(Number(tokens.expires_in) > 0)) throw new Error('Incomplete token response')
        if (pending.get(state) !== flow || flow.expires <= now()) throw new Error('Login expired')
        const record = { token_endpoint: `${issuer}/token`, client_id: client.client_id, ...(client.client_secret ? { client_secret: client.client_secret } : {}), resource, access_token: tokens.access_token, refresh_token: tokens.refresh_token, expires_at: now() + Number(tokens.expires_in) * 1000, linked_at: new Date(now()).toISOString(), ...(max_age_days ? { max_age_days } : {}) }
        await mkdir(path.dirname(flow.file), { recursive: true, mode: 0o700 })
        const temp = `${flow.file}.${state}.tmp`
        await writeFile(temp, JSON.stringify(record), { mode: 0o600 })
        await rename(temp, flow.file)
        pending.delete(state)
        return send(200, `${label} connected. Return to Slack and ask BoxLite in a direct message.`)
      } catch {
        pending.delete(state)
        return send(502, `Could not connect ${label}. ${retry}`)
      }
    },
  }
}
