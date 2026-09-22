// A write turn, controller side; the session box only commits (box/session.mjs) and pushes one
// staging branch through the controller (gitpush.mjs). Before the turn, `planWrite` picks — with
// read-only calls — the branch and the commit the turn builds on. The fork and the turn's push
// token are made only when the box actually pushes (`plan.open`), so a question never forks a
// repo. After the turn, `publishWrite` checks that the commit the box pushed sits on that base,
// on GitHub's own diff, squashes it into one commit by the bot, moves the PR branch (fast-forward
// only) and opens or updates a draft PR with the bot's token, flagging what a reviewer must see.
//
// Everything that came out of the box is untrusted — Codex has sudo in there and can rewrite the
// runner — so every rule lives here, and the controller never parses git data the box made.
import { createHash } from 'node:crypto'
import { sensitiveFiles } from './deploy.mjs'

// A PR the bot opens is a draft that only a human merges, so what it changes is the reviewer's
// call: nothing is refused for what it touches. These are called out at the top of the PR, as a
// diff undersells them: CI runs a PR's own workflows and actions before anyone has reviewed it (on
// any runner a workflow names), and once merged, the others decide who reviews what, where
// submodules come from, and where sponsorship money goes.
const CAREFUL = [/^\.github\/workflows\//i, /^\.github\/actions\//i, /(^|\/)CODEOWNERS$/i, /^\.gitmodules$/i, /^\.github\/FUNDING\.ya?ml$/i]
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

  return withOpen({
    branch, staging, base, target, existing, describe,
    branchExists: Boolean(tip),
    baseUrl: `https://github.com/${tip ? fork : req.repo}.git`,
    fork, // null until open() when the bot has no fork of this repo yet
  }, { gh, app, upstream: req.repo, own, key, log })
}

/** A plan's open(): on the box's first push, fork (if needed), sync it, clear a stale staging branch, mint the push token. */
function withOpen(plan, { gh, app, upstream, own = false, key, log }) {
  return Object.assign(plan, {
    token: null,
    opened: null,
    behind: null, // why the fork couldn't catch up with upstream, if it couldn't
    open() {
      plan.opened ??= (async () => {
        const f = plan.fork && own ? { full_name: plan.fork, name: plan.fork.split('/')[1] } : await ensureFork(gh, upstream)
        // The fork runs no Actions — before the sync, which would run upstream's CI there. A push
        // there would run the box's code, or a workflow it wrote, with a token that can write the
        // fork, the bot's other PR branches included; a PR's checks run upstream anyway. Only
        // then may the push token write workflows.
        const quiet = await actionsOff(gh, f.full_name).catch((e) => {
          log(`${key}: turning Actions off on ${f.full_name}: ${e.message}`)
          return false
        })
        if (!own) {
          // Level with upstream, so the push carries only the turn's own commits: a push token
          // without workflow permission can't push commits that change workflows, even
          // upstream's. Syncing them takes the bot's token's `workflow` scope.
          await gh.json('POST', `/repos/${f.full_name}/merge-upstream`, { body: { branch: f.default_branch } }).catch((e) => {
            plan.behind = e.message
            log(`${key}: syncing ${f.full_name}: ${e.message}`)
          })
        }
        await gh.request('DELETE', `/repos/${f.full_name}/git/refs/heads/${plan.staging}`) // a leftover from a turn that never finished
        plan.fork = f.full_name
        plan.token = await app.token(f.name, { workflows: quiet })
        return { repo: plan.fork, token: plan.token }
      })()
      return plan.opened
    },
  })
}

/**
 * A PR asked for in Slack: planned when the box is ready to push (prgrant.mjs), not before the
 * turn — a Slack thread belongs to no repo. A draft PR into `repo`'s default branch, built on
 * `base`, the commit the box's clone started from, which must be on that branch. Every request
 * gets a new branch, named by a hash of `id` (the Slack thread and message): the fork is public,
 * and Slack's ids are the team's.
 */
export async function planSlackWrite({ gh, app, me, repo, base, id, knownFork, log = () => {} }) {
  const upstream = await gh.json('GET', `/repos/${repo}`)
  if (upstream.private) throw new Error(`${upstream.full_name} is private`)
  const onBranch = await orNull(gh.json('GET', `/repos/${upstream.full_name}/compare/${upstream.default_branch}...${base}`))
  if (!['behind', 'identical'].includes(onBranch?.status)) throw new Error(`${base.slice(0, 7)} isn't on ${upstream.full_name}'s ${upstream.default_branch}: build on it`)
  const name = `slack-${createHash('sha256').update(id).digest('hex').slice(0, 12)}`
  const key = `${upstream.full_name} (Slack)`
  return withOpen({
    branch: `botlite/${name}`,
    staging: `botlite-staging/${name}`,
    base,
    target: { repo: upstream.full_name, base: upstream.default_branch },
    existing: null,
    describe: `as a new draft PR into ${upstream.full_name}:${upstream.default_branch}`,
    branchExists: false,
    baseUrl: `https://github.com/${upstream.full_name}.git`,
    fork: (await findFork(gh, me, upstream, knownFork))?.full_name ?? null,
  }, { gh, app, upstream: upstream.full_name, key, log })
}

/** Turn Actions off on the bot's fork (the bot's token needs the `repo` scope). Resolves to true once it's off. */
async function actionsOff(gh, repo) {
  if ((await gh.json('GET', `/repos/${repo}/actions/permissions`)).enabled) await gh.json('PUT', `/repos/${repo}/actions/permissions`, { body: { enabled: false } })
  return true
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

/**
 * What a change must be, on GitHub's compare of base...pushed commit: commits on top of `base`
 * that add up to a change. The squash commit is the pushed tree on `base`, so commits from
 * anywhere else would quietly undo upstream's work. The rest is the reviewer's: `flagged` are
 * dependency files, `careful` the files a diff undersells (CAREFUL).
 * @returns {{ ok: true, flagged: string[], careful: string[] } | { ok: false, reason: string }}
 */
export function checkChange({ base, compare }) {
  if (compare.merge_base_commit?.sha !== base || compare.behind_by > 0) return { ok: false, reason: `the commits aren't on top of ${base.slice(0, 7)}` }
  const files = compare.files ?? []
  if (!compare.ahead_by || !files.length) return { ok: false, reason: 'the commits add up to no change' }
  const paths = [...new Set(files.flatMap((f) => [f.filename, f.previous_filename].filter(Boolean)))]
  return {
    ok: true,
    flagged: files.map((f) => f.filename).filter((p) => DEPENDENCY.test(p.split('/').pop())),
    careful: paths.filter((p) => CAREFUL.some((re) => re.test(p))),
  }
}

/**
 * Where a change was asked for, for its public commit and PR: the GitHub thread and who asked
 * there; for Slack (`req.origin`), only that it was Slack — never who, where or a link: those are
 * the team's.
 */
const requestedBy = (req) => req.origin ?? `Requested by @${req.author} in ${req.url}`

/** Title, body and squash-commit message from the box's commit messages, minus authorship trailers. */
export function describeChange(commits, req) {
  const messages = commits.map((c) => c.commit.message.replace(TRAILER, '').trim()).filter(Boolean)
  const [first = '', ...others] = messages
  const [subject, ...rest] = first.split('\n')
  const title = subject.trim().slice(0, 120) || (req.origin ? 'Changes requested from Slack' : `Changes requested in ${req.repo}#${req.number}`)
  const body = [rest.join('\n').trim(), ...others].filter(Boolean).join('\n\n').slice(0, 20_000)
  const message = [title, body, requestedBy(req)].filter(Boolean).join('\n\n')
  return { title, body, message }
}

function prBody({ body, req, flagged, careful = [], sensitive }) {
  const list = (files) => files.map((f) => `\`${f}\``).join(', ')
  return [
    ...(careful.length ? [`> [!CAUTION]\n> This changes CI, review routing, submodules or sponsorship links — ${list(careful)}. Check exactly what they do before you approve a CI run or merge: CI runs a PR's own workflows.`] : []),
    ...(sensitive.length ? [`> [!WARNING]\n> This changes the bot's own trust boundary — ${list(sensitive)}. Review it closely: once merged, an admin's \`/deploy\` puts it live.`] : []),
    body || '_No description._',
    '---',
    `${requestedBy(req)}. Written by an AI agent (Codex, in an isolated [BoxLite](https://boxlite.ai) microVM) — please review it like any outside contribution.`,
    ...(flagged.length ? [`**Dependencies changed:** ${list(flagged)} — check these closely.`] : []),
  ].join('\n\n')
}

/**
 * Why the box's push failed, for a public reply: the reason git reports, never its raw output,
 * which names the controller's URL. `behind` is why the fork couldn't catch up with upstream
 * before the push, if it couldn't: then a refused workflow file is likely upstream's, not the
 * turn's, and the operator can fix the usual cause (the bot's token without the workflow scope).
 */
export function pushFailure(error, { behind = null } = {}) {
  const text = String(error || '')
  const workflow = /refusing to allow a GitHub App to create or update workflow `([^`]+)`/.exec(text)
  if (workflow && behind) {
    const scope = /`?workflow`? scope/.test(behind) ? ". The bot's operator can fix it: give the bot's GitHub token the `workflow` scope" : ''
    return `GitHub refused my push: my fork couldn't catch up with upstream first, so it carried upstream's change to the workflow \`${workflow[1]}\`${scope}`
  }
  if (workflow) return `GitHub refused my push: the change touches the workflow \`${workflow[1]}\`, and my push token may not write workflows. The bot's operator can allow it: give the push App the Workflows permission`
  const refused = /\[(?:remote )?rejected\][^(\n]*\(([^)\n]+)\)/.exec(text)
  if (refused) return `GitHub refused my push (${refused[1]})`
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean)
  const line = lines.find((l) => /^(error|fatal):/.test(l)) ?? lines.at(-1) ?? ''
  // On an HTTP error, git first prints the server's own explanation as `remote:` lines.
  const why = lines.find((l) => /^remote: +\S/.test(l))?.replace(/^remote: +/, '')
  const clean = (s) => s.replace(/\bhttps?:\/\/\S+/g, '…').slice(0, 200)
  return `my push failed (${clean(line)}${why ? ` — ${clean(why)}` : ''})`
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
    if (!sha) return `⚠️ Nothing was published${result?.error ? `: ${pushFailure(result.error, { behind: plan.behind })}` : ''}.`
    const compare = await gh.json('GET', `/repos/${fork}/compare/${plan.base}...${sha}`)
    const tree = (await gh.json('GET', `/repos/${fork}/git/commits/${sha}`)).tree.sha
    const verdict = checkChange({ base: plan.base, compare })
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
    const list = (files) => files.map((f) => `\`${f}\``).join(', ')
    const careful = [
      ...(sensitive.length ? [` It changes my own trust boundary (${list(sensitive)}) — review it closely.`] : []),
      ...(verdict.careful.length ? [` It changes ${list(verdict.careful)} — check what that does before merging.`] : []),
    ].join('')
    if (!plan.target) return `📬 Pushed ${short} to this PR.${careful}`
    if (plan.existing) return `📬 Pushed ${short} to draft PR ${plan.existing.html_url}.${careful}`
    const pull = await gh.json('POST', `/repos/${plan.target.repo}/pulls`, {
      body: { title, head: `${me.login}:${plan.branch}`, base: plan.target.base, body: prBody({ body, req, flagged: verdict.flagged, careful: verdict.careful, sensitive }), draft: true, maintainer_can_modify: true },
    })
    return `📬 Opened draft PR ${pull.html_url}.${careful}`
  } finally {
    await gh.request('DELETE', `/repos/${fork}/git/refs/heads/${plan.staging}`).catch(() => {})
  }
}
