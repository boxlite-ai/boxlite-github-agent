import assert from 'node:assert/strict'
import { test, after } from 'node:test'
import { spawnSync, execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

// The real launcher (src/main.mjs) in a throwaway checkout, with a stand-in controller: one that
// goes "live" (marks its commit good, as controller.mjs does) or one that crashes on import.
const root = mkdtempSync(path.join(tmpdir(), 'launcher-'))
after(() => rmSync(root, { recursive: true, force: true }))
const repo = path.join(root, 'botlite')
const stateDir = path.join(root, 'state')
const git = (...args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim()
const read = (f) => JSON.parse(readFileSync(path.join(stateDir, f), 'utf8'))

const LIVE = `import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import path from 'node:path'
const commit = execFileSync('git', ['-C', path.dirname(path.dirname(new URL(import.meta.url).pathname)), 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
writeFileSync(path.join(path.dirname(process.env.STATE_FILE), 'good-build.json'), JSON.stringify({ commit }))
console.log('live', commit)
`
const BROKEN = "throw new Error('a broken build')\n"

function commit(controller, message) {
  writeFileSync(path.join(repo, 'src', 'controller.mjs'), controller)
  git('add', '-A')
  git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', message)
  return git('rev-parse', 'HEAD')
}
const start = () => spawnSync(process.execPath, [path.join(repo, 'src', 'main.mjs')], { encoding: 'utf8', env: { PATH: process.env.PATH, STATE_FILE: path.join(stateDir, 'state.json') } })

test('launcher: a build that never goes live is rolled back to the last good one after three tries', () => {
  mkdirSync(path.join(repo, 'src'), { recursive: true })
  git('init', '-q', '-b', 'main')
  copyFileSync(path.resolve('src/main.mjs'), path.join(repo, 'src', 'main.mjs'))
  const good = commit(LIVE, 'good')
  const first = start()
  assert.equal(first.status, 0, first.stderr)
  assert.equal(read('good-build.json').commit, good)

  const bad = commit(BROKEN, 'bad')
  for (let i = 1; i <= 3; i++) {
    const r = start()
    assert.notEqual(r.status, 0)
    assert.match(r.stderr, /a broken build/)
    assert.deepEqual(read('boot.json'), { commit: bad, tries: i })
  }
  const rolled = start()
  assert.equal(rolled.status, 1)
  assert.match(rolled.stderr, new RegExp(`build ${bad.slice(0, 7)} failed to go live 3 times: rolled back to ${good.slice(0, 7)}`))
  assert.equal(git('rev-parse', 'HEAD'), good)
  assert.equal(git('rev-parse', '--abbrev-ref', 'HEAD'), 'HEAD') // detached: the boot loop's pull --ff-only won't move it
  assert.deepEqual({ ...read('rollback.json'), at: undefined }, { from: bad, to: good, at: undefined })

  const back = start() // the boot loop's next start: the good build again
  assert.equal(back.status, 0, back.stderr)
  assert.match(back.stdout, new RegExp(`live ${good}`))
})

test('launcher: without a good build yet it never rolls back; its own trouble never blocks the start', () => {
  rmSync(stateDir, { recursive: true, force: true })
  git('checkout', '-q', 'main')
  for (let i = 0; i < 5; i++) {
    const r = start() // the broken build crashes each time — with nothing good to roll back to
    assert.match(r.stderr, /a broken build/)
    assert.doesNotMatch(r.stderr, /rolled back/)
  }
  assert.equal(existsSync(path.join(stateDir, 'rollback.json')), false)
  assert.equal(git('rev-parse', '--abbrev-ref', 'HEAD'), 'main')

  const loose = path.join(root, 'no-git', 'src') // not a checkout: the bookkeeping fails, the controller still runs
  mkdirSync(loose, { recursive: true })
  copyFileSync(path.resolve('src/main.mjs'), path.join(loose, 'main.mjs'))
  writeFileSync(path.join(loose, 'controller.mjs'), "console.log('controller ran')\n")
  const r = spawnSync(process.execPath, [path.join(loose, 'main.mjs')], { encoding: 'utf8', env: { PATH: process.env.PATH, STATE_FILE: path.join(root, 'state2', 'state.json') } })
  assert.equal(r.status, 0, r.stderr)
  assert.match(r.stdout, /controller ran/)
  assert.match(r.stderr, /launcher:/)
})
