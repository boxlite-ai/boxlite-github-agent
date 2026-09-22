import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { keyLogin, oauthLogin } from '../src/oauth.mjs'

const T0 = Date.parse('2026-09-22T00:00:00Z')
const linked = (over = {}) => ({
  token_endpoint: 'https://mcp.notion.test/token', client_id: 'client-1', resource: 'https://mcp.notion.test/mcp',
  access_token: 'at-1', refresh_token: 'rt-1', expires_at: T0 + 3_600_000, linked_at: '2026-09-22T00:00:00.000Z', max_age_days: 180, ...over,
})
const fileWith = (login) => {
  const file = path.join(mkdtempSync(path.join(tmpdir(), 'oauth-')), 'notion-oauth.json')
  if (login) writeFileSync(file, JSON.stringify(login))
  return file
}

test('keyLogin: on once there is a key, which is its token; nothing to refresh', async () => {
  let key = ''
  const l = keyLogin(async () => key)
  assert.equal(await l.load(), false)
  assert.equal(l.describe(), null)
  key = 'lin_api_1'
  assert.equal(await l.load(), true)
  assert.equal(await l.token(), 'lin_api_1')
  assert.equal(l.refresh, null)
})

test('oauthLogin: off until linked; a token near expiry is refreshed first — once, however many ask — and the rotated one saved', async () => {
  let now = T0
  const calls = []
  const fetchImpl = async (url, init) => {
    calls.push({ url, form: Object.fromEntries(new URLSearchParams(init.body)) })
    await new Promise((r) => setTimeout(r, 5))
    return Response.json({ access_token: 'at-2', refresh_token: 'rt-2', expires_in: 28_800 })
  }
  const none = oauthLogin({ name: 'Notion', file: fileWith(null), fetchImpl })
  assert.equal(await none.load(), false)
  assert.equal(none.describe(), null)

  const file = fileWith(linked())
  const l = oauthLogin({ name: 'Notion', file, fetchImpl, now: () => now })
  assert.equal(await l.load(), true)
  assert.equal(await l.token(), 'at-1') // good for an hour yet: no refresh
  now = T0 + 3_600_000 - 60_000 // a minute left
  assert.deepEqual(await Promise.all([l.token(), l.token(), l.token()]), ['at-2', 'at-2', 'at-2'])
  assert.equal(calls.length, 1)
  assert.deepEqual(calls[0], { url: 'https://mcp.notion.test/token', form: { grant_type: 'refresh_token', refresh_token: 'rt-1', client_id: 'client-1', resource: 'https://mcp.notion.test/mcp' } })
  const saved = JSON.parse(readFileSync(file, 'utf8'))
  assert.deepEqual([saved.refresh_token, saved.access_token, saved.expires_at], ['rt-2', 'at-2', now + 28_800_000])
  assert.equal(statSync(file).mode & 0o777, 0o600)
  assert.equal(l.describe(), 'linked, link again by 2027-03-21')
})

test('oauthLogin: Google’s client secret goes along; a refresh without a new refresh token keeps the old one', async () => {
  let form
  const l = oauthLogin({ name: 'Google', file: fileWith(linked({ client_secret: 'cs', resource: undefined, max_age_days: undefined, account: 'botlite@acme.test' })), now: () => T0 + 7_200_000, fetchImpl: async (u, init) => ((form = Object.fromEntries(new URLSearchParams(init.body))), Response.json({ access_token: 'at-9', expires_in: 3600 })) })
  await l.load()
  assert.equal(await l.token(), 'at-9')
  assert.equal(form.client_secret, 'cs')
  assert.equal('resource' in form, false)
  assert.equal(l.describe(), 'as botlite@acme.test')
})

test('oauthLogin: a failed refresh throws and keeps the login; a new login from ctl replaces ours; a torn file is ignored', async () => {
  const file = fileWith(linked())
  const l = oauthLogin({ name: 'Notion', file, now: () => T0 + 7_200_000, fetchImpl: async () => new Response('{"error":"invalid_grant"}', { status: 400 }) })
  await l.load()
  await assert.rejects(l.token(), /Notion token refresh failed: 400 .*invalid_grant/)
  writeFileSync(file, '{"access_tok') // ctl mid-write
  assert.equal(await l.load(), true)
  writeFileSync(file, JSON.stringify(linked({ refresh_token: 'rt-new', linked_at: '2026-10-01T00:00:00.000Z', expires_at: T0 + 10 * 3_600_000 })))
  await l.load()
  assert.equal(await l.token(), 'at-1') // the new login's, fresh — no refresh needed
  assert.match(l.describe(), /link again by 2027-03-30/)
})

test('oauthLogin: idle for a week, it counts as stale — the controller refreshes it before Notion drops it', async () => {
  let now = T0
  const l = oauthLogin({ name: 'Notion', file: fileWith(linked()), now: () => now })
  await l.load()
  assert.equal(l.stale(), false)
  now = T0 + 8 * 86_400_000
  assert.equal(l.stale(), true)
})
