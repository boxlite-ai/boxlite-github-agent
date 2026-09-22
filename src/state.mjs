// The service's memory, one JSON file on the controller box's own disk (root-only) — never the
// shared volume, which every session box can write: which comments were handled, each thread's
// Codex session, per-user daily usage, the notifications cursor, who an admin let ask for PRs
// where, whether PR writing is paused, the bot's fork of each repo, and the model turns run on.
// Small by design — written atomically after every change, so a crash never loses or tears it.
// Fields this build doesn't know are kept as they are: a build rolled back to, or one from before
// a field existed, must not drop what a newer one saved (seen live: a restart onto old code
// dropped the /model setting).
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises'
import path from 'node:path'

const MAX_SEEN = 10_000 // comment ids to remember; older ones are far outside any re-read window
const KNOWN = ['lastModified', 'seen', 'threads', 'usage', 'grants', 'paused', 'forks', 'codex', 'deploy']

export async function loadState(file) {
  let raw = {}
  try {
    raw = JSON.parse(await readFile(file, 'utf8'))
  } catch (e) {
    if (e.code !== 'ENOENT') throw e
  }
  const unknown = Object.fromEntries(Object.entries(raw).filter(([k]) => !KNOWN.includes(k)))
  return {
    unknown, // written back untouched
    lastModified: raw.lastModified ?? null,
    seen: new Set(raw.seen ?? []),
    threads: raw.threads ?? {}, // "owner/repo#n" → { user, sessionId, headSha, lastUsed }
    usage: raw.usage ?? {}, // github login → { day: 'YYYY-MM-DD', count }
    grants: raw.grants ?? {}, // "owner/repo" (lower case) → GitHub user id → { login, by, at }
    paused: raw.paused ?? null, // { by, at } while an admin has PR writing paused
    forks: raw.forks ?? {}, // "owner/repo" (lower case) → the bot's fork, "bot/repo"
    codex: raw.codex ?? null, // { model, effort, by, at } from an admin's /model
    deploy: raw.deploy ?? null, // { from, to, by, at, reply } while an admin's /deploy waits for the new build
  }
}

export async function saveState(file, state) {
  const seen = [...state.seen].slice(-MAX_SEEN)
  state.seen = new Set(seen)
  const { lastModified, threads, usage, grants, paused, forks, codex, deploy } = state
  const data = JSON.stringify({ ...state.unknown, lastModified, seen, threads, usage, grants, paused, forks, codex, deploy })
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 })
  const tmp = `${file}.${process.pid}.tmp`
  await writeFile(tmp, data, { mode: 0o600 })
  await rename(tmp, file)
}

/** Count one request for `login` today; false once they've reached `limit` (the day rolls over at UTC midnight). */
export function takeQuota(state, login, limit, now = new Date()) {
  const day = now.toISOString().slice(0, 10)
  const u = state.usage[login]?.day === day ? state.usage[login] : { day, count: 0 }
  if (u.count >= limit) return false
  state.usage[login] = { day, count: u.count + 1 }
  return true
}

/** Requests `login` has left today — yesterday's count no longer applies after UTC midnight. */
export function quotaLeft(state, login, limit, now = new Date()) {
  const u = state.usage[login]
  return u?.day === now.toISOString().slice(0, 10) ? Math.max(0, limit - u.count) : limit
}
