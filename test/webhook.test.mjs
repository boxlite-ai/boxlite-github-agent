import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createHmac } from 'node:crypto'
import { verifyWebhook, requestsFromWebhook, webhookHandler } from '../src/webhook.mjs'

const SECRET = 'hook-secret'
const sign = (body, secret = SECRET) => `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`

test('verifyWebhook: only GitHub’s signature over the exact body passes', () => {
  const body = Buffer.from('{"a":1}')
  assert.equal(verifyWebhook(SECRET, body, sign(body)), true)
  assert.equal(verifyWebhook(SECRET, Buffer.from('{"a":2}'), sign(body)), false)
  assert.equal(verifyWebhook(SECRET, body, sign(body, 'other')), false)
  assert.equal(verifyWebhook(SECRET, body, undefined), false)
  assert.equal(verifyWebhook('', body, sign(body, '')), false) // no secret configured → nothing passes
})

const repository = { full_name: 'acme/app', private: false }
const user = (login, type = 'User') => ({ login, type })
const issue = { number: 7, title: 'Crash', body: 'it crashes', html_url: 'https://github.com/acme/app/issues/7', user: user('alice'), state: 'open', comments: 3 }
const pr = { number: 9, title: 'Fix', body: '@boxliteai review please', html_url: 'https://github.com/acme/app/pull/9', user: user('bob'), state: 'open', comments: 0, created_at: 'T0' }
const opts = { login: 'boxliteai', seen: new Set() }

test('requestsFromWebhook: each event becomes the same request the polling path builds', () => {
  const [ic] = requestsFromWebhook('issue_comment', { action: 'created', repository, issue, comment: { id: 11, body: '@boxliteai why?', user: user('carol'), created_at: 'T1', html_url: 'c11' } }, opts)
  assert.deepEqual({ id: ic.id, kind: ic.kind, commentId: ic.commentId, number: ic.number, isPR: ic.isPR, author: ic.author, repo: ic.repo, url: ic.url }, { id: 'ic:11', kind: 'comment', commentId: 11, number: 7, isPR: false, author: 'carol', repo: 'acme/app', url: 'c11' })
  assert.equal(ic.thread.comments, 3)

  const [body] = requestsFromWebhook('issues', { action: 'opened', repository, issue: { ...issue, body: '@boxliteai help', created_at: 'T2' } }, opts)
  assert.equal(body.id, 'body:acme/app#7') // same id the notification path uses → handled once

  const [prBody] = requestsFromWebhook('pull_request', { action: 'opened', repository, pull_request: pr }, opts)
  assert.deepEqual([prBody.id, prBody.isPR, prBody.kind], ['body:acme/app#9', true, 'body'])

  const [rc] = requestsFromWebhook('pull_request_review_comment', { action: 'created', repository, pull_request: pr, comment: { id: 21, body: '@boxliteai is this safe?', user: user('dave'), path: 'src/a.js', line: 42, created_at: 'T3', html_url: 'r21' } }, opts)
  assert.deepEqual([rc.id, rc.kind, rc.commentId, rc.path, rc.line, rc.isPR], ['rc:21', 'review_comment', 21, 'src/a.js', 42, true])
})

test('requestsFromWebhook: edits, other events, bots, ourselves, private repos, no mention, already seen → nothing', () => {
  const comment = (over = {}) => ({ id: 31, body: '@boxliteai hi', user: user('erin'), created_at: 'T', html_url: 'c', ...over })
  const cases = [
    ['issue_comment', { action: 'edited', repository, issue, comment: comment() }],
    ['push', { repository }],
    ['issue_comment', { action: 'created', repository, issue, comment: comment({ user: user('dependabot[bot]', 'Bot') }) }],
    ['issue_comment', { action: 'created', repository, issue, comment: comment({ user: user('BoxLiteAI') }) }],
    ['issue_comment', { action: 'created', repository: { ...repository, private: true }, issue, comment: comment() }],
    ['issue_comment', { action: 'created', repository, issue, comment: comment({ body: 'thanks @alice' }) }],
    ['issue_comment', { action: 'created', repository, issue, comment: comment({ body: '> @boxliteai quoted\n\nok' }) }],
  ]
  for (const [event, payload] of cases) assert.deepEqual(requestsFromWebhook(event, payload, opts), [], `${event} ${payload.action}`)
  assert.deepEqual(requestsFromWebhook('issue_comment', { action: 'created', repository, issue, comment: comment() }, { ...opts, seen: new Set(['ic:31']) }), [])
})

function deliver(handler, { event, body, signature }) {
  const res = { status: null, body: null, writeHead(s) { this.status = s }, end(b) { this.body = JSON.parse(b) } }
  const req = { headers: { 'x-github-event': event, 'x-hub-signature-256': signature }, async *[Symbol.asyncIterator]() { yield Buffer.from(body) } }
  return handler(req, res).then(() => res)
}

test('webhookHandler: 401 unsigned, pong to ping, 503 until live, 202 once accepted', async () => {
  const events = []
  let live = false
  const handler = webhookHandler({ secret: SECRET, onEvent: (e, p) => (live ? (events.push([e, p.action]), true) : false) })
  const body = JSON.stringify({ action: 'created' })
  assert.equal((await deliver(handler, { event: 'issue_comment', body, signature: 'sha256=00' })).status, 401)
  assert.equal((await deliver(handler, { event: 'ping', body: '{}', signature: sign('{}') })).status, 200)
  assert.equal((await deliver(handler, { event: 'issue_comment', body, signature: sign(body) })).status, 503)
  live = true
  assert.equal((await deliver(handler, { event: 'issue_comment', body, signature: sign(body) })).status, 202)
  assert.deepEqual(events, [['issue_comment', 'created']])
})
