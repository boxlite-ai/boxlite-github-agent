import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { signJobToken, verifyJobToken, jobTokens, chatgptLogin, CLIENT_ID, BOX_ACCOUNT_ID } from '../src/chatgpt.mjs'

const SECRET = Buffer.from('job-secret')
const future = () => Math.floor(Date.now() / 1000) + 60

test('job tokens: verify only when authentic and unexpired', () => {
  const t = signJobToken(SECRET, { jti: 'j1', exp: future() })
  assert.equal(verifyJobToken(SECRET, t).jti, 'j1')
  assert.equal(verifyJobToken(Buffer.from('other'), t), null)
  const [h, b, s] = t.split('.')
  const forged = Buffer.from(JSON.stringify({ jti: 'j2', exp: future() })).toString('base64url')
  assert.equal(verifyJobToken(SECRET, `${h}.${forged}.${s}`), null)
  assert.equal(verifyJobToken(SECRET, signJobToken(SECRET, { jti: 'j3', exp: Math.floor(Date.now() / 1000) - 1 })), null)
  for (const junk of [undefined, '', 'a.b', 'a.b.c.d']) assert.equal(verifyJobToken(SECRET, junk), null)
})

test('jobTokens: a token Codex can read as a ChatGPT access token, live until revoked', () => {
  const jobs = jobTokens(SECRET)
  const t = jobs.issue(60_000, 'acme/app#7')
  const claims = verifyJobToken(SECRET, t)
  assert.equal(claims.thread, 'acme/app#7')
  assert.equal(claims['https://api.openai.com/auth'].chatgpt_account_id, BOX_ACCOUNT_ID) // never the real account
  assert.ok(jobs.live.has(claims.jti))
  jobs.revoke(t)
  assert.equal(jobs.live.has(claims.jti), false)
})

const initial = { access_token: '<BOXLITE_SECRET:chatgpt_access>', refresh_token: '<BOXLITE_SECRET:chatgpt_refresh>', account_id: 'acct-real' }

test('login: seeded from the deploy, refreshed once however many ask, rotated tokens persisted', async () => {
  const file = path.join(mkdtempSync(path.join(tmpdir(), 'cg-')), 'chatgpt.json')
  const calls = []
  const fetchImpl = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) })
    await new Promise((r) => setTimeout(r, 10))
    return { ok: true, status: 200, json: async () => ({ access_token: 'at-2', refresh_token: 'rt-2', id_token: 'id-2' }) }
  }
  const login = chatgptLogin({ file, initial, fetchImpl })
  await login.load()
  assert.equal(login.stale(), true) // unknown age → refresh early
  await Promise.all([login.refresh(), login.refresh(), login.refresh()])
  assert.equal(calls.length, 1)
  assert.equal(calls[0].url, 'https://auth.openai.com/oauth/token')
  assert.deepEqual(calls[0].body, { client_id: CLIENT_ID, grant_type: 'refresh_token', refresh_token: initial.refresh_token, scope: 'openid profile email' })
  assert.deepEqual([login.get().access_token, login.get().refresh_token, login.get().account_id], ['at-2', 'rt-2', 'acct-real'])
  assert.equal(login.stale(), false)
  assert.equal(statSync(file).mode & 0o777, 0o600)

  const restarted = chatgptLogin({ file, initial, fetchImpl }) // the rotated tokens win over the seed
  await restarted.load()
  assert.equal(restarted.get().refresh_token, 'rt-2')
})

test('login: a failed refresh throws and keeps the old tokens; an incomplete seed is refused', async () => {
  const file = path.join(mkdtempSync(path.join(tmpdir(), 'cg-')), 'chatgpt.json')
  const login = chatgptLogin({ file, initial, fetchImpl: async () => ({ ok: false, status: 400, text: async () => 'refresh_token_reused' }) })
  await login.load()
  await assert.rejects(login.refresh(), /ChatGPT token refresh failed: 400 refresh_token_reused/)
  assert.equal(login.get().refresh_token, initial.refresh_token)

  writeFileSync(file, JSON.stringify({ access_token: 'x' }))
  await assert.rejects(chatgptLogin({ file, initial }).load(), /ChatGPT login incomplete/)
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).access_token, 'x')
})
