// The entry the controller box's boot loop runs after every `git pull` (deploy/deploy.sh): a small
// launcher that keeps a bad build from crash-looping the bot, then runs the controller itself.
//
// It counts starts of the checked-out commit; the controller marks its commit good once it has been
// live for its trial, and a clean restart resets the count (controller.mjs). A commit that fails
// three times before its trial is up, or fails the trial itself, is rolled back to the last good
// one, detached — so the boot loop's `git pull --ff-only` leaves it alone until the next `/deploy`
// or `ctl restart` re-attaches the branch. A controller that stops making progress is killed by a
// watchdog, so the boot loop starts it again. Keep this file small and dependency-free: it is what
// still runs when the rest of a build is broken. (A build that breaks this file is stopped before
// it starts: deploy/post-merge.sh.)
import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Worker } from 'node:worker_threads'

const TRIES = 3
const HANG_MS = Number(process.env.HANG_MIN || 10) * 60_000
const repo = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const stateDir = path.dirname(process.env.STATE_FILE || '/var/lib/botlite/state.json')
const file = (name) => path.join(stateDir, name)
const read = (name) => {
  try {
    return JSON.parse(readFileSync(file(name), 'utf8'))
  } catch {
    return null
  }
}

let head = null
try {
  const git = (...args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
  head = git('rev-parse', 'HEAD')
  const good = read('good-build.json')?.commit
  const last = read('boot.json')
  const boot = last?.commit === head ? last : { tries: 0 }
  mkdirSync(stateDir, { recursive: true, mode: 0o700 })
  if (good && head !== good && (boot.tries >= TRIES || boot.failed)) {
    const why = boot.failed ?? `failed ${TRIES} times before its trial was up`
    git('checkout', '--quiet', '--detach', good)
    writeFileSync(file('rollback.json'), JSON.stringify({ from: head, to: good, at: new Date().toISOString(), by: 'launcher', why }))
    writeFileSync(file('boot.json'), JSON.stringify({ commit: good, tries: 0 }))
    console.error(`${new Date().toISOString()} build ${head.slice(0, 7)} ${why}: rolled back to ${good.slice(0, 7)}`)
    process.exit(1) // the boot loop starts again, on the good build
  }
  writeFileSync(file('boot.json'), JSON.stringify({ commit: head, tries: boot.tries + 1 }))
} catch (e) {
  // The launcher's own bookkeeping must never keep the controller from starting.
  console.error(`${new Date().toISOString()} launcher: ${e.message}`)
}

// The watchdog. The controller beats it (globalThis.botliteBeat) from its poll loop, and while it
// waits on a person; with no beat for HANG_MS, it marks the start failed — so a build on trial is
// rolled back at once — and kills the process for the boot loop to start again. It runs on a
// thread of its own, so it fires even when the controller's event loop is blocked.
// (It writes to stderr's fd itself: a worker's console goes through the main thread, maybe blocked.)
const WATCHDOG = `
const { workerData: { beat, hangMs, boot, commit } } = require('node:worker_threads')
const { writeFileSync, writeSync } = require('node:fs')
setInterval(() => {
  const quiet = Date.now() - Number(Atomics.load(beat, 0))
  if (quiet < hangMs) return
  const why = 'stopped making progress for ' + (quiet < 120000 ? Math.round(quiet / 1000) + ' seconds' : Math.round(quiet / 60000) + ' minutes')
  writeSync(2, new Date().toISOString() + ' launcher: the controller ' + why + ': killing it\\n')
  if (commit) try { writeFileSync(boot, JSON.stringify({ commit, tries: 0, failed: why })) } catch {}
  process.kill(process.pid, 'SIGKILL')
}, Math.min(30000, hangMs / 4))
`
const beat = new BigInt64Array(new SharedArrayBuffer(8))
globalThis.botliteBeat = () => Atomics.store(beat, 0, BigInt(Date.now()))
globalThis.botliteBeat()
new Worker(WATCHDOG, { eval: true, workerData: { beat, hangMs: HANG_MS, boot: file('boot.json'), commit: head } }).unref()

await import('./controller.mjs')
