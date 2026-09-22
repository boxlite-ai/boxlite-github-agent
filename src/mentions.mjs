// @botlite's GitHub notifications → requests. GitHub never pushes a user's mentions, so we poll
// GET /notifications (conditional on Last-Modified — a 304 is free) at the X-Poll-Interval it
// asks for, then read each thread's new comments ourselves and keep the ones addressed to us.

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** Does `body` address @login? Quoted lines and code are ignored, so quoting an old request never re-runs it. */
export function mentions(body, login) {
  const text = String(body || '')
    .replace(/```[\s\S]*?```/g, '')
    .replace(/`[^`\n]*`/g, '')
    .split('\n')
    .filter((line) => !/^\s*>/.test(line))
    .join('\n')
  return new RegExp(`(^|[^\\w@/.-])@${escapeRe(login)}(?![\\w-])`, 'i').test(text)
}

/**
 * What access.mjs needs about the author of an issue, PR or comment: their relation to the repo
 * (OWNER / MEMBER / COLLABORATOR count as maintainers) and whether the text was edited since it
 * was posted — people with write access can edit anyone's comment, so an edited one isn't proof.
 */
export const standing = (c) => ({ association: c.author_association ?? 'NONE', edited: Boolean(c.updated_at && c.created_at && c.updated_at !== c.created_at) })

/**
 * Unread notifications for threads the bot is in. `lastModified` makes an unchanged poll a
 * free 304; a full page means more may be waiting, so we page through before relying on it.
 * @returns {{ notifications: object[], lastModified: string|null, interval: number }}
 */
export async function poll(gh, lastModified) {
  const notifications = []
  let modified = lastModified
  let interval = 60
  for (let page = 1; page <= 5; page++) {
    const res = await gh.request('GET', `/notifications?participating=true&per_page=50&page=${page}`, {
      headers: page === 1 && lastModified ? { 'If-Modified-Since': lastModified } : {},
    })
    interval = Number(res.headers.get('x-poll-interval')) || interval
    if (res.status === 304) break
    if (!res.ok) throw new Error(`GET /notifications: ${res.status} ${(await res.text()).slice(0, 200)}`)
    if (page === 1) modified = res.headers.get('last-modified') || modified
    const batch = await res.json()
    notifications.push(...batch)
    if (batch.length < 50) break
  }
  return { notifications, lastModified: modified, interval }
}

/**
 * The new, not-yet-handled comments in one notification's thread that mention @login — the
 * issue/PR body, issue comments, and PR review comments. Public Issue/PullRequest threads only
 * (the bot's token is `public_repo`). Our own and other bots' comments never count.
 */
export async function requestsFrom(gh, n, { login, seen, now = Date.now() }) {
  const subject = subjectOf(n)
  if (!subject) return []
  const { repo, number } = subject
  // Re-read a little before the last read (clock skew); first sight looks back a day. `seen` dedupes.
  const since = new Date(n.last_read_at ? Date.parse(n.last_read_at) - 5 * 60e3 : now - 24 * 3600e3).toISOString()

  const issue = await gh.json('GET', `/repos/${repo}/issues/${number}`)
  const isPR = Boolean(issue.pull_request)
  const candidates = []
  if (Date.parse(issue.created_at) >= Date.parse(since)) {
    // Only a freshly opened issue/PR's body counts — a new comment on an old thread must not
    // re-trigger a stale @botlite in its first post.
    candidates.push({ id: `body:${repo}#${number}`, kind: 'body', body: issue.body, user: issue.user, createdAt: issue.created_at, url: issue.html_url, ...standing(issue) })
  }
  for (const c of await gh.json('GET', `/repos/${repo}/issues/${number}/comments?since=${since}&per_page=100`)) {
    candidates.push({ id: `ic:${c.id}`, kind: 'comment', commentId: c.id, body: c.body, user: c.user, createdAt: c.created_at, url: c.html_url, ...standing(c) })
  }
  if (isPR) {
    for (const c of await gh.json('GET', `/repos/${repo}/pulls/${number}/comments?since=${since}&per_page=100`)) {
      candidates.push({ id: `rc:${c.id}`, kind: 'review_comment', commentId: c.id, body: c.body, user: c.user, createdAt: c.created_at, url: c.html_url, path: c.path, line: c.line ?? c.original_line, ...standing(c) })
    }
  }

  const self = login.toLowerCase()
  return candidates
    .filter((c) => c.user && c.user.type !== 'Bot' && c.user.login.toLowerCase() !== self)
    .filter((c) => !seen.has(c.id) && mentions(c.body, login))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    .map((c) => ({
      ...c,
      author: c.user.login,
      userId: c.user.id,
      repo,
      number,
      isPR,
      thread: { title: issue.title, body: issue.body, url: issue.html_url, author: issue.user?.login, state: issue.state, comments: issue.comments ?? 0 },
    }))
}

export function markRead(gh, threadId) {
  return gh.json('PATCH', `/notifications/threads/${threadId}`)
}

/** The public issue or PR a notification is about — null for anything else. */
function subjectOf(n) {
  if (!['Issue', 'PullRequest'].includes(n.subject?.type) || !n.subject.url || n.repository?.private) return null
  return { repo: n.repository.full_name, number: Number(n.subject.url.split('/').pop()) }
}

/**
 * One poll's threads, read, and then the threads due a second look; each new request goes to
 * `accept` (`seen` dedupes). A thread is marked read *before* its comments are read: a comment
 * that lands meanwhile makes it unread again for the next poll, where marking it read afterwards
 * would hide that comment for good. `sweeps` (in the state: "repo#n" → { repo, number, since }) are
 * threads read again from `since` — see sweep().
 * @returns {boolean} whether every thread could be marked read (if not, keep the poll's cursor)
 */
export async function readThreads(gh, { notifications, sweeps, login, seen, accept, log = () => {} }) {
  let clean = true
  for (const n of notifications) {
    try {
      await markRead(gh, n.id)
    } catch (e) {
      clean = false // still unread: the next poll lists it again
      log(`notification ${n.id} (${n.repository?.full_name}): ${e.message}`)
      continue
    }
    try {
      for (const req of await requestsFrom(gh, n, { login, seen })) accept(req)
    } catch (e) {
      const subject = subjectOf(n)
      if (subject) sweep(sweeps, subject, n.last_read_at ?? null) // marked read, not read: next time, then
      log(`notification ${n.id} (${n.repository?.full_name}): ${e.message}`)
    }
  }
  for (const [key, s] of Object.entries(sweeps)) {
    const n = { subject: { type: 'Issue', url: `https://api.github.com/repos/${s.repo}/issues/${s.number}` }, repository: { full_name: s.repo, private: false }, last_read_at: s.since }
    try {
      for (const req of await requestsFrom(gh, n, { login, seen })) accept(req)
      delete sweeps[key]
    } catch (e) {
      if (e.status === 404 || e.status === 410) delete sweeps[key] // gone, or not ours to read
      log(`second look at ${key}: ${e.message}`)
    }
  }
  return clean
}

/**
 * A second look at a thread at the next poll, at what came in from `since` (ISO; null: the last
 * day) on — the earliest asked for wins. The bot's own comments need one: GitHub marks a thread
 * read when the bot comments in it, which hides every mention that arrived since the last poll
 * (so pass that poll's time) — the "✅ live" a new build posts before its first poll hides what
 * came in while the last one drained.
 */
export function sweep(sweeps, { repo, number }, since) {
  const key = `${repo}#${number}`
  const had = sweeps[key]
  const earliest = !had ? since : had.since === null || since === null ? null : Date.parse(since) < Date.parse(had.since) ? since : had.since
  sweeps[key] = { repo, number, since: earliest }
}
