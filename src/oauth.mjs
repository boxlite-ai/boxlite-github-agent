// Logins to Linear, Notion and Google Workspace, held by the controller only. Each person binds
// their own with `ctl link` (userlogins.mjs keeps one per user); these are the building blocks.
//
// Linear's is an API key — nothing to refresh. Notion's and Google's are OAuth logins kept alive
// here the way chatgpt.mjs keeps the ChatGPT one: access tokens last hours, and refresh tokens
// rotate (Notion's on every refresh), so the controller is their one holder and saves each new one
// before using it. A login arrives from `ctl link notion|google` (deploy/login.mjs), done on the
// person's machine, as a file: { token_endpoint, client_id, client_secret?, resource?,
// access_token, refresh_token, expires_at, linked_at, max_age_days?, account? }.
import { mkdir, readFile, writeFile, rename, access } from 'node:fs/promises'
import path from 'node:path'

const exists = (f) => access(f).then(() => true, () => false)

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

/**
 * A refreshing OAuth login. `file` (0600) is the login as handed over — ctl writes it — and the
 * controller keeps the one it refreshes in a file of its own beside it (…live.json): the two never
 * write the same file, so a login linked again while a refresh is under way can't be overwritten
 * by that refresh. The newer link wins; of one link, the refreshed copy. `load()` is false until
 * one has been linked.
 */
export function oauthLogin({ name, file, fetchImpl = fetch, now = () => Date.now() }) {
  const live = file.replace(/(\.json)?$/, '.live.json')
  let tokens = null
  let inflight = null

  async function save(record) {
    await mkdir(path.dirname(live), { recursive: true, mode: 0o700 })
    const tmp = `${live}.${process.pid}.tmp`
    await writeFile(tmp, JSON.stringify(record), { mode: 0o600 })
    await rename(tmp, live)
  }

  function refresh() {
    inflight ??= (async () => {
      const from = tokens // the login this refresh is for
      const form = new URLSearchParams({ grant_type: 'refresh_token', refresh_token: from.refresh_token, client_id: from.client_id })
      if (from.client_secret) form.set('client_secret', from.client_secret)
      if (from.resource) form.set('resource', from.resource)
      const res = await fetchImpl(from.token_endpoint, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' }, body: form.toString() })
      if (!res.ok) throw new Error(`${name} token refresh failed: ${res.status} ${(await res.text().catch(() => '')).slice(0, 200)}`)
      const t = await res.json()
      if (tokens !== from) return // linked again meanwhile: the new login stands, this one is done
      if (!(await exists(live)) && !(await exists(file))) return // unlinked while refreshing: don't resurrect it
      tokens = { ...from, access_token: t.access_token, refresh_token: t.refresh_token ?? from.refresh_token, expires_at: now() + (t.expires_in ?? 3600) * 1000, refreshed_at: new Date(now()).toISOString() }
      await save(tokens) // before anything uses it: the old refresh token may already be dead
    })().finally(() => {
      inflight = null
    })
    return inflight
  }

  const read = async (f) => {
    try {
      const login = JSON.parse(await readFile(f, 'utf8'))
      return login?.refresh_token ? login : null
    } catch {
      return null // not there yet, or mid-write: it counts once it's whole
    }
  }

  return {
    /** Picks up the login on disk: one linked since (from ctl) replaces the one in memory; an
     * unlinked one (both files GONE, not merely torn mid-write) is dropped, so `ctl unlink` takes
     * effect on the next turn without a restart. */
    async load() {
      const [kept, handed] = await Promise.all([read(live), read(file)])
      // The newer link; of one link, ours (the sort keeps it first), which may have been refreshed since.
      const newest = [kept, handed].filter(Boolean).sort((a, b) => Date.parse(b.linked_at) - Date.parse(a.linked_at))[0]
      if (newest) {
        if (newest.linked_at !== tokens?.linked_at) tokens = newest
      } else if (tokens && !(await exists(live)) && !(await exists(file))) {
        tokens = null // both files gone: unlinked — but a torn file (still there) is ignored, kept
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
