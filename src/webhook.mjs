// GitHub App webhooks — the instant path, for repos that install the "BoxLite Agent" App. The bot
// is still the @boxliteai account and still replies with its own token; the App only delivers an
// event the moment it happens, instead of at the next notifications poll (~60 s + GitHub's own
// delay). Deliveries become the same request objects mentions.mjs builds, with the same ids, so a
// mention seen both ways is handled once. Repos without the App are unaffected: polling covers them.
import { createHmac, timingSafeEqual } from 'node:crypto'
import { mentions } from './mentions.mjs'

/** GitHub signs each delivery: X-Hub-Signature-256 = sha256=HMAC(secret, raw body). */
export function verifyWebhook(secret, body, signature) {
  if (!secret || !String(signature || '').startsWith('sha256=')) return false
  const want = Buffer.from(`sha256=${createHmac('sha256', secret).update(body).digest('hex')}`)
  const got = Buffer.from(signature)
  return got.length === want.length && timingSafeEqual(got, want)
}

const threadOf = (t) => ({ title: t.title, body: t.body, url: t.html_url, author: t.user?.login, state: t.state, comments: t.comments ?? 0 })

/** The requests in one delivery (0 or 1): a new comment / issue / PR / review comment mentioning @login. */
export function requestsFromWebhook(event, p, { login, seen }) {
  const repo = p?.repository?.full_name
  if (!repo || p.repository.private) return []
  let c
  if (event === 'issue_comment' && p.action === 'created') {
    c = { id: `ic:${p.comment.id}`, kind: 'comment', commentId: p.comment.id, number: p.issue.number, isPR: Boolean(p.issue.pull_request), thread: threadOf(p.issue), src: p.comment }
  } else if (event === 'issues' && p.action === 'opened') {
    c = { id: `body:${repo}#${p.issue.number}`, kind: 'body', number: p.issue.number, isPR: false, thread: threadOf(p.issue), src: p.issue }
  } else if (event === 'pull_request' && p.action === 'opened') {
    c = { id: `body:${repo}#${p.pull_request.number}`, kind: 'body', number: p.pull_request.number, isPR: true, thread: threadOf(p.pull_request), src: p.pull_request }
  } else if (event === 'pull_request_review_comment' && p.action === 'created') {
    const rc = p.comment
    c = { id: `rc:${rc.id}`, kind: 'review_comment', commentId: rc.id, path: rc.path, line: rc.line ?? rc.original_line, number: p.pull_request.number, isPR: true, thread: threadOf(p.pull_request), src: rc }
  }
  const user = c?.src.user
  if (!c || !user || user.type === 'Bot' || user.login.toLowerCase() === login.toLowerCase()) return []
  if (seen.has(c.id) || !mentions(c.src.body, login)) return []
  const { src, ...rest } = c
  return [{ ...rest, body: src.body, user, author: user.login, createdAt: src.created_at, url: src.html_url, repo }]
}

/**
 * The POST /webhook handler: verify the signature, answer GitHub fast (it retries slow or failed
 * deliveries), and hand the event to `onEvent(event, payload)` — false while the bot isn't live yet.
 */
export function webhookHandler({ secret, onEvent }) {
  return async (req, res) => {
    const chunks = []
    let size = 0
    for await (const c of req) {
      if ((size += c.length) > 26 * 1024 * 1024) return reply(res, 413, 'payload too large')
      chunks.push(c)
    }
    const body = Buffer.concat(chunks)
    if (!verifyWebhook(secret, body, req.headers['x-hub-signature-256'])) return reply(res, 401, 'bad signature')
    const event = req.headers['x-github-event']
    if (event === 'ping') return reply(res, 200, 'pong')
    let payload
    try {
      payload = JSON.parse(body)
    } catch {
      return reply(res, 400, 'bad json')
    }
    return (await onEvent(event, payload)) === false ? reply(res, 503, 'not live yet') : reply(res, 202, 'accepted')
  }
}

function reply(res, status, message) {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify({ message }))
}
