// The bot deploying itself, controller side. What goes live is only ever what a human merged on
// the tracked branch: the bot can't merge — it has read access to its own repo — and `/deploy`
// (admins only, access.mjs) just restarts the controller onto that branch, as `ctl restart` does.
// The launcher (main.mjs) rolls back a build that won't go live; this module reads what happened
// when the next build comes up, and says so in the thread that asked.
//
// The tracked branch is the one the checkout is on — recorded in <state dir>/branch at every
// start, so a rollback (which detaches the checkout) knows where to re-attach. BOTLITE_REF, fixed
// when the box was created, is only the last resort: it goes stale when someone moves the
// checkout (seen live: it named a PR branch long merged, and a restart went back to it).
import { execFileSync } from 'node:child_process'
import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'

const short = (sha) => String(sha ?? '').slice(0, 7)

/**
 * The build this controller runs: its commit, its repo (owner/name from origin), the branch the
 * checkout is on (null while detached) and `ref`, the branch it tracks: that one, else `recorded`
 * (the last branch it was on), else `fallback`.
 */
export function selfBuild(dir, { recorded = null, fallback = 'main' } = {}) {
  const git = (...args) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
  let branch = null
  try {
    branch = git('symbolic-ref', '--short', '-q', 'HEAD') || null
  } catch {
    /* detached */
  }
  const ref = branch ?? recorded ?? fallback
  try {
    const url = git('remote', 'get-url', 'origin')
    return { dir, branch, ref, commit: git('rev-parse', 'HEAD'), repo: /github\.com[:/]([\w.-]+\/[\w.-]+?)(\.git)?$/.exec(url)?.[1] ?? null }
  } catch {
    return { dir, branch, ref, commit: null, repo: null }
  }
}

/** The branch the checkout was last on (see above), and recording it. */
export const recordedBranch = (stateDir) => {
  try {
    return readFileSync(path.join(stateDir, 'branch'), 'utf8').trim() || null
  } catch {
    return null
  }
}
export const recordBranch = (stateDir, branch) => writeFileSync(path.join(stateDir, 'branch'), `${branch}\n`)

/**
 * What `/deploy` would put live: the commits on the tracked branch since the running build.
 * @returns {{ from, to, status, commits: { sha, title }[] }} status as GitHub's compare says
 */
export async function deployPlan({ gh, build }) {
  const cmp = await gh.json('GET', `/repos/${build.repo}/compare/${build.commit}...${build.ref}`)
  const commits = (cmp.commits ?? []).map((c) => ({ sha: c.sha, title: c.commit.message.split('\n')[0] }))
  return { from: build.commit, to: commits.at(-1)?.sha ?? build.commit, status: cmp.status, commits }
}

/**
 * The launcher's verdicts, kept in the state dir. A build is good once it has stayed up through
 * its trial (TRIAL_MS); until then, every crash counts toward the launcher's rollback — a build
 * that dies on its first requests is rolled back too, not only one that can't start.
 */
export const TRIAL_MS = 10 * 60_000
export function markGood(stateDir, commit) {
  writeFileSync(path.join(stateDir, 'good-build.json'), JSON.stringify({ commit, at: new Date().toISOString() }))
  rmSync(path.join(stateDir, 'boot.json'), { force: true })
}
/** The last good build's commit — null before the first. */
export function goodBuild(stateDir) {
  try {
    return JSON.parse(readFileSync(path.join(stateDir, 'good-build.json'), 'utf8')).commit ?? null
  } catch {
    return null
  }
}

/**
 * Polling proves little: a build whose session boxes can't run a turn polls fine — the chaos run's
 * broken runner passed its trial, and every request got "sorry, the run failed". So a new build
 * also runs one turn of its own in its trial (controller.mjs), just like a request's: a session box
 * on the bot's own repo, the runner in it, Codex, its model calls through the proxy. Any answer at
 * all shows they work; none fails the trial.
 */
export const TRIAL_TURN = { number: 0, prompt: 'This is the bot checking a new build of itself, not a request from anyone. Reply with exactly: OK' }
/** Why a trial turn failed — null if it answered. */
export const trialTurnFailure = (out) => (out?.message ? null : `couldn't run a turn in its trial (${String(out?.error || 'no answer').split('\n')[0].slice(0, 160)})`)
/** A clean exit (drained, restarting) is no failure: the launcher counts crashes only. */
export const cleanExit = (stateDir, commit) => writeFileSync(path.join(stateDir, 'boot.json'), JSON.stringify({ commit, tries: 0 }))
/** A build that failed its trial: the launcher rolls it back on the next start, saying why. */
export const failTrial = (stateDir, commit, why) => writeFileSync(path.join(stateDir, 'boot.json'), JSON.stringify({ commit, tries: 0, failed: why }))
/** A rollback before this start, the launcher's or the pull gate's ({ from, to, at, why? }), read once. */
export function takeRollback(stateDir) {
  const file = path.join(stateDir, 'rollback.json')
  try {
    const r = JSON.parse(readFileSync(file, 'utf8'))
    rmSync(file, { force: true })
    return r
  } catch {
    return null
  }
}

/**
 * How a `/deploy` turned out, for the thread that asked; null when there's nothing new to say. A
 * deploy stays pending through the new build's trial (`live: true`), so a rollback during it is
 * reported in the same thread.
 *
 * A rollback by the pull gate (deploy/post-merge.sh) may stop on a pulled commit newer than the
 * build it had, which then goes live on trial like any deploy. The launcher's goes back to the last
 * good build.
 */
export function deployOutcome({ pending, running, rollback }) {
  if (!pending) return null
  const who = `@${pending.by}`
  const trial = (sha) => `If ${sha} fails in the next ${TRIAL_MS / 60_000} minutes, I roll it back.`
  if (rollback && heldBack({ pending, rollback })) return null // a restart met the same broken main: said already
  if (rollback) {
    const to = `\`${short(rollback.to)}\``
    const why = rollback.why ?? `failed three times before its ${TRIAL_MS / 60_000}-minute trial was up`
    const fix = 'Fix it on `main` and `/deploy` again.'
    if (rollback.to === pending.from) return `${who} ⚠️ \`${short(rollback.from)}\` ${why}, so I'm on ${to} again. ${fix}`
    if (byGate(rollback)) return `${who} ⚠️ \`${short(rollback.from)}\` ${why}, so I went live on ${to} instead, the newest commit before it that passes. ${fix} ${trial(to)}`
    return `${who} ⚠️ \`${short(rollback.from)}\` ${why}, so I'm on ${to}, the last good build. ${fix}`
  }
  if (pending.live) return null // restarted during its trial: it already said it's live
  if (running === pending.to) return `${who} ✅ \`${short(pending.to)}\` is live. ${trial('it')}`
  return `${who} ⚠️ that deploy didn't take: I'm running \`${short(running)}\`, not \`${short(pending.to)}\`.`
}

// Whose rollback it was: the gate's and the launcher's say so; a gate installed before they did
// marked its own with a `why` alone.
const byGate = (rollback) => (rollback.by ? rollback.by === 'gate' : Boolean(rollback.why))
// The gate stopped on the build already live on its trial: nothing changed since it said so.
const heldBack = ({ pending, rollback }) => byGate(rollback) && Boolean(pending.live) && rollback.to === pending.to

/**
 * What's left pending after this start: kept (live) through the trial of the build it put live —
 * the one asked for, or the newest commit before it that passed the gate — and dropped otherwise.
 */
export function pendingAfter({ pending, running, rollback }) {
  if (!pending) return null
  if (!rollback) return running === pending.to ? { ...pending, live: true } : null
  if (heldBack({ pending, rollback })) return pending
  return byGate(rollback) && running === rollback.to && running !== pending.from ? { ...pending, to: running, live: true } : null
}

// The bot's own trust boundary: who may publish, what gets checked and pushed, the credentials,
// the runner and the deploy. A PR on the bot's own repo that touches these says so at the top.
const SENSITIVE = [/^src\/(access|publish|gitpush|prgrant|githubapp|proxy|chatgpt|main|controller|deploy|mentions|webhook|session|state|github|reply|policy|tools|oauth|slack|slack-channel|slack-events|slack-socket|slack-reply)\.mjs$/, /^box\//, /^deploy\//]
export const sensitiveFiles = (paths) => paths.filter((p) => SENSITIVE.some((re) => re.test(p)))
