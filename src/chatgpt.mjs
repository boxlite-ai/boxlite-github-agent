// The bot's ChatGPT login (from `codex login --device-auth`), held by the controller only.
//
// Session boxes never see it. Their Codex authenticates to the controller's proxy with a per-job
// token shaped like a ChatGPT access token — an HS256 JWT the controller signs; Codex decodes JWT
// claims but never verifies them (checked against 0.155.1) — and the proxy swaps in the real one.
// The controller also keeps the login alive: it refreshes the access token the way Codex does
// (same endpoint and OAuth client), and persists the rotated tokens on its own disk.
import { spawn } from 'node:child_process'
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises'
import path from 'node:path'

export const CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann' // Codex CLI's OAuth client (in the 0.150.0 and 0.155.1 binaries)
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

/**
 * Issues one token per job and forgets it when the job ends — the proxy honours only live ones.
 * `job` is the job's own record, kept by reference, so the caller reads what the turn did from it:
 * a write turn's `push` ({ ref, open }) is the one ref it may push (gitpush.mjs), and `tools` the
 * team's tool services it may use — none unless given — with its calls counted and its changes
 * listed in `writes` (tools.mjs).
 */
export function jobTokens(secret) {
  const live = new Map() // jti → the job: { push, tools, who, requests, pushes, toolCalls, writes, … }
  return {
    live,
    issue(ttlMs, thread, job = {}) {
      const jti = randomBytes(12).toString('base64url')
      live.set(jti, Object.assign(job, { push: job.push ?? null, tools: job.tools ?? [], requests: 0, pushes: 0, toolCalls: 0, writes: job.writes ?? [] }))
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
 * The models the Codex backend offers the bot's login at a Codex version — each with the reasoning
 * efforts it takes — so `/model` can refuse one no turn could run on. The backend lists a model only
 * to clients at or above its minimal version.
 * @returns {Promise<{ slug: string, efforts: string[], listed: boolean }[]>}
 */
export async function codexModels({ login, clientVersion, upstream = 'https://chatgpt.com', fetchImpl = fetch }) {
  const get = () => {
    const t = login.get()
    return fetchImpl(`${upstream}/backend-api/codex/models?client_version=${encodeURIComponent(clientVersion)}`, { headers: { authorization: `Bearer ${t.access_token}`, 'chatgpt-account-id': t.account_id } })
  }
  let res = await get()
  if (res.status === 401) {
    await login.refresh()
    res = await get()
  }
  if (!res.ok) throw new Error(`the Codex backend answered ${res.status}`)
  return ((await res.json()).models ?? []).map((m) => ({ slug: m.slug, efforts: (m.supported_reasoning_levels ?? []).map((l) => l.effort), listed: m.visibility === 'list' }))
}

/** The link and one-time code in `codex login --device-auth` output (colour codes stripped). */
export function parseDevicePrompt(text) {
  const plain = String(text).replace(/\x1b\[[0-9;]*m/g, '')
  const url = /https:\/\/auth\.openai\.com\/\S*device\S*/.exec(plain)?.[0]
  const code = /\b[A-Z0-9]{4}-[A-Z0-9]{4,6}\b/.exec(plain)?.[0]
  return url && code ? { url, code } : null
}

/**
 * Codex's device login, run in this box so the login is created where it's used. Resolves with
 * the exit code once it ends — approved, expired (15 min) or failed; `onPrompt({ url, code })`
 * fires once the link and one-time code are shown.
 */
export function deviceLogin({ codexHome, onPrompt, bin = 'codex', spawnImpl = spawn }) {
  return new Promise((resolve) => {
    const child = spawnImpl(bin, ['login', '--device-auth', '-c', 'cli_auth_credentials_store="file"'], {
      env: { PATH: process.env.PATH, HOME: codexHome, CODEX_HOME: codexHome, NO_COLOR: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let text = ''
    let shown = false
    const onData = (d) => {
      text += d
      const prompt = !shown && parseDevicePrompt(text)
      if (prompt) {
        shown = true
        onPrompt(prompt)
      }
    }
    child.stdout.on('data', onData)
    child.stderr.on('data', onData)
    child.on('error', () => resolve(127))
    child.on('close', (code) => resolve(code))
  })
}

const complete = (t) => Boolean(t?.access_token && t.refresh_token && t.account_id)
const readJson = async (file) => {
  try {
    return JSON.parse(await readFile(file, 'utf8'))
  } catch (e) {
    if (e.code === 'ENOENT') return null
    throw e
  }
}
/** A Codex auth.json (what `codex login --device-auth` writes) as our token shape. */
const fromCodexAuth = (a) => a?.tokens && { access_token: a.tokens.access_token, refresh_token: a.tokens.refresh_token, account_id: a.tokens.account_id, last_refresh: a.last_refresh }

/**
 * The login itself, from whichever source is newest (by last_refresh): `file` — our own copy,
 * rotated on every refresh (0600) —, `codexAuthFile` — a device login done in this box —, or
 * `initial` from the deploy (values may be BoxLite secret placeholders, swapped in by the platform
 * on the way to chatgpt.com / auth.openai.com). `load()` is false while there's no login yet.
 */
export function chatgptLogin({ file, initial = {}, codexAuthFile, fetchImpl = fetch }) {
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
      const own = await readJson(file)
      if (own && !complete(own)) throw new Error('ChatGPT login incomplete: need access token, refresh token and account id')
      const found = [own, fromCodexAuth(codexAuthFile && (await readJson(codexAuthFile))), initial]
        .filter(complete)
        .map((t) => ({ ...t, last_refresh: t.last_refresh || new Date(0).toISOString() }))
        .sort((a, b) => Date.parse(b.last_refresh) - Date.parse(a.last_refresh))
      tokens = found[0] ?? null
      return Boolean(tokens)
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
