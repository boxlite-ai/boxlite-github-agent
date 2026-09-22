import assert from 'node:assert/strict'
import { test } from 'node:test'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { selfBuild, deployPlan, markGood, cleanExit, takeRollback, deployOutcome, pendingAfter, sensitiveFiles, recordedBranch, recordBranch } from '../src/deploy.mjs'

const A = 'a'.repeat(40)
const B = 'b'.repeat(40)
const C = 'c'.repeat(40)
const D = 'd'.repeat(40)

test('selfBuild: commit and owner/repo from origin (https or ssh)', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'self-'))
  const git = (...a) => execFileSync('git', ['-C', dir, ...a], { encoding: 'utf8' }).trim()
  git('init', '-q', '-b', 'main')
  git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'x')
  git('remote', 'add', 'origin', 'https://example.com/x.git')
  for (const url of ['https://github.com/boxlite-ai/boxlite-github-agent.git', 'git@github.com:boxlite-ai/boxlite-github-agent.git', 'https://github.com/boxlite-ai/boxlite-github-agent']) {
    git('remote', 'set-url', 'origin', url)
    assert.deepEqual(selfBuild(dir), { dir, branch: 'main', ref: 'main', commit: git('rev-parse', 'HEAD'), repo: 'boxlite-ai/boxlite-github-agent' }, url)
  }
  assert.deepEqual(selfBuild(path.join(dir, 'nope')), { dir: path.join(dir, 'nope'), branch: null, ref: 'main', commit: null, repo: null })
})

test('selfBuild: the tracked branch is the one checked out — not a stale BOTLITE_REF; detached, the last one it was on', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'self-'))
  const git = (...a) => execFileSync('git', ['-C', dir, ...a], { encoding: 'utf8' }).trim()
  git('init', '-q', '-b', 'main')
  git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'x')
  // Seen live: the box was created with BOTLITE_REF=botlite-device-login, and later moved to main.
  assert.deepEqual([selfBuild(dir, { fallback: 'botlite-device-login' }).branch, selfBuild(dir, { fallback: 'botlite-device-login' }).ref], ['main', 'main'])
  const state = mkdtempSync(path.join(tmpdir(), 'state-'))
  assert.equal(recordedBranch(state), null)
  recordBranch(state, 'main')
  git('checkout', '-q', '--detach') // what a rollback leaves
  assert.deepEqual([selfBuild(dir, { recorded: recordedBranch(state), fallback: 'botlite-device-login' }).branch, selfBuild(dir, { recorded: recordedBranch(state), fallback: 'botlite-device-login' }).ref], [null, 'main'])
  assert.equal(selfBuild(dir, { fallback: 'botlite-device-login' }).ref, 'botlite-device-login') // only with nothing better
})

test('deployPlan: the commits on the branch since the running build, as GitHub compares them', async () => {
  const calls = []
  const gh = { json: async (m, p) => (calls.push(p), { status: 'ahead', commits: [{ sha: B, commit: { message: 'feat: one (#12)\n\nbody' } }, { sha: C, commit: { message: 'fix: two (#13)' } }] }) }
  assert.deepEqual(await deployPlan({ gh, build: { repo: 'acme/bot', commit: A, ref: 'main' } }), {
    from: A, to: C, status: 'ahead', commits: [{ sha: B, title: 'feat: one (#12)' }, { sha: C, title: 'fix: two (#13)' }],
  })
  assert.deepEqual(calls, [`/repos/acme/bot/compare/${A}...main`])
  const same = { json: async () => ({ status: 'identical', commits: [] }) }
  assert.deepEqual(await deployPlan({ gh: same, build: { repo: 'acme/bot', commit: A, ref: 'main' } }), { from: A, to: A, status: 'identical', commits: [] })
})

test('markGood / takeRollback: the launcher’s files in the state dir', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'good-'))
  writeFileSync(path.join(dir, 'boot.json'), JSON.stringify({ commit: A, tries: 2 }))
  markGood(dir, A)
  assert.equal(existsSync(path.join(dir, 'boot.json')), false) // tries reset
  assert.equal(JSON.parse(readFileSync(path.join(dir, 'good-build.json'), 'utf8')).commit, A)
  assert.equal(takeRollback(dir), null)
  writeFileSync(path.join(dir, 'rollback.json'), JSON.stringify({ from: B, to: A, at: 'T' }))
  assert.deepEqual(takeRollback(dir), { from: B, to: A, at: 'T' })
  assert.equal(takeRollback(dir), null) // read once
})

test('deployOutcome: live (on trial), rolled back, or not what was asked — said to whoever asked', () => {
  const pending = { from: A, to: B, by: 'root' }
  assert.equal(deployOutcome({ pending: null, running: B }), null)
  assert.equal(deployOutcome({ pending, running: B }), '@root ✅ `bbbbbbb` is live. If it fails in the next 10 minutes, I roll it back.')
  assert.equal(deployOutcome({ pending: { ...pending, live: true }, running: B }), null) // restarted during its trial: said already
  assert.equal(deployOutcome({ pending: { ...pending, live: true }, running: A, rollback: { from: B, to: A } }), "@root ⚠️ `bbbbbbb` failed three times before its 10-minute trial was up, so I'm on `aaaaaaa` again. Fix it on `main` and `/deploy` again.")
  assert.match(deployOutcome({ pending, running: A, rollback: { from: B, to: A, why: 'failed its pre-start check (src/main.mjs)' } }), /^@root ⚠️ `bbbbbbb` failed its pre-start check \(src\/main\.mjs\), so I'm on `aaaaaaa` again\./)
  assert.equal(deployOutcome({ pending, running: C }), "@root ⚠️ that deploy didn't take: I'm running `ccccccc`, not `bbbbbbb`.")
  assert.equal(deployOutcome({ pending: { from: A, to: C, by: 'root' }, running: D, rollback: { from: C, to: D } }), "@root ⚠️ `ccccccc` failed three times before its 10-minute trial was up, so I'm on `ddddddd`, the last good build. Fix it on `main` and `/deploy` again.")
})

test('deployOutcome: the gate stopped short of the deploy on a newer commit — live on trial, said once', () => {
  const pending = { from: A, to: C, by: 'root' } // /deploy asked for C; B, between, is the newest that passes
  const gate = { from: C, to: B, why: 'failed its pre-start check (test/start.test.mjs)' }
  assert.equal(deployOutcome({ pending, running: B, rollback: gate }), '@root ⚠️ `ccccccc` failed its pre-start check (test/start.test.mjs), so I went live on `bbbbbbb` instead, the newest commit before it that passes. Fix it on `main` and `/deploy` again. If `bbbbbbb` fails in the next 10 minutes, I roll it back.')
  const onTrial = pendingAfter({ pending, running: B, rollback: gate })
  assert.deepEqual(onTrial, { ...pending, to: B, live: true })
  // Every restart pulls the same broken main and the gate stops on B again: nothing new to say.
  assert.equal(deployOutcome({ pending: onTrial, running: B, rollback: gate }), null)
  assert.deepEqual(pendingAfter({ pending: onTrial, running: B, rollback: gate }), onTrial)
  // But if B fails its trial, the thread hears it.
  assert.match(deployOutcome({ pending: onTrial, running: A, rollback: { from: B, to: A } }), /^@root ⚠️ `bbbbbbb` failed three times before its 10-minute trial was up, so I'm on `aaaaaaa` again\./)
})

test('pendingAfter: a live deploy stays pending through its trial; a rollback or a miss ends it', () => {
  const pending = { from: A, to: B, by: 'root' }
  assert.deepEqual(pendingAfter({ pending, running: B }), { ...pending, live: true })
  assert.equal(pendingAfter({ pending, running: A, rollback: { from: B, to: A } }), null)
  assert.equal(pendingAfter({ pending, running: A, rollback: { from: B, to: A, why: 'failed its pre-start check (src/main.mjs)' } }), null)
  assert.equal(pendingAfter({ pending, running: C }), null)
  assert.equal(pendingAfter({ pending: null, running: B }), null)
})

test('cleanExit: a drained restart resets the launcher’s count — only crashes add up to a rollback', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'exit-'))
  writeFileSync(path.join(dir, 'boot.json'), JSON.stringify({ commit: A, tries: 2 }))
  cleanExit(dir, A)
  assert.deepEqual(JSON.parse(readFileSync(path.join(dir, 'boot.json'), 'utf8')), { commit: A, tries: 0 })
})

test('sensitiveFiles: the bot’s trust boundary — not its tests, docs or other code', () => {
  assert.deepEqual(sensitiveFiles(['src/access.mjs', 'src/publish.mjs', 'src/main.mjs', 'box/session.mjs', 'deploy/deploy.sh', 'src/codex.mjs', 'test/access.test.mjs', 'README.md', 'docs/pr.svg']), [
    'src/access.mjs', 'src/publish.mjs', 'src/main.mjs', 'box/session.mjs', 'deploy/deploy.sh',
  ])
})
