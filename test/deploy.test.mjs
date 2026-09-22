import assert from 'node:assert/strict'
import { test } from 'node:test'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { selfBuild, deployPlan, markGood, takeRollback, deployOutcome, sensitiveFiles } from '../src/deploy.mjs'

const A = 'a'.repeat(40)
const B = 'b'.repeat(40)
const C = 'c'.repeat(40)

test('selfBuild: commit, owner/repo from origin (https or ssh) and the tracked branch', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'self-'))
  const git = (...a) => execFileSync('git', ['-C', dir, ...a], { encoding: 'utf8' }).trim()
  git('init', '-q')
  git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'x')
  git('remote', 'add', 'origin', 'https://example.com/x.git')
  for (const url of ['https://github.com/boxlite-ai/boxlite-github-agent.git', 'git@github.com:boxlite-ai/boxlite-github-agent.git', 'https://github.com/boxlite-ai/boxlite-github-agent']) {
    git('remote', 'set-url', 'origin', url)
    assert.deepEqual(selfBuild(dir, 'main'), { dir, ref: 'main', commit: git('rev-parse', 'HEAD'), repo: 'boxlite-ai/boxlite-github-agent' }, url)
  }
  assert.deepEqual(selfBuild(path.join(dir, 'nope')), { dir: path.join(dir, 'nope'), ref: 'main', commit: null, repo: null })
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

test('deployOutcome: live, rolled back, or not what was asked — said to whoever asked', () => {
  const pending = { from: A, to: B, by: 'root' }
  assert.equal(deployOutcome({ pending: null, running: B }), null)
  assert.equal(deployOutcome({ pending, running: B }), '@root ✅ `bbbbbbb` is live.')
  assert.match(deployOutcome({ pending, running: A, rollback: { from: B, to: A } }), /^@root ⚠️ `bbbbbbb` didn't come up — it failed to start three times, so I rolled back to `aaaaaaa`\./)
  assert.equal(deployOutcome({ pending, running: C }), "@root ⚠️ that deploy didn't take: I'm running `ccccccc`, not `bbbbbbb`.")
})

test('sensitiveFiles: the bot’s trust boundary — not its tests, docs or other code', () => {
  assert.deepEqual(sensitiveFiles(['src/access.mjs', 'src/publish.mjs', 'src/main.mjs', 'box/session.mjs', 'deploy/deploy.sh', 'src/codex.mjs', 'test/access.test.mjs', 'README.md', 'docs/pr.svg']), [
    'src/access.mjs', 'src/publish.mjs', 'src/main.mjs', 'box/session.mjs', 'deploy/deploy.sh',
  ])
})
