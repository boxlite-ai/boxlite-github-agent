// The service's memory, one JSON file on the box's volume (root-only): which comments were
// handled, each thread's Codex session, per-user daily usage, and the notifications cursor.
// Small by design — written atomically after every change, so a crash never loses or tears it.
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises'
import path from 'node:path'

const MAX_SEEN = 10_000 // comment ids to remember; older ones are far outside any re-read window

export async function loadState(file) {
  let raw = {}
  try {
    raw = JSON.parse(await readFile(file, 'utf8'))
  } catch (e) {
    if (e.code !== 'ENOENT') throw e
  }
  return {
    lastModified: raw.lastModified ?? null,
    seen: new Set(raw.seen ?? []),
    threads: raw.threads ?? {}, // "owner/repo#n" → { user, sessionId, headSha, lastUsed }
    usage: raw.usage ?? {}, // github login → { day: 'YYYY-MM-DD', count }
  }
}

export async function saveState(file, state) {
  const seen = [...state.seen].slice(-MAX_SEEN)
  state.seen = new Set(seen)
  const data = JSON.stringify({ lastModified: state.lastModified, seen, threads: state.threads, usage: state.usage })
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
