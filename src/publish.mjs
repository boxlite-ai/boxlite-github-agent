// A write turn, controller side; the session box only commits (box/session.mjs) and pushes one
// staging branch through the controller (gitpush.mjs). Before the turn, `planWrite` picks — with
// read-only calls — the branch and the commit the turn builds on. The fork and the turn's push
// token are made only when the box actually pushes (`plan.open`), so a question never forks a
// repo. After the turn, `publishWrite` checks exactly the commit the box pushed, on GitHub's own
// diff, squashes it into one commit by the bot, moves the PR branch (fast-forward only) and
// opens or updates a draft PR with the bot's token.
//
// Everything that came out of the box is untrusted — Codex has sudo in there and can rewrite the
// runner — so every rule lives here, and the controller never parses git data the box made.
import { sensitiveFiles } from './deploy.mjs'

export const LIMITS = { files: 100, lines: 5000, commits: 50, blobBytes: 1024 * 1024, treeCalls: 60 }

// Never written by the bot, whoever asks: CI definitions (they run with the repo's secrets once
// merged), review routing, submodules, and where sponsorship money goes.
const DENIED = [/^\.github\/workflows\//i, /^\.github\/actions\//i, /(^|\/)CODEOWNERS$/i, /^\.gitmodules$/i, /^\.github\/FUNDING\.ya?ml$/i]
// Changed, but called out at the top of the PR: a dependency change is often the fix itself.
const DEPENDENCY = /^(package(-lock)?\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?|deno\.(json|jsonc|lock)|requirements[\w.-]*\.txt|Pipfile(\.lock)?|poetry\.lock|pyproject\.toml|uv\.lock|setup\.(py|cfg)|Cargo\.(toml|lock)|go\.(mod|sum)|Gemfile(\.lock)?|[\w.-]+\.gemspec|composer\.(json|lock)|pom\.xml|build\.gradle(\.kts)?|gradle\.lockfile|packages\.lock\.json|[\w.-]+\.csproj|Directory\.Packages\.props|Package\.(swift|resolved)|Podfile(\.lock)?|mix\.(exs|lock)|pubspec\.(yaml|lock)|flake\.(nix|lock))$/
const TRAILER = /^[ \t]*(co-authored-by|signed-off-by|reviewed-by|acked-by|tested-by|reported-by|suggested-by|helped-by|approved-by)[ \t]*:.*$/gim

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const orNull = (p) => p.catch((e) => (e.status === 404 ? null : Promise.reject(e)))
const tipOf = async (gh, repo, branch) => (await orNull(gh.json('GET', `/repos/${repo}/git/ref/heads/${branch}`)))?.object.sha ?? null

/** Owner or repo name → ref-name component (git refuses `.github`, `x.lock`, `a..b`). */
const part = (s) => s.replace(/\.\./g, '__').replace(/^\./, '_').replace(/\.lock$/, '_lock').replace(/\.$/, '_')

/** The thread's PR branch and staging branch; one fork can serve several repos of a network. */
export function branchesFor(key) {
  const [repo, n] = key.split('#')
  const path = [...repo.split('/').map(part), n].join('/')
  return { branch: `botlite/${path}`, staging: `botlite-staging/${path}` }
}

/** The bot's fork of `upstream` if it has one: `known` (from state) or <bot>/<name>, same network. */
async function findFork(gh, me, upstream, known) {
  const repo = await orNull(gh.json('GET', `/repos/${known || `${me.login}/${upstream.name}`}`))
  const root = (r) => (r.source ?? r).full_name.toLowerCase()
  return repo?.fork && root(repo) === root(upstream) ? repo : null
}

/**
 * Plan a write turn. `pr` is the thread's PR ({ headSha, headRepo, headRef }) or null. Three cases:
 * a PR the bot opened is updated in place; anyone else's PR gets a draft PR into its branch; an
 * issue gets a draft PR into the default branch. A follow-up builds on the bot's existing branch.
 */
export async function planWrite({ gh, app, me, req, pr, key, knownFork, log = () => {} }) {
  const upstream = await gh.json('GET', `/repos/${req.repo}`)
  let { branch, staging } = branchesFor(key)
  let target = null
  let fork = null
  const own = pr?.headRepo && pr.headRepo.split('/')[0].toLowerCase() === me.login.toLowerCase() && pr.headRef.startsWith('botlite/')
  if (own) {
    branch = pr.headRef
    fork = pr.headRepo
  } else {
    if (pr && !pr.headRepo) throw new Error("this PR's branch is gone")
    target = pr ? { repo: pr.headRepo, base: pr.headRef } : { repo: req.repo, base: upstream.default_branch }
    fork = (await findFork(gh, me, upstream, knownFork))?.full_name ?? null
  }
  const tip = fork ? await tipOf(gh, fork, branch) : null
  const base = tip ?? (pr ? pr.headSha : await tipOf(gh, req.repo, upstream.default_branch))
  if (!base) throw new Error(`can't find the tip of ${req.repo}:${upstream.default_branch}`)
  const existing = target && tip ? ((await gh.json('GET', `/repos/${target.repo}/pulls?state=open&head=${encodeURIComponent(`${me.login}:${branch}`)}`))[0] ?? null) : null
  const describe = !target
    ? "as one more commit on this PR's branch"
    : existing
      ? `as one more commit on draft PR ${target.repo}#${existing.number}`
      : `as a new draft PR into ${target.repo === req.repo ? '' : `${target.repo}:`}${target.base}${pr ? " (this PR's branch)" : ''}`

  const plan = {
    branch, staging, base, target, existing, describe,
    branchExists: Boolean(tip),
    baseUrl: `https://github.com/${tip ? fork : req.repo}.git`,
    fork, // null until open() when the bot has no fork of this repo yet
    token: null,
    opened: null,
    /** On the box's first push: fork (if needed), sync it, clear a stale staging branch, mint the push token. */
    open() {
      plan.opened ??= (async () => {
        const f = plan.fork && own ? { full_name: plan.fork, name: plan.fork.split('/')[1] } : await ensureFork(gh, req.repo)
        if (!own) {
          // Level with upstream, so the push carries only the turn's own commits: a token without
          // workflow permission can't push commits that change workflows, even upstream's.
          await gh.json('POST', `/repos/${f.full_name}/merge-upstream`, { body: { branch: f.default_branch } }).catch((e) => log(`${key}: syncing ${f.full_name}: ${e.message}`))
        }
        await gh.request('DELETE', `/repos/${f.full_name}/git/refs/heads/${staging}`) // a leftover from a turn that never finished
        plan.fork = f.full_name
        plan.token = await app.token(f.name)
        return { repo: plan.fork, token: plan.token }
      })()
      return plan.opened
    },
  }
  return plan
}

async function ensureFork(gh, repo) {
  const fork = await gh.json('POST', `/repos/${repo}/forks`, { body: { default_branch_only: true } })
  // Forking is asynchronous: wait until the fork's default branch is there.
  for (let i = 0; i < 30; i++) {
    if (await tipOf(gh, fork.full_name, fork.default_branch)) return fork
    await sleep(2000)
  }
  throw new Error(`the fork ${fork.full_name} isn't ready yet`)
}

/** Mode and size of each path in a tree, fetching only the directories on the way to them. */
export async function treeEntries(gh, repo, rootTree, paths, { maxCalls = LIMITS.treeCalls } = {}) {
  const dirs = new Map()
  let calls = 0
  const split = (p) => [p.slice(0, Math.max(0, p.lastIndexOf('/'))), p.slice(p.lastIndexOf('/') + 1)]
  const list = (dir) => {
    if (!dirs.has(dir)) {
      dirs.set(dir, (async () => {
        const sha = dir === '' ? rootTree : (await list(split(dir)[0])).get(split(dir)[1])?.sha
        if (!sha) return new Map()
        if (++calls > maxCalls) throw new Error('the change is spread over too many directories to check')
        return new Map((await gh.json('GET', `/repos/${repo}/git/trees/${sha}`)).tree.map((e) => [e.path, e]))
      })())
    }
    return dirs.get(dir)
  }
  const out = {}
  for (const p of paths) out[p] = (await list(split(p)[0])).get(split(p)[1]) ?? null
  return out
}

/**
 * The rules a change must pass, on GitHub's compare of base...pushed commit and the pushed tree's
 * entries for every changed path. @returns {{ ok: true, flagged: string[] } | { ok: false, reason: string }}
 */
export function checkChange({ base, compare, entries, limits = LIMITS }) {
  if (compare.merge_base_commit?.sha !== base || compare.behind_by > 0) return { ok: false, reason: `the commits aren't on top of ${base.slice(0, 7)}` }
  const files = compare.files ?? []
  if (!compare.ahead_by || !files.length) return { ok: false, reason: 'the commits add up to no change' }
  if (compare.ahead_by > limits.commits) return { ok: false, reason: `it's ${compare.ahead_by} commits (limit ${limits.commits})` }
  if (files.length > limits.files) return { ok: false, reason: `it changes ${files.length} files (limit ${limits.files})` }
  const lines = files.reduce((n, f) => n + (f.additions ?? 0) + (f.deletions ?? 0), 0)
  if (lines > limits.lines) return { ok: false, reason: `it changes ${lines} lines (limit ${limits.lines})` }
  for (const f of files) {
    const denied = [f.filename, f.previous_filename].find((p) => p && DENIED.some((re) => re.test(p)))
    if (denied) return { ok: false, reason: `it touches \`${denied}\` — I never change workflows, actions, CODEOWNERS, submodules or funding links` }
    if (f.status === 'removed') continue
    const e = entries[f.filename]
    if (!e) return { ok: false, reason: `\`${f.filename}\` couldn't be checked` }
    if (e.mode === '120000') return { ok: false, reason: `\`${f.filename}\` is a symlink` }
    if (e.mode === '160000') return { ok: false, reason: `\`${f.filename}\` is a submodule` }
    if (e.size > limits.blobBytes) return { ok: false, reason: `\`${f.filename}\` is over ${limits.blobBytes / 1024 / 1024} MiB` }
  }
  return { ok: true, flagged: files.map((f) => f.filename).filter((p) => DEPENDENCY.test(p.split('/').pop())) }
}

/** Title, body and squash-commit message from the box's commit messages, minus authorship trailers. */
export function describeChange(commits, req) {
  const messages = commits.map((c) => c.commit.message.replace(TRAILER, '').trim()).filter(Boolean)
  const [first = '', ...others] = messages
  const [subject, ...rest] = first.split('\n')
  const title = subject.trim().slice(0, 120) || `Changes requested in ${req.repo}#${req.number}`
  const body = [rest.join('\n').trim(), ...others].filter(Boolean).join('\n\n').slice(0, 20_000)
  const message = [title, body, `Requested by @${req.author} in ${req.url}`].filter(Boolean).join('\n\n')
  return { title, body, message }
}

function prBody({ body, req, flagged, sensitive }) {
  const list = (files) => files.map((f) => `\`${f}\``).join(', ')
  return [
    ...(sensitive.length ? [`> [!WARNING]\n> This changes the bot's own trust boundary — ${list(sensitive)}. Review it closely: once merged, an admin's \`/deploy\` puts it live.`] : []),
    body || '_No description._',
    '---',
    `Requested by @${req.author} in ${req.url}. Written by an AI agent (Codex, in an isolated [BoxLite](https://boxlite.ai) microVM) — please review it like any outside contribution.`,
    ...(flagged.length ? [`**Dependencies changed:** ${list(flagged)} — check these closely.`] : []),
  ].join('\n\n')
}

/**
 * Why the box's push failed, for a public reply: the reason git reports, never its raw output,
 * which names the controller's URL. A workflow file refused says what the operator can do about
 * the usual cause (the fork behind upstream on it, which the token can't sync without that scope).
 */
export function pushFailure(error) {
  const text = String(error || '')
  const workflow = /refusing to allow a GitHub App to create or update workflow `([^`]+)`/.exec(text)
  if (workflow) return `GitHub refused my push because it touches the workflow \`${workflow[1]}\`, which I may not write. If that's upstream's change my fork hasn't caught up with, the bot's operator can fix it: give the bot's GitHub token the \`workflow\` scope`
  const refused = /\[(?:remote )?rejected\][^(\n]*\(([^)\n]+)\)/.exec(text)
  if (refused) return `GitHub refused my push (${refused[1]})`
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean)
  const line = lines.find((l) => /^(error|fatal):/.test(l)) ?? lines.at(-1) ?? ''
  return `my push failed (${line.replace(/\bhttps?:\/\/\S+/g, '…').slice(0, 200)})`
}

/**
 * After the turn — its job token already revoked, so nothing can move the staging branch any
 * more. `result` is the runner's own report ({ pushed, uncommitted, error }), a hint only: the
 * staging ref on GitHub is what counts. `refuse` (a reason) cleans up without publishing.
 * `selfRepo` is the bot's own repo: a PR there that touches its trust boundary says so.
 * @returns a line for the reply, or null when there's nothing to say.
 */
export async function publishWrite({ gh, app, me, plan, req, result, refuse = null, selfRepo = null, log = () => {} }) {
  if (!plan.opened) return result?.uncommitted ? '⚠️ Nothing was published: the changes were left uncommitted.' : null
  try {
    await plan.opened
  } catch (e) {
    return `⚠️ Couldn't set up the PR branch: ${e.message}`
  }
  await app.revoke(plan.token).catch((e) => log(`revoking a push token: ${e.message}`))
  const fork = plan.fork
  try {
    if (refuse) return `⚠️ Not published: ${refuse}.`
    const sha = await tipOf(gh, fork, plan.staging)
    if (!sha) return `⚠️ Nothing was published${result?.error ? `: ${pushFailure(result.error)}` : ''}.`
    const compare = await gh.json('GET', `/repos/${fork}/compare/${plan.base}...${sha}`)
    const tree = (await gh.json('GET', `/repos/${fork}/git/commits/${sha}`)).tree.sha
    const changed = (compare.files ?? []).filter((f) => f.status !== 'removed').map((f) => f.filename)
    const verdict = changed.length > LIMITS.files ? { ok: false, reason: `it changes ${changed.length} files (limit ${LIMITS.files})` } : checkChange({ base: plan.base, compare, entries: await treeEntries(gh, fork, tree, changed) })
    if (!verdict.ok) return `⚠️ Not published: ${verdict.reason}.`

    const { title, body, message } = describeChange(compare.commits ?? [], req)
    // One commit by the bot (the token's own user), on the pushed tree: the box's authorship,
    // sign-offs and history stay behind.
    const commit = await gh.json('POST', `/repos/${fork}/git/commits`, { body: { message, tree, parents: [plan.base] } })
    try {
      if (plan.branchExists) await gh.json('PATCH', `/repos/${fork}/git/refs/heads/${plan.branch}`, { body: { sha: commit.sha, force: false } })
      else await gh.json('POST', `/repos/${fork}/git/refs`, { body: { ref: `refs/heads/${plan.branch}`, sha: commit.sha } })
    } catch (e) {
      if (e.status === 409 || e.status === 422) return `⚠️ Not published: \`${plan.branch}\` changed while I worked — mention me again to redo it on top.`
      throw e
    }
    const short = commit.sha.slice(0, 7)
    const own = selfRepo && (plan.target?.repo ?? req.repo).toLowerCase() === selfRepo.toLowerCase()
    const sensitive = own ? sensitiveFiles([...new Set((compare.files ?? []).flatMap((f) => [f.filename, f.previous_filename].filter(Boolean)))]) : []
    const careful = sensitive.length ? ` It changes my own trust boundary (${sensitive.map((f) => `\`${f}\``).join(', ')}) — review it closely.` : ''
    if (!plan.target) return `📬 Pushed ${short} to this PR.${careful}`
    if (plan.existing) return `📬 Pushed ${short} to draft PR ${plan.existing.html_url}.${careful}`
    const pull = await gh.json('POST', `/repos/${plan.target.repo}/pulls`, {
      body: { title, head: `${me.login}:${plan.branch}`, base: plan.target.base, body: prBody({ body, req, flagged: verdict.flagged, sensitive }), draft: true, maintainer_can_modify: true },
    })
    return `📬 Opened draft PR ${pull.html_url}.${careful}`
  } finally {
    await gh.request('DELETE', `/repos/${fork}/git/refs/heads/${plan.staging}`).catch(() => {})
  }
}
