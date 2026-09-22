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
const SLACK_THREAD_TTL_MS = 90 * 86_400_000 // a Slack thread quiet this long is forgotten; its next mention starts afresh
const KNOWN = ['lastModified', 'seen', 'threads', 'usage', 'grants', 'paused', 'forks', 'codex', 'deploy', 'slack']

/** Slack's memory, apart from GitHub's (slack-channel.mjs): the ids of both could collide. */
const slackPart = (raw = {}) => ({
  seen: new Set(raw.seen ?? []), // "C…:<ts>" messages handled
  threads: raw.threads ?? {}, // "T…/C…/<thread ts>" → { sessionId, lastTs, lastUsed, label (its box's name) }
  usage: raw.usage ?? {}, // Slack user id → { day: 'YYYY-MM-DD', count }
  deferred: raw.deferred ?? [], // requests accepted by a controller that was shutting down
})

/**
 * The memory of the Slack agent this bot took over (its state.json, handed over at the switch):
 * its threads carry on here — same volume, same context keys — and what it handled isn't redone.
 */
export function importSlackState(state, raw) {
  for (const id of raw.seen ?? []) state.slack.seen.add(id)
  for (const [key, t] of Object.entries(raw.threads ?? {})) {
    const ours = state.slack.threads[key]
    if (!ours || Date.parse(t.lastUsed) > Date.parse(ours.lastUsed)) state.slack.threads[key] = t
  }
  for (const req of raw.deferred ?? []) if (!state.slack.deferred.some((d) => d.id === req.id)) state.slack.deferred.push(req)
}

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
    slack: slackPart(raw.slack),
  }
}

export async function saveState(file, state, now = Date.now()) {
  const seen = [...state.seen].slice(-MAX_SEEN)
  state.seen = new Set(seen)
  const s = state.slack
  s.seen = new Set([...s.seen].slice(-MAX_SEEN))
  for (const [key, t] of Object.entries(s.threads)) if (now - Date.parse(t.lastUsed) > SLACK_THREAD_TTL_MS) delete s.threads[key]
  const slack = { seen: [...s.seen], threads: s.threads, usage: s.usage, deferred: s.deferred }
  const { lastModified, threads, usage, grants, paused, forks, codex, deploy } = state
  const data = JSON.stringify({ ...state.unknown, lastModified, seen, threads, usage, grants, paused, forks, codex, deploy, slack })
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
