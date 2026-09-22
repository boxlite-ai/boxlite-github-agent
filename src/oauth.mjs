// The bot's logins to Linear, Notion and Google Workspace, held by the controller only.
//
// Linear's is an API key — nothing to refresh, and in the deployed controller a BoxLite secret
// placeholder, like the Slack tokens. Notion's and Google's are OAuth logins kept alive here the
// way chatgpt.mjs keeps the ChatGPT one: access tokens last hours, and refresh tokens rotate
// (Notion's on every refresh), so the controller is their one holder and saves each new one before
// using it. A login arrives from `node deploy/ctl.mjs notion-login` / `google-login`, done on your
// machine (deploy/login.mjs), as a file: { token_endpoint, client_id, client_secret?, resource?,
// access_token, refresh_token, expires_at, linked_at, max_age_days?, account? }.
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises'
import path from 'node:path'

const EARLY_MS = 5 * 60_000 // refresh an access token this close to its expiry
const KEEP_ALIVE_MS = 7 * 86_400_000 // refresh an idle login this often (Notion drops one idle for 30 days)

/** A login that is just a key (Linear's API key), read by `read()` — from the env or a ctl file. */
export function keyLogin(read) {
  let key = null
  return {
    async load() {
      key = (await read()) || null
      return Boolean(key)
    },
    ready: () => Boolean(key),
    token: async () => key,
    refresh: null,
    describe: () => (key ? 'linked' : null),
  }
}

/** A refreshing OAuth login, kept in `file` (0600). `load()` is false until one has been linked. */
export function oauthLogin({ name, file, fetchImpl = fetch, now = () => Date.now() }) {
  let tokens = null
  let inflight = null

  async function save() {
    await mkdir(path.dirname(file), { recursive: true, mode: 0o700 })
    const tmp = `${file}.${process.pid}.tmp`
    await writeFile(tmp, JSON.stringify(tokens), { mode: 0o600 })
    await rename(tmp, file)
  }

  function refresh() {
    inflight ??= (async () => {
      const form = new URLSearchParams({ grant_type: 'refresh_token', refresh_token: tokens.refresh_token, client_id: tokens.client_id })
      if (tokens.client_secret) form.set('client_secret', tokens.client_secret)
      if (tokens.resource) form.set('resource', tokens.resource)
      const res = await fetchImpl(tokens.token_endpoint, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' }, body: form.toString() })
      if (!res.ok) throw new Error(`${name} token refresh failed: ${res.status} ${(await res.text().catch(() => '')).slice(0, 200)}`)
      const t = await res.json()
      tokens = { ...tokens, access_token: t.access_token, refresh_token: t.refresh_token ?? tokens.refresh_token, expires_at: now() + (t.expires_in ?? 3600) * 1000, refreshed_at: new Date(now()).toISOString() }
      await save() // before anything uses it: the old refresh token may already be dead
    })().finally(() => {
      inflight = null
    })
    return inflight
  }

  return {
    /** Picks up the login on disk. A new one (from ctl) replaces the one in memory; ours is never older than the file. */
    async load() {
      try {
        const disk = JSON.parse(await readFile(file, 'utf8'))
        if (disk?.refresh_token && disk.linked_at !== tokens?.linked_at) tokens = disk
      } catch {
        /* not linked yet, or a file mid-write: keep what we have */
      }
      return Boolean(tokens)
    },
    ready: () => Boolean(tokens),
    /** An access token that's good for a while yet. */
    async token() {
      if (now() > tokens.expires_at - EARLY_MS) await refresh()
      return tokens.access_token
    },
    refresh,
    /** Unused for a week: refresh anyway, so an idle login doesn't lapse. */
    stale: () => Boolean(tokens) && now() - Date.parse(tokens.refreshed_at ?? tokens.linked_at) > KEEP_ALIVE_MS,
    /** For the controller's status: whose login, and when it must be linked again (if it must). */
    describe() {
      if (!tokens) return null
      const by = tokens.max_age_days && new Date(Date.parse(tokens.linked_at) + tokens.max_age_days * 86_400_000).toISOString().slice(0, 10)
      return `${tokens.account ? `as ${tokens.account}` : 'linked'}${by ? `, link again by ${by}` : ''}`
    },
  }
}
