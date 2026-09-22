// The entry the controller box's boot loop runs after every `git pull` (deploy/deploy.sh): a small
// launcher that keeps a bad build from crash-looping the bot, then runs the controller itself.
//
// It counts starts of the checked-out commit; the controller marks its commit good once it's live
// (controller.mjs). A commit that fails to go live three times in a row is rolled back to the last
// good one, detached — so the boot loop's `git pull --ff-only` leaves it alone until the next
// `/deploy` or `ctl restart` re-attaches the branch. Keep this file small and dependency-free: it
// is what still runs when the rest of a build is broken.
import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const TRIES = 3
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

try {
  const git = (...args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
  const head = git('rev-parse', 'HEAD')
  const good = read('good-build.json')?.commit
  const boot = read('boot.json')
  const tries = boot?.commit === head ? boot.tries : 0
  mkdirSync(stateDir, { recursive: true, mode: 0o700 })
  if (good && head !== good && tries >= TRIES) {
    git('checkout', '--quiet', '--detach', good)
    writeFileSync(file('rollback.json'), JSON.stringify({ from: head, to: good, at: new Date().toISOString() }))
    writeFileSync(file('boot.json'), JSON.stringify({ commit: good, tries: 0 }))
    console.error(`${new Date().toISOString()} build ${head.slice(0, 7)} failed to go live ${TRIES} times: rolled back to ${good.slice(0, 7)}`)
    process.exit(1) // the boot loop starts again, on the good build
  }
  writeFileSync(file('boot.json'), JSON.stringify({ commit: head, tries: tries + 1 }))
} catch (e) {
  // The launcher's own bookkeeping must never keep the controller from starting.
  console.error(`${new Date().toISOString()} launcher: ${e.message}`)
}

await import('./controller.mjs')
