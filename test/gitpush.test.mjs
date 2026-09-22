import assert from 'node:assert/strict'
import { test, before, after } from 'node:test'
import http from 'node:http'
import { execFile, execFileSync } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { receivePackCommands, gitPushHandler } from '../src/gitpush.mjs'
import { jobTokens } from '../src/chatgpt.mjs'
import { gitServer } from './gitserver.mjs'

const pkt = (s) => `${(s.length + 4).toString(16).padStart(4, '0')}${s}`
const A = 'a'.repeat(40)
const B = 'b'.repeat(40)
const Z = '0'.repeat(40)

test('receivePackCommands: the ref updates before the pack, capabilities from the first line', () => {
  const body = Buffer.concat([Buffer.from(pkt(`${Z} ${A} refs/heads/x\0report-status side-band-64k agent=git/2.50\n`) + pkt(`${A} ${B} refs/tags/v1\n`) + '0000'), Buffer.from('PACK\0\0\0\x02')])
  assert.deepEqual(receivePackCommands(body), {
    commands: [{ old: Z, new: A, ref: 'refs/heads/x' }, { old: A, new: B, ref: 'refs/tags/v1' }],
    caps: ['report-status', 'side-band-64k', 'agent=git/2.50'],
  })
})

test('receivePackCommands: anything but plain ref updates is refused', () => {
  for (const body of [
    pkt(`shallow ${A}\n`) + pkt(`${A} ${B} refs/heads/x\n`) + '0000', // shallow lines
    pkt('push-cert\0report-status\n') + pkt('certificate version 0.1\n') + '0000', // signed push
    pkt(`${A} ${B}\n`) + '0000', // no ref
    pkt(`${A} ${B} refs/heads/x`), // no flush: truncated
    '00ff' + `${A} ${B} refs/heads/x`, // length past the end
    'GET / HTTP/1.1\r\n', // not git at all
    '',
  ]) {
    assert.throws(() => receivePackCommands(Buffer.from(body)), /git push|ref updates/, JSON.stringify(body))
  }
})

// Real git on both ends: `git push` → the controller's handler (job token + grant) → a fake
// github.com running `git http-backend` over the bot's "fork".
const execFileAsync = promisify(execFile)
const root = mkdtempSync(path.join(tmpdir(), 'gitpush-'))
const FORK = path.join(root, 'github', 'boxliteai', 'app.git')
const WORK = path.join(root, 'work')
const STAGING = 'refs/heads/botlite-staging/acme/app/7'
const SECRET = Buffer.from('job-secret')
const jobs = jobTokens(SECRET)
let github
let proxy
let base
let opens = 0
const logged = []
const grant = () => ({ ref: STAGING, open: async () => (opens++, { repo: 'boxliteai/app', token: 'ghs_turn_token' }) })

before(async () => {
  mkdirSync(path.dirname(FORK), { recursive: true })
  execFileSync('git', ['init', '-q', '--bare', FORK])
  execFileSync('git', ['init', '-q', '-b', 'main', WORK])
  writeFileSync(path.join(WORK, 'a.txt'), 'fix\n')
  execFileSync('git', ['-C', WORK, 'add', 'a.txt'])
  execFileSync('git', ['-C', WORK, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'fix'])
  github = await gitServer(path.join(root, 'github'), { refuse: { '/boxliteai/locked.git': [403, 'Permission to boxliteai/locked.git denied to botlite-push[bot].\n'] } })
  proxy = http.createServer(gitPushHandler({ secret: SECRET, jobs, upstream: github.url, maxPushes: 3, log: (l) => logged.push(l) }))
  await new Promise((r) => proxy.listen(0, '127.0.0.1', r))
  base = `http://127.0.0.1:${proxy.address().port}/git`
})
after(() => {
  proxy.close()
  github.close()
  rmSync(root, { recursive: true, force: true })
})

const push = (token, ...refspecs) =>
  execFileAsync('git', ['-C', WORK, '-c', `http.extraHeader=Authorization: Bearer ${token}`, 'push', '--quiet', '--force', base, ...refspecs], { env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } }).then(
    () => 'ok',
    (e) => e.stderr,
  )
const forkRef = (ref) => {
  try {
    return execFileSync('git', ['--git-dir', FORK, 'rev-parse', '--verify', '--quiet', ref], { encoding: 'utf8' }).trim()
  } catch {
    return null
  }
}

test('gitPushHandler: the granted ref goes through, with the App token — the job token stays behind', async () => {
  const t = jobs.issue(60_000, 'acme/app#7', { push: grant() })
  assert.equal(await push(t, `HEAD:${STAGING}`), 'ok')
  assert.equal(forkRef(STAGING), execFileSync('git', ['-C', WORK, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim())
  const reached = github.seen.map((s) => `${s.method} ${s.path}${s.query}`)
  assert.deepEqual(reached, ['GET /boxliteai/app.git/info/refs?service=git-receive-pack', 'POST /boxliteai/app.git/git-receive-pack'])
  for (const s of github.seen) assert.equal(s.auth, `Basic ${Buffer.from('x-access-token:ghs_turn_token').toString('base64')}`)
  jobs.revoke(t)
})

test('gitPushHandler: other refs, several refs, tags and deletes never reach GitHub', async () => {
  const posts = () => github.seen.filter((s) => s.method === 'POST').length
  const before = posts()
  for (const refspecs of [['HEAD:refs/heads/main'], [`HEAD:${STAGING}`, 'HEAD:refs/heads/main'], ['HEAD:refs/tags/v1'], [`:${STAGING}`]]) {
    const t = jobs.issue(60_000, 'acme/app#7', { push: grant() })
    assert.match(await push(t, ...refspecs), /403/, refspecs.join(' '))
    jobs.revoke(t)
  }
  assert.equal(posts(), before) // refused before forwarding: the pack never left the controller
  assert.equal(forkRef('refs/heads/main'), null)
  assert.equal(forkRef('refs/tags/v1'), null)
  assert.ok(forkRef(STAGING)) // not deleted
})

test('gitPushHandler: no push without a live token of a write turn; fetches are not proxied; a push budget', async () => {
  const call = (token, p = '/git/info/refs?service=git-receive-pack', method = 'GET') =>
    fetch(`http://127.0.0.1:${proxy.address().port}${p}`, { method, headers: token ? { authorization: `Bearer ${token}` } : {} }).then((r) => r.status)
  const opened = opens
  const readOnly = jobs.issue(60_000, 'acme/app#8') // a turn that may not publish
  const revoked = jobs.issue(60_000, 'acme/app#7', { push: grant() })
  jobs.revoke(revoked)
  for (const token of [null, 'a.b.c', readOnly, revoked, jobTokens(Buffer.from('other')).issue(60_000, 'x#1', { push: grant() })]) assert.equal(await call(token), 403)
  assert.equal(opens, opened) // nothing forked or minted for any of them

  const t = jobs.issue(60_000, 'acme/app#7', { push: grant() })
  assert.equal(await call(t, '/git/info/refs?service=git-upload-pack'), 404) // boxes fetch from GitHub directly
  assert.equal(await call(t, '/git/git-upload-pack', 'POST'), 404)
  for (let i = 0; i < 3; i++) assert.equal(await call(t, '/git/git-receive-pack', 'POST'), 400) // not a push: refused, but counted
  assert.equal(await call(t, '/git/git-receive-pack', 'POST'), 429)
  jobs.revoke(t)
  jobs.revoke(readOnly)
})

test('gitPushHandler: a refusal says why — to git, which shows it as `remote:` lines, and in the log', async () => {
  // GitHub's own, e.g. the push App's token not allowed on that fork: passed back as it came.
  const locked = jobs.issue(60_000, 'acme/app#7', { push: { ref: STAGING, open: async () => ({ repo: 'boxliteai/locked', token: 'ghs_turn_token' }) } })
  const out = await push(locked, `HEAD:${STAGING}`)
  assert.match(out, /remote: Permission to boxliteai\/locked\.git denied to botlite-push\[bot\]\.\n.*403/s)
  assert.ok(logged.includes("acme/app#7: GitHub answered 403 to the push's first step to boxliteai/locked: Permission to boxliteai/locked.git denied to botlite-push[bot]."), logged.join('\n'))
  jobs.revoke(locked)

  // The controller's own: a turn that's over, or one that may not push.
  assert.match(await push(locked, `HEAD:${STAGING}`), /remote: this turn may not push/)
  const readOnly = jobs.issue(60_000, 'acme/app#8')
  assert.match(await push(readOnly, `HEAD:${STAGING}`), /remote: this turn may not push/)
  jobs.revoke(readOnly)
  assert.ok(logged.includes('git push (acme/app#7): refused, no live turn'), logged.join('\n'))
  assert.ok(logged.includes('git push (acme/app#8): refused, no push granted'), logged.join('\n'))
})
