import assert from 'node:assert/strict'
import { test, after } from 'node:test'
import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

// The pull gate (deploy/post-merge.sh) as git runs it in the controller's checkout: a pull that
// brings a build whose launcher is broken is undone before the boot loop could start it — the
// case src/main.mjs's own rollback can't survive, since it is the broken part.
const root = mkdtempSync(path.join(tmpdir(), 'gate-'))
after(() => rmSync(root, { recursive: true, force: true }))
const upstream = path.join(root, 'upstream')
const box = path.join(root, 'botlite')
const stateDir = path.join(root, 'state')
const git = (dir, ...args) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', env: { ...process.env, STATE_FILE: path.join(stateDir, 'state.json') } }).trim()
const commit = (message) => {
  git(upstream, 'add', '-A')
  git(upstream, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', message)
  return git(upstream, 'rev-parse', 'HEAD')
}

test('gate: a pull whose launcher is broken is undone, and why is left for the controller; a good one goes through', () => {
  for (const d of ['src', 'test', 'deploy']) mkdirSync(path.join(upstream, d), { recursive: true })
  git(root, 'init', '-q', '-b', 'main', upstream)
  copyFileSync(path.resolve('src/main.mjs'), path.join(upstream, 'src', 'main.mjs'))
  copyFileSync(path.resolve('test/launcher.test.mjs'), path.join(upstream, 'test', 'launcher.test.mjs'))
  writeFileSync(path.join(upstream, 'src', 'controller.mjs'), "console.log('controller')\n")
  const good = commit('good')
  git(root, 'clone', '-q', upstream, box)
  copyFileSync(path.resolve('deploy/post-merge.sh'), path.join(box, '.git', 'hooks', 'post-merge'))
  execFileSync('chmod', ['+x', path.join(box, '.git', 'hooks', 'post-merge')])

  writeFileSync(path.join(upstream, 'src', 'main.mjs'), 'import {{ nope\n') // a deploy that breaks the launcher
  const bad = commit('bad')
  git(box, 'pull', '--quiet', '--ff-only')
  assert.equal(git(box, 'rev-parse', 'HEAD'), good) // undone: the boot loop runs the build it had
  assert.equal(git(box, 'rev-parse', '--abbrev-ref', 'HEAD'), 'main') // still on the branch: the next pull tries again
  const rollback = JSON.parse(readFileSync(path.join(stateDir, 'rollback.json'), 'utf8'))
  assert.deepEqual([rollback.from, rollback.to, rollback.why], [bad, good, 'failed its pre-start check (src/main.mjs)'])

  rmSync(path.join(stateDir, 'rollback.json'))
  copyFileSync(path.resolve('src/main.mjs'), path.join(upstream, 'src', 'main.mjs')) // fixed on main
  writeFileSync(path.join(upstream, 'README'), 'fixed\n')
  const fixed = commit('fixed')
  git(box, 'pull', '--quiet', '--ff-only')
  assert.equal(git(box, 'rev-parse', 'HEAD'), fixed)
  assert.equal(existsSync(path.join(stateDir, 'rollback.json')), false)
})
