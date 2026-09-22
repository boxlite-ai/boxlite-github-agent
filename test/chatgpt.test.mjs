import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { EventEmitter } from 'node:events'
import { signJobToken, verifyJobToken, jobTokens, chatgptLogin, parseDevicePrompt, deviceLogin, codexModels, CLIENT_ID, BOX_ACCOUNT_ID } from '../src/chatgpt.mjs'

const SECRET = Buffer.from('job-secret')
const future = () => Math.floor(Date.now() / 1000) + 60

test('codexModels: the catalog for a Codex version, with the real login; an expired token is refreshed once', async () => {
  let token = 'at-old'
  const login = { get: () => ({ access_token: token, account_id: 'acct-real' }), refresh: async () => (token = 'at-new') }
  const calls = []
  const fetchImpl = async (url, init) => {
    calls.push({ url, auth: init.headers.authorization, account: init.headers['chatgpt-account-id'] })
    if (init.headers.authorization === 'Bearer at-old') return new Response('{}', { status: 401 })
    return Response.json({ models: [
      { slug: 'gpt-6-astra', visibility: 'list', supported_reasoning_levels: [{ effort: 'high' }, { effort: 'xhigh' }] },
      { slug: 'gpt-reserve', visibility: 'hide', supported_reasoning_levels: [{ effort: 'low' }] },
    ] })
  }
  assert.deepEqual(await codexModels({ login, clientVersion: '0.155.1', upstream: 'https://chatgpt.test', fetchImpl }), [
    { slug: 'gpt-6-astra', efforts: ['high', 'xhigh'], listed: true },
    { slug: 'gpt-reserve', efforts: ['low'], listed: false },
  ])
  assert.deepEqual(calls.map((c) => [c.url, c.auth, c.account]), [
    ['https://chatgpt.test/backend-api/codex/models?client_version=0.155.1', 'Bearer at-old', 'acct-real'],
    ['https://chatgpt.test/backend-api/codex/models?client_version=0.155.1', 'Bearer at-new', 'acct-real'],
  ])
  await assert.rejects(codexModels({ login, clientVersion: '0.155.1', fetchImpl: async () => new Response('', { status: 503 }) }), /answered 503/)
})

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


test('login: no source yet → false; a device login done in this box counts; the newest source wins', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'cg-'))
  const file = path.join(dir, 'chatgpt.json')
  const codexAuthFile = path.join(dir, 'codex-login', 'auth.json')
  const none = chatgptLogin({ file, codexAuthFile })
  assert.equal(await none.load(), false)

  mkdirSync(path.dirname(codexAuthFile))
  writeFileSync(codexAuthFile, JSON.stringify({ tokens: { access_token: 'at-dev', refresh_token: 'rt-dev', account_id: 'acct-dev' }, last_refresh: '2026-09-21T10:00:00Z' }))
  const fromDevice = chatgptLogin({ file, codexAuthFile, initial: { ...initial, last_refresh: '2026-09-01T00:00:00Z' } })
  assert.equal(await fromDevice.load(), true)
  assert.equal(fromDevice.get().refresh_token, 'rt-dev') // newer than the deploy seed

  writeFileSync(file, JSON.stringify({ access_token: 'at-own', refresh_token: 'rt-own', account_id: 'acct-dev', last_refresh: '2026-09-28T00:00:00Z' }))
  const own = chatgptLogin({ file, codexAuthFile })
  await own.load()
  assert.equal(own.get().refresh_token, 'rt-own') // our rotated copy is newest
})

test('parseDevicePrompt: link and one-time code out of the coloured Codex output', () => {
  const out = '\x1b[94mhttps://auth.openai.com/codex/device\x1b[0m\n\n2. Enter this one-time code \x1b[90m(expires in 15 minutes)\x1b[0m\n   \x1b[94mQ0F1-3ACRA\x1b[0m\n'
  assert.deepEqual(parseDevicePrompt(out), { url: 'https://auth.openai.com/codex/device', code: 'Q0F1-3ACRA' })
  assert.equal(parseDevicePrompt('Welcome to Codex'), null)
})

test('deviceLogin: runs codex login --device-auth in the given home, reports the prompt once, resolves with the exit code', async () => {
  const calls = []
  const spawnImpl = (bin, args, opts) => {
    calls.push({ bin, args, env: opts.env })
    const child = new EventEmitter()
    child.stdout = new EventEmitter()
    child.stderr = new EventEmitter()
    setTimeout(() => {
      child.stdout.emit('data', '1. Open https://auth.openai.com/codex/device\n')
      child.stdout.emit('data', '2. Enter this one-time code\n   ABCD-EFGHI\n')
      child.stdout.emit('data', 'ABCD-EFGHI again\n')
      child.emit('close', 0)
    }, 5)
    return child
  }
  const prompts = []
  const code = await deviceLogin({ codexHome: '/state/codex-login', onPrompt: (p) => prompts.push(p), spawnImpl })
  assert.equal(code, 0)
  assert.deepEqual(prompts, [{ url: 'https://auth.openai.com/codex/device', code: 'ABCD-EFGHI' }])
  assert.deepEqual(calls[0].args, ['login', '--device-auth', '-c', 'cli_auth_credentials_store="file"'])
  assert.equal(calls[0].env.CODEX_HOME, '/state/codex-login')
})
