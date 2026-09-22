import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mentions, poll, requestsFrom } from '../src/mentions.mjs'

test('mentions: addressed to the bot, case-insensitive, anywhere in the text', () => {
  for (const body of ['@botlite review this', 'hey @botlite, why?', 'line one\n@BotLite explain', '(@botlite)']) {
    assert.equal(mentions(body, 'botlite'), true, body)
  }
})

test('mentions: not in emails, paths, longer handles, quotes or code', () => {
  for (const body of [
    'mail x@botlite.com',
    'see github.com/@botlite',
    '@botlite-dev please',
    '@botlites',
    '> @botlite do the thing\n\nthanks for the answer',
    'run `@botlite review`',
    '```\n@botlite review\n```',
    '',
    null,
  ]) {
    assert.equal(mentions(body, 'botlite'), false, String(body))
  }
})

function res(status, json, headers = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers(headers),
    json: async () => json,
    text: async () => JSON.stringify(json),
  }
}

test('poll: a 304 keeps the cursor and returns nothing', async () => {
  const calls = []
  const gh = { request: async (m, p, o) => (calls.push({ p, h: o.headers }), res(304, null, { 'x-poll-interval': '90' })) }
  const r = await poll(gh, 'Mon, 21 Sep 2026 14:00:00 GMT')
  assert.deepEqual(r, { notifications: [], lastModified: 'Mon, 21 Sep 2026 14:00:00 GMT', interval: 90 })
  assert.equal(calls[0].h['If-Modified-Since'], 'Mon, 21 Sep 2026 14:00:00 GMT')
})

test('poll: pages through a full page, cursor from the first page', async () => {
  const pages = [Array.from({ length: 50 }, (_, i) => ({ id: String(i) })), [{ id: 'last' }]]
  const gh = { request: async () => res(200, pages.shift(), { 'last-modified': 'T1', 'x-poll-interval': '60' }) }
  const r = await poll(gh, null)
  assert.equal(r.notifications.length, 51)
  assert.equal(r.lastModified, 'T1')
})

const NOW = Date.parse('2026-09-21T12:00:00Z')
const user = (login, type = 'User') => ({ login, type })

function fakeGh({ issue, comments = [], reviewComments = [] }) {
  const calls = []
  return {
    calls,
    json: async (method, path) => {
      calls.push(path)
      if (/\/issues\/\d+$/.test(path)) return issue
      if (/\/issues\/\d+\/comments/.test(path)) return comments
      if (/\/pulls\/\d+\/comments/.test(path)) return reviewComments
      throw new Error(`unexpected ${path}`)
    },
  }
}

const notification = (over = {}) => ({
  id: 'n1',
  subject: { type: 'PullRequest', url: 'https://api.github.com/repos/acme/app/pulls/7' },
  repository: { full_name: 'acme/app', private: false },
  last_read_at: '2026-09-21T11:00:00Z',
  ...over,
})

test('requestsFrom: new mentioning comments only — not ours, not bots, not seen, not unaddressed', async () => {
  const gh = fakeGh({
    issue: { id: 1, title: 'Fix it', body: 'old body @botlite', user: user('alice'), state: 'open', html_url: 'u', created_at: '2026-01-01T00:00:00Z', pull_request: {} },
    comments: [
      { id: 10, body: '@botlite why does this fail?', user: user('bob'), created_at: '2026-09-21T11:30:00Z', updated_at: '2026-09-21T11:40:00Z', html_url: 'c10' },
      { id: 11, body: 'unrelated', user: user('carol'), created_at: '2026-09-21T11:31:00Z', html_url: 'c11' },
      { id: 12, body: '@botlite loop', user: user('botlite'), created_at: '2026-09-21T11:32:00Z', html_url: 'c12' },
      { id: 13, body: '@botlite hi', user: user('dependabot[bot]', 'Bot'), created_at: '2026-09-21T11:33:00Z', html_url: 'c13' },
      { id: 14, body: '@botlite again', user: user('bob'), created_at: '2026-09-21T11:34:00Z', html_url: 'c14' },
    ],
    reviewComments: [{ id: 20, body: '@botlite is this line safe?', user: { ...user('dave'), id: 4 }, author_association: 'COLLABORATOR', created_at: '2026-09-21T11:20:00Z', updated_at: '2026-09-21T11:20:00Z', html_url: 'r20', path: 'src/a.js', line: 42 }],
  })
  const reqs = await requestsFrom(gh, notification(), { login: 'botlite', seen: new Set(['ic:14']), now: NOW })

  assert.deepEqual(reqs.map((r) => r.id), ['rc:20', 'ic:10']) // oldest first; body is old, 11–14 filtered
  assert.deepEqual({ ...reqs[0], thread: undefined, user: undefined }, {
    id: 'rc:20', kind: 'review_comment', commentId: 20, body: '@botlite is this line safe?', createdAt: '2026-09-21T11:20:00Z',
    url: 'r20', path: 'src/a.js', line: 42, author: 'dave', repo: 'acme/app', number: 7, isPR: true, thread: undefined, user: undefined,
    userId: 4, association: 'COLLABORATOR', edited: false, // who they are to the repo, for access.mjs
  })
  assert.equal(reqs[1].thread.title, 'Fix it')
  assert.deepEqual([reqs[1].association, reqs[1].edited], ['NONE', true]) // edited after posting
  assert.ok(gh.calls.some((p) => p.includes('/issues/7/comments?since=2026-09-21T10:55:00.000Z'))) // last read − 5 min
})

test('requestsFrom: a freshly opened issue whose body mentions the bot is a request', async () => {
  const gh = fakeGh({ issue: { id: 5, title: 'Q', body: '@botlite how do I build this?', user: user('erin'), state: 'open', html_url: 'i5', created_at: '2026-09-21T11:59:00Z' } })
  const reqs = await requestsFrom(gh, notification({ subject: { type: 'Issue', url: 'https://api.github.com/repos/acme/app/issues/5' }, last_read_at: null }), { login: 'botlite', seen: new Set(), now: NOW })
  assert.deepEqual(reqs.map((r) => [r.id, r.kind, r.isPR, r.author]), [['body:acme/app#5', 'body', false, 'erin']])
  assert.equal(gh.calls.some((p) => p.includes('/pulls/')), false) // issues have no review comments
})

test('requestsFrom: private repos and non-issue subjects are skipped without API calls', async () => {
  const gh = fakeGh({})
  assert.deepEqual(await requestsFrom(gh, notification({ repository: { full_name: 'acme/secret', private: true } }), { login: 'botlite', seen: new Set(), now: NOW }), [])
  assert.deepEqual(await requestsFrom(gh, notification({ subject: { type: 'Release', url: 'x' } }), { login: 'botlite', seen: new Set(), now: NOW }), [])
  assert.equal(gh.calls.length, 0)
})
