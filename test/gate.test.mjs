import assert from 'node:assert/strict'
import { test, after } from 'node:test'
import { execFileSync } from 'node:child_process'
import { chmodSync, copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

// The pull gate (deploy/post-merge.sh) as git runs it in the controller's checkout, on a copy of
// this build: a pull runs only up to its newest commit that passes (parses, the launcher's test,
// an offline start), or not at all. It is what still works when a deploy breaks the launcher, which
// src/main.mjs's own rollback can't survive.
const root = mkdtempSync(path.join(tmpdir(), 'gate-'))
after(() => rmSync(root, { recursive: true, force: true }))
const upstream = path.join(root, 'upstream')
const box = path.join(root, 'botlite')
const stateDir = path.join(root, 'state')
// Under `node --test` this env has NODE_TEST_CONTEXT, which makes a nested failing `node --test`
// exit 0: kept, so the gate is shown to shed it.
const env = { ...process.env, STATE_FILE: path.join(stateDir, 'state.json') }
const git = (dir, args, extra = {}) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', env: { ...env, ...extra } }).trim()
const commit = (message, files) => {
  for (const [f, text] of Object.entries(files)) writeFileSync(path.join(upstream, f), text)
  git(upstream, ['add', '-A'])
  git(upstream, ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', message])
  return git(upstream, ['rev-parse', 'HEAD'])
}
const takeRollback = () => {
  const file = path.join(stateDir, 'rollback.json')
  if (!existsSync(file)) return null
  const { from, to, why } = JSON.parse(readFileSync(file, 'utf8'))
  rmSync(file)
  return { from, to, why }
}

test('gate: a pull runs up to its newest commit that passes; with none, on the build it had', { timeout: 120_000 }, () => {
  for (const d of ['src', 'box', 'deploy']) cpSync(path.resolve(d), path.join(upstream, d), { recursive: true })
  mkdirSync(path.join(upstream, 'test'))
  for (const f of ['launcher.test.mjs', 'start.test.mjs', 'offline.mjs']) copyFileSync(path.resolve('test', f), path.join(upstream, 'test', f))
  git(root, ['init', '-q', '-b', 'main', upstream])
  commit('the build that runs', { 'README.md': 'v1\n' })
  git(root, ['clone', '-q', upstream, box])
  copyFileSync(path.resolve('deploy/post-merge.sh'), path.join(box, '.git', 'hooks', 'post-merge'))
  chmodSync(path.join(box, '.git', 'hooks', 'post-merge'), 0o755)
  const controller = readFileSync(path.resolve('src/controller.mjs'), 'utf8')
  const launcher = readFileSync(path.resolve('src/main.mjs'), 'utf8')

  // Two good PRs, then one that doesn't link: it parses, so only starting it shows it's broken.
  commit('one', { 'README.md': 'v2\n' })
  const two = commit('two', { 'README.md': 'v3\n' })
  const unlinked = commit('three', { 'src/controller.mjs': `import { nope } from './deploy.mjs'\n${controller}` })
  git(box, ['pull', '--quiet', '--ff-only'])
  assert.equal(git(box, ['rev-parse', 'HEAD']), two) // the newest that passes: one and two are live
  assert.equal(git(box, ['rev-parse', '--abbrev-ref', 'HEAD']), 'main') // on the branch, so the next pull tries again
  assert.deepEqual(takeRollback(), { from: unlinked, to: two, why: 'failed its pre-start check (test/start.test.mjs)' })

  // Main breaks the launcher too: nothing this pull brings passes, so it stays on what it had.
  const broken = commit('four', { 'src/main.mjs': 'import {{ nope\n' })
  git(box, ['pull', '--quiet', '--ff-only'])
  assert.equal(git(box, ['rev-parse', 'HEAD']), two)
  assert.deepEqual(takeRollback(), { from: broken, to: two, why: 'failed its pre-start check (src/main.mjs)' })

  // Fixed on main, and pulled the way some tools run git, with GIT_DIR and GIT_WORK_TREE set: the
  // launcher's test runs git in a repo of its own, which they must not point back at this one.
  const fixed = commit('five', { 'src/main.mjs': launcher, 'src/controller.mjs': controller })
  git(box, ['pull', '--quiet', '--ff-only'], { GIT_DIR: path.join(box, '.git'), GIT_WORK_TREE: box })
  assert.equal(git(box, ['rev-parse', 'HEAD']), fixed)
  assert.equal(git(box, ['status', '--porcelain']), '')
  assert.equal(takeRollback(), null)
})
