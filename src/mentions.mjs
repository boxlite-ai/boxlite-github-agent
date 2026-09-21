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
  if (!['Issue', 'PullRequest'].includes(n.subject?.type) || !n.subject.url || n.repository?.private) return []
  const repo = n.repository.full_name
  const number = Number(n.subject.url.split('/').pop())
  // Re-read a little before the last read (clock skew); first sight looks back a day. `seen` dedupes.
  const since = new Date(n.last_read_at ? Date.parse(n.last_read_at) - 5 * 60e3 : now - 24 * 3600e3).toISOString()

  const issue = await gh.json('GET', `/repos/${repo}/issues/${number}`)
  const isPR = Boolean(issue.pull_request)
  const candidates = []
  if (Date.parse(issue.created_at) >= Date.parse(since)) {
    // Only a freshly opened issue/PR's body counts — a new comment on an old thread must not
    // re-trigger a stale @botlite in its first post.
    candidates.push({ id: `issue:${issue.id}`, kind: 'body', body: issue.body, user: issue.user, createdAt: issue.created_at, url: issue.html_url })
  }
  for (const c of await gh.json('GET', `/repos/${repo}/issues/${number}/comments?since=${since}&per_page=100`)) {
    candidates.push({ id: `ic:${c.id}`, kind: 'comment', commentId: c.id, body: c.body, user: c.user, createdAt: c.created_at, url: c.html_url })
  }
  if (isPR) {
    for (const c of await gh.json('GET', `/repos/${repo}/pulls/${number}/comments?since=${since}&per_page=100`)) {
      candidates.push({ id: `rc:${c.id}`, kind: 'review_comment', commentId: c.id, body: c.body, user: c.user, createdAt: c.created_at, url: c.html_url, path: c.path, line: c.line ?? c.original_line })
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
      repo,
      number,
      isPR,
      thread: { title: issue.title, body: issue.body, url: issue.html_url, author: issue.user?.login, state: issue.state, comments: issue.comments ?? 0 },
    }))
}

export function markRead(gh, threadId) {
  return gh.json('PATCH', `/notifications/threads/${threadId}`)
}
