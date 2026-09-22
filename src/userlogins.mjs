// Per-user tool logins: each Slack person binds their OWN Linear / Notion / Google token
// (`ctl link <service> <user>`), and a turn uses the REQUESTER's token — so the bot only ever
// reads what that person can already see, and no one's private data reaches anyone else through it.
// There is no shared super-set login on the Slack side: a person who hasn't linked simply has no
// tools, and the bot tells them how (codex.mjs).
//
// A user's login lives under <stateDir>/user-logins/<login>/<user> — a raw key for Linear, the
// OAuth JSON (plus its refreshed `.live.json`) for the rest, exactly what oauth.mjs's keyLogin and
// oauthLogin read. Like the shared logins, the controller is their only holder; a box reaches them
// only through the tool broker with its per-turn job token, never the token itself.
import path from 'node:path'
import { readFile, readdir } from 'node:fs/promises'
import { keyLogin, oauthLogin } from './oauth.mjs'

// A user id we'll put in a path: a Slack user id is `U…`; never a `/`, `.` run or empty.
const USER = /^[A-Za-z0-9_-]{1,64}$/

/**
 * @param {string} dir  <stateDir>/user-logins
 * @param {Record<string,'key'|'oauth'>} kinds  login name → how it's stored (linear is a key, the rest OAuth)
 */
export function userLogins({ dir, kinds, fetchImpl = fetch }) {
  const cache = new Map()
  const fileFor = (login, user) => {
    if (!Object.hasOwn(kinds, login)) throw new Error(`no such tool login: ${login}`)
    if (!USER.test(user)) throw new Error(`bad user id: ${JSON.stringify(user)}`)
    return path.join(dir, login, user)
  }
  const make = (login, user) => {
    const file = fileFor(login, user)
    return kinds[login] === 'key'
      ? keyLogin(async () => (await readFile(file, 'utf8').catch(() => '')).trim() || null)
      : oauthLogin({ name: login[0].toUpperCase() + login.slice(1), file, fetchImpl })
  }
  const of = (login, user) => {
    const k = `${login}\u0000${user}`
    if (!cache.has(k)) cache.set(k, make(login, user))
    return cache.get(k)
  }
  /** Every (login, user) bound on disk — a user's file per login, its refreshed `.live.json` aside. */
  async function list() {
    const out = []
    for (const login of Object.keys(kinds)) {
      const names = await readdir(path.join(dir, login)).catch(() => [])
      for (const user of names) if (!user.endsWith('.live.json') && USER.test(user)) out.push({ login, user })
    }
    return out
  }
  return {
    kinds,
    fileFor,
    list,
    /** One user's logins loaded from disk: { <login>: loginObject }. Only the `ready()` ones can be used. */
    async forUser(user) {
      const out = {}
      await Promise.all(
        Object.keys(kinds).map(async (login) => {
          const l = of(login, user)
          await l.load()
          out[login] = l
        }),
      )
      return out
    },
    /** Keep idle OAuth logins alive (Notion drops one unused for 30 days), the way the shared ones were. */
    async keepAlive(log = () => {}) {
      for (const { login, user } of await list()) {
        const l = of(login, user)
        try {
          if ((await l.load()) && l.stale?.()) await l.refresh()
        } catch (e) {
          log(`${login} keep-alive for ${user}: ${e.message}`)
        }
      }
    },
    /** For the status line: how many people have linked what. */
    async summary() {
      const items = await list()
      if (!items.length) return 'none linked yet'
      const people = new Set(items.map((i) => i.user)).size
      const byLogin = Object.keys(kinds).map((n) => `${items.filter((i) => i.login === n).length} ${n}`).join(', ')
      return `${byLogin} (${people} ${people === 1 ? 'person' : 'people'})`
    },
  }
}
