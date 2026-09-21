// The bot's ChatGPT login (from `codex login --device-auth`), held by the controller only.
//
// Session boxes never see it. Their Codex authenticates to the controller's proxy with a per-job
// token shaped like a ChatGPT access token — an HS256 JWT the controller signs; Codex decodes JWT
// claims but never verifies them (checked against 0.150.0) — and the proxy swaps in the real one.
// The controller also keeps the login alive: it refreshes the access token the way Codex does
// (same endpoint and OAuth client), and persists the rotated tokens on its own disk.
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises'
import path from 'node:path'

export const CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann' // Codex CLI's OAuth client (in the 0.150.0 binary)
const TOKEN_URL = 'https://auth.openai.com/oauth/token'
const REFRESH_AFTER_MS = 7 * 86_400_000 // Codex refreshes after 8 days; stay a day ahead
export const BOX_ACCOUNT_ID = 'botlite' // what boxes are told; the proxy sends the real one

const b64u = (v) => Buffer.from(typeof v === 'string' ? v : JSON.stringify(v)).toString('base64url')
const sign = (secret, data) => createHmac('sha256', secret).update(data).digest()

/** Per-job token: HS256 JWT with the claims Codex reads from a ChatGPT access token. */
export function signJobToken(secret, claims) {
  const head = `${b64u({ alg: 'HS256', typ: 'JWT' })}.${b64u(claims)}`
  return `${head}.${sign(secret, head).toString('base64url')}`
}

/** @returns the claims of an authentic, unexpired job token, else null. */
export function verifyJobToken(secret, token, now = Date.now()) {
  const parts = String(token || '').split('.')
  if (parts.length !== 3) return null
  const want = sign(secret, `${parts[0]}.${parts[1]}`)
  const got = Buffer.from(parts[2], 'base64url')
  if (got.length !== want.length || !timingSafeEqual(got, want)) return null
  try {
    const claims = JSON.parse(Buffer.from(parts[1], 'base64url'))
    return claims.exp * 1000 > now ? claims : null
  } catch {
    return null
  }
}

/** Issues one token per job and forgets it when the job ends — the proxy honours only live ones. */
export function jobTokens(secret) {
  const live = new Map() // jti → { requests }
  return {
    live,
    issue(ttlMs, thread) {
      const jti = randomBytes(12).toString('base64url')
      live.set(jti, { requests: 0 })
      const exp = Math.floor((Date.now() + ttlMs) / 1000)
      return signJobToken(secret, { jti, thread, exp, 'https://api.openai.com/auth': { chatgpt_plan_type: 'pro', chatgpt_account_id: BOX_ACCOUNT_ID } })
    },
    revoke(token) {
      const jti = JSON.parse(Buffer.from(String(token).split('.')[1], 'base64url')).jti
      live.delete(jti)
    },
  }
}

/**
 * The login itself. `initial` seeds it on a fresh controller (values may be BoxLite secret
 * placeholders — the platform swaps them in on the way to chatgpt.com / auth.openai.com); once
 * refreshed, the rotated tokens live in `file` (0600) and win over `initial` on restarts.
 */
export function chatgptLogin({ file, initial, fetchImpl = fetch }) {
  let tokens = null
  let inflight = null

  async function save() {
    await mkdir(path.dirname(file), { recursive: true, mode: 0o700 })
    const tmp = `${file}.${process.pid}.tmp`
    await writeFile(tmp, JSON.stringify(tokens), { mode: 0o600 })
    await rename(tmp, file)
  }

  return {
    async load() {
      try {
        tokens = JSON.parse(await readFile(file, 'utf8'))
      } catch (e) {
        if (e.code !== 'ENOENT') throw e
        tokens = { ...initial, last_refresh: initial.last_refresh || new Date(0).toISOString() }
      }
      if (!tokens.access_token || !tokens.refresh_token || !tokens.account_id) throw new Error('ChatGPT login incomplete: need access token, refresh token and account id')
    },
    get: () => tokens,
    stale: (now = Date.now()) => now - Date.parse(tokens.last_refresh) > REFRESH_AFTER_MS,
    /** Refresh once even if many requests hit an expired token at the same moment. */
    refresh() {
      inflight ??= (async () => {
        const res = await fetchImpl(TOKEN_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ client_id: CLIENT_ID, grant_type: 'refresh_token', refresh_token: tokens.refresh_token, scope: 'openid profile email' }),
        })
        if (!res.ok) throw new Error(`ChatGPT token refresh failed: ${res.status} ${(await res.text().catch(() => '')).slice(0, 200)}`)
        const t = await res.json()
        tokens = { ...tokens, access_token: t.access_token ?? tokens.access_token, refresh_token: t.refresh_token ?? tokens.refresh_token, last_refresh: new Date().toISOString() }
        await save()
      })().finally(() => {
        inflight = null
      })
      return inflight
    },
  }
}
