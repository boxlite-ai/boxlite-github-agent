import assert from 'node:assert/strict'
import { test } from 'node:test'
import { branchesFor, checkChange, describeChange, planWrite, planSlackWrite, publishWrite, pushFailure } from '../src/publish.mjs'

const BASE = 'b'.repeat(40)
const TIP = 't'.repeat(40)
const PUSHED = 'p'.repeat(40)
const TREE = 'e'.repeat(40)
const SQUASH = 'c0ffee' + '0'.repeat(34)
const me = { login: 'botlite', id: 1 }
const req = { repo: 'acme/app', number: 7, author: 'alice', url: 'https://github.com/acme/app/issues/7#issuecomment-1' }

/** GitHub's REST API as a route table; unmatched calls are 404s. Every call is recorded. */
function fakeGithub(routes) {
  const calls = []
  const json = async (method, path, opts = {}) => {
    calls.push({ method, path, body: opts.body })
    for (const [m, re, fn] of routes) {
      const hit = m === method && re.exec(path)
      if (hit) return typeof fn === 'function' ? fn(hit, opts.body) : fn
    }
    throw fail(404)
  }
  const request = (method, path, opts) => json(method, path, opts).then(() => ({ ok: true, status: 204 }), (e) => ({ ok: false, status: e.status }))
  return { calls, json, request, called: (m, re) => calls.filter((c) => c.method === m && re.test(c.path)) }
}
const fail = (status) => Object.assign(new Error(`HTTP ${status}`), { status })
const fakeApp = () => {
  const app = { minted: [], revoked: [] }
  app.token = async (repo, { workflows = false } = {}) => (app.minted.push(workflows ? `${repo} +workflows` : repo), 'ghs_turn')
  app.revoke = async (t) => app.revoked.push(t)
  return app
}

test('pushFailure: the reason from git’s output, never the output itself — it names the controller', () => {
  // Seen live on boxlite-ai/boxlite#1589: upstream had changed a workflow the bot's fork lacked.
  const workflow = `To https://8788-d-abc.proxy.boxlite.ai/git
 ! [remote rejected]   HEAD -> botlite-staging/boxlite-ai/boxlite/1589 (refusing to allow a GitHub App to create or update workflow \`.github/workflows/README.md\` without \`workflows\` permission)
error: failed to push some refs to 'https://8788-d-abc.proxy.boxlite.ai/git'`
  // The fork couldn't catch up first: upstream's change, and the usual cause said.
  const behind = 'POST /repos/botlite/boxlite/merge-upstream: 422 {"message":"refusing to allow a Personal Access Token to create or update workflow `.github/workflows/README.md` without `workflow` scope"}'
  assert.equal(pushFailure(workflow, { behind }), "GitHub refused my push: my fork couldn't catch up with upstream first, so it carried upstream's change to the workflow `.github/workflows/README.md`. The bot's operator can fix it: give the bot's GitHub token the `workflow` scope")
  assert.equal(pushFailure(workflow, { behind: 'POST /repos/botlite/boxlite/merge-upstream: 409 conflict' }), "GitHub refused my push: my fork couldn't catch up with upstream first, so it carried upstream's change to the workflow `.github/workflows/README.md`")
  // Caught up: the turn's own change, which the push App may not write.
  assert.equal(pushFailure(workflow), "GitHub refused my push: the change touches the workflow `.github/workflows/README.md`, and my push token may not write workflows. The bot's operator can allow it: give the push App the Workflows permission")
  assert.equal(pushFailure(' ! [remote rejected] HEAD -> x (pre-receive hook declined)\nerror: failed to push some refs to \'https://h.example/git\''), 'GitHub refused my push (pre-receive hook declined)')
  assert.equal(pushFailure('fatal: unable to access \'https://h.example/git/\': Could not resolve host'), "my push failed (fatal: unable to access '… Could not resolve host)")
  // An HTTP refusal: git shows the server's explanation first — the controller's, or GitHub's.
  assert.equal(pushFailure("remote: this turn may not push\nfatal: unable to access 'https://h.example/git/': The requested URL returned error: 403"), "my push failed (fatal: unable to access '… The requested URL returned error: 403 — this turn may not push)")
  assert.equal(pushFailure("remote: Permission to botlite/app.git denied to botlite-push[bot].\nfatal: unable to access 'https://h.example/git/': The requested URL returned error: 403"), "my push failed (fatal: unable to access '… The requested URL returned error: 403 — Permission to botlite/app.git denied to botlite-push[bot].)")
  for (const out of [workflow, 'error: RPC failed; HTTP 502 curl 22 https://h.example/git', 'remote: see https://h.example/x\nfatal: no']) assert.doesNotMatch(pushFailure(out), /https?:\/\//)
})

test('branchesFor: readable, one per thread, valid ref names even for .github or x.lock repos', () => {
  assert.deepEqual(branchesFor('acme/app#7'), { branch: 'botlite/acme/app/7', staging: 'botlite-staging/acme/app/7' })
  assert.equal(branchesFor('acme/.github#3').branch, 'botlite/acme/_github/3')
  assert.equal(branchesFor('acme/x.lock#1').branch, 'botlite/acme/x_lock/1')
  assert.equal(branchesFor('acme/a..b#1').branch, 'botlite/acme/a__b/1')
})

const compare = (files, over = {}) => ({ merge_base_commit: { sha: BASE }, behind_by: 0, ahead_by: 1, files, ...over })
const file = (filename, over = {}) => ({ filename, status: 'modified', additions: 2, deletions: 1, ...over })

test('checkChange: whatever it touches, it passes — dependency files flagged, CI, review and funding files called out', () => {
  const files = [
    file('src/a.js'), file('package.json'), file('web/yarn.lock'), file('gone.txt', { status: 'removed' }),
    file('.github/workflows/ci.yml'), file('.GitHub/Actions/setup/action.yml'), file('docs/CODEOWNERS'), file('.gitmodules'), file('.github/FUNDING.yml'),
    file('ci.yml', { status: 'renamed', previous_filename: '.github/workflows/old.yml' }), // moving one away counts too
    file('deps.json', { status: 'renamed', previous_filename: 'package-lock.json' }), // for dependency files too
    file('big.bin', { additions: 60_000 }), // no size limit: the reviewer decides
  ]
  assert.deepEqual(checkChange({ base: BASE, compare: compare(files, { ahead_by: 80 }) }), {
    ok: true,
    flagged: ['package.json', 'web/yarn.lock', 'package-lock.json'],
    careful: ['.github/workflows/ci.yml', '.GitHub/Actions/setup/action.yml', 'docs/CODEOWNERS', '.gitmodules', '.github/FUNDING.yml', '.github/workflows/old.yml'],
    partial: false,
  })
  assert.deepEqual(checkChange({ base: BASE, compare: compare([file('src/a.js')]) }), { ok: true, flagged: [], careful: [], partial: false })
  // GitHub lists at most 300 files: past that, the notes may miss some, and say so.
  assert.equal(checkChange({ base: BASE, compare: compare(Array.from({ length: 300 }, (_, i) => file(`f${i}`))) }).partial, true)
})

test('checkChange: refused only when it isn\'t a change on the base — wrong base, or nothing', () => {
  assert.match(checkChange({ base: BASE, compare: compare([file('x')], { merge_base_commit: { sha: TIP } }) }).reason, /aren't on top of bbbbbbb/)
  assert.match(checkChange({ base: BASE, compare: compare([file('x')], { behind_by: 1 }) }).reason, /aren't on top/)
  assert.equal(checkChange({ base: BASE, compare: compare([], { ahead_by: 2 }) }).reason, 'the commits add up to no change')
})

test('describeChange: title and body from the commits; authorship trailers dropped; who asked', () => {
  const commits = [{ commit: { message: 'Fix the crash\n\nIt was null.\n\nCo-authored-by: Linus <l@kernel.org>\nSigned-off-by: Someone' } }, { commit: { message: 'Add a test\nReviewed-by: x' } }]
  assert.deepEqual(describeChange(commits, req), {
    title: 'Fix the crash',
    body: 'It was null.\n\nAdd a test',
    message: `Fix the crash\n\nIt was null.\n\nAdd a test\n\nRequested by @alice in ${req.url}`,
  })
  assert.equal(describeChange([], req).title, 'Changes requested in acme/app#7')
})

const upstream = ['GET', /^\/repos\/acme\/app$/, { name: 'app', full_name: 'acme/app', default_branch: 'main' }]
const upstreamTip = ['GET', /^\/repos\/acme\/app\/git\/ref\/heads\/main$/, { object: { sha: BASE } }]
const ourFork = ['GET', /^\/repos\/botlite\/app$/, { fork: true, full_name: 'botlite/app', source: { full_name: 'acme/app' } }]

test('planWrite: an issue — a new draft PR into the default branch, from its tip; nothing forked yet', async () => {
  const gh = fakeGithub([upstream, upstreamTip])
  const plan = await planWrite({ gh, app: fakeApp(), me, req, pr: null, key: 'acme/app#7' })
  assert.deepEqual(
    { branch: plan.branch, staging: plan.staging, base: plan.base, baseUrl: plan.baseUrl, target: plan.target, fork: plan.fork, branchExists: plan.branchExists, existing: plan.existing, describe: plan.describe },
    { branch: 'botlite/acme/app/7', staging: 'botlite-staging/acme/app/7', base: BASE, baseUrl: 'https://github.com/acme/app.git', target: { repo: 'acme/app', base: 'main' }, fork: null, branchExists: false, existing: null, describe: 'as a new draft PR into main' },
  )
  assert.equal(gh.called('POST', /./).length, 0) // planning only reads
})

test('planWrite: a follow-up builds on the bot’s branch and its open draft PR', async () => {
  const gh = fakeGithub([
    upstream,
    ourFork,
    ['GET', /^\/repos\/botlite\/app\/git\/ref\/heads\/botlite\/acme\/app\/7$/, { object: { sha: TIP } }],
    ['GET', /^\/repos\/acme\/app\/pulls\?state=open&head=botlite%3Abotlite%2Facme%2Fapp%2F7$/, [{ number: 12, html_url: 'https://github.com/acme/app/pull/12' }]],
  ])
  const plan = await planWrite({ gh, app: fakeApp(), me, req, pr: null, key: 'acme/app#7' })
  assert.deepEqual([plan.base, plan.baseUrl, plan.fork, plan.branchExists, plan.existing.number], [TIP, 'https://github.com/botlite/app.git', 'botlite/app', true, 12])
  assert.equal(plan.describe, 'as one more commit on draft PR acme/app#12')
})

test('planWrite: a same-named repo outside the network is not the fork', async () => {
  const gh = fakeGithub([upstream, upstreamTip, ['GET', /^\/repos\/botlite\/app$/, { fork: true, full_name: 'botlite/app', source: { full_name: 'other/app' } }]])
  const plan = await planWrite({ gh, app: fakeApp(), me, req, pr: null, key: 'acme/app#7' })
  assert.equal(plan.fork, null)
  assert.equal(gh.called('GET', /botlite\/app\/git/).length, 0)
})

test('planWrite: a PR the bot opened is updated in place; anyone else’s gets a draft PR into its branch', async () => {
  const own = await planWrite({
    gh: fakeGithub([upstream, ['GET', /^\/repos\/botlite\/app\/git\/ref\/heads\/botlite\/acme\/app\/3$/, { object: { sha: TIP } }]]),
    app: fakeApp(), me, req: { ...req, number: 12 }, key: 'acme/app#12',
    pr: { headSha: TIP, headRepo: 'botlite/app', headRef: 'botlite/acme/app/3' },
  })
  assert.deepEqual([own.branch, own.target, own.base, own.fork, own.describe], ['botlite/acme/app/3', null, TIP, 'botlite/app', "as one more commit on this PR's branch"])

  const theirs = await planWrite({ gh: fakeGithub([upstream]), app: fakeApp(), me, req: { ...req, number: 9 }, key: 'acme/app#9', pr: { headSha: PUSHED, headRepo: 'carol/app', headRef: 'feature' } })
  assert.deepEqual([theirs.branch, theirs.target, theirs.base, theirs.baseUrl], ['botlite/acme/app/9', { repo: 'carol/app', base: 'feature' }, PUSHED, 'https://github.com/acme/app.git'])
  assert.equal(theirs.describe, "as a new draft PR into carol/app:feature (this PR's branch)")

  await assert.rejects(planWrite({ gh: fakeGithub([upstream]), app: fakeApp(), me, req, key: 'acme/app#9', pr: { headSha: PUSHED, headRepo: null, headRef: 'feature' } }), /branch is gone/)
})

test('plan.open: on the first push — fork, turn Actions off, sync, clear stale staging, mint a token for that fork; once', async () => {
  const gh = fakeGithub([
    upstream, upstreamTip,
    ['POST', /^\/repos\/acme\/app\/forks$/, { full_name: 'botlite/app', name: 'app', default_branch: 'main' }],
    ['GET', /^\/repos\/botlite\/app\/git\/ref\/heads\/main$/, { object: { sha: BASE } }],
    ['POST', /^\/repos\/botlite\/app\/merge-upstream$/, {}],
    ['DELETE', /^\/repos\/botlite\/app\/git\/refs\/heads\/botlite-staging\/acme\/app\/7$/, null],
    ['GET', /^\/repos\/botlite\/app\/actions\/permissions$/, { enabled: true, allowed_actions: 'all' }],
    ['PUT', /^\/repos\/botlite\/app\/actions\/permissions$/, null],
  ])
  const app = fakeApp()
  const plan = await planWrite({ gh, app, me, req, pr: null, key: 'acme/app#7' })
  assert.deepEqual(await Promise.all([plan.open(), plan.open()]), [{ repo: 'botlite/app', token: 'ghs_turn' }, { repo: 'botlite/app', token: 'ghs_turn' }])
  assert.deepEqual(app.minted, ['app +workflows']) // Actions off: the token may carry workflows
  assert.deepEqual(gh.called('POST', /forks$/)[0].body, { default_branch_only: true })
  assert.deepEqual(gh.called('POST', /merge-upstream$/)[0].body, { branch: 'main' })
  assert.deepEqual(gh.called('PUT', /actions\/permissions$/).map((c) => c.body), [{ enabled: false }])
  const order = gh.calls.map((c) => `${c.method} ${c.path}`)
  assert.ok(order.indexOf('PUT /repos/botlite/app/actions/permissions') < order.indexOf('POST /repos/botlite/app/merge-upstream'), 'Actions off before the sync, which would run CI on the fork')
  assert.equal(gh.called('DELETE', /botlite-staging/).length, 1)
  assert.equal(plan.fork, 'botlite/app')
  assert.equal(plan.behind, null)
})

test('plan.open: Actions already off → nothing to change; Actions it can\'t turn off → no push at all; a fork that can\'t catch up → noted', async () => {
  const fork = ['POST', /^\/repos\/acme\/app\/forks$/, { full_name: 'botlite/app', name: 'app', default_branch: 'main' }]
  const forkTip = ['GET', /^\/repos\/botlite\/app\/git\/ref\/heads\/main$/, { object: { sha: BASE } }]
  const clear = ['DELETE', /botlite-staging/, null]
  const opening = async (routes) => {
    const gh = fakeGithub([upstream, upstreamTip, fork, forkTip, clear, ...routes])
    const app = fakeApp()
    const logs = []
    const plan = await planWrite({ gh, app, me, req, pr: null, key: 'acme/app#7', log: (l) => logs.push(l) })
    return { gh, app, plan, logs, opened: await plan.open().catch((e) => e) }
  }
  const off = await opening([['POST', /merge-upstream$/, {}], ['GET', /actions\/permissions$/, { enabled: false }]])
  assert.deepEqual(off.app.minted, ['app +workflows'])
  assert.equal(off.gh.called('PUT', /./).length, 0)

  // The bot's token without the repo scope can't read or change the setting: nothing is pushed.
  const unknown = await opening([['POST', /merge-upstream$/, {}], ['GET', /actions\/permissions$/, () => { throw fail(403) }]])
  assert.equal(unknown.opened.message, "I couldn't turn Actions off on my fork botlite/app, so I won't push there (the bot's GitHub token needs the repo scope)")
  assert.deepEqual(unknown.app.minted, [])
  assert.equal(unknown.gh.called('POST', /merge-upstream$/).length, 0)
  assert.match(unknown.logs.join('\n'), /acme\/app#7: turning Actions off on botlite\/app: HTTP 403/)
  const refused = await publishWrite({ gh: unknown.gh, app: unknown.app, me, plan: unknown.plan, req, result: { pushed: null, error: 'fatal: …' } })
  assert.equal(refused, "⚠️ Couldn't set up the PR branch: I couldn't turn Actions off on my fork botlite/app, so I won't push there (the bot's GitHub token needs the repo scope)")

  const behind = await opening([['POST', /merge-upstream$/, () => { throw fail(422) }], ['GET', /actions\/permissions$/, { enabled: false }]])
  assert.equal(behind.plan.behind, 'HTTP 422')
  assert.match(behind.logs.join('\n'), /acme\/app#7: syncing botlite\/app: HTTP 422/)
})

/** A planned, opened issue turn and the GitHub that the box's push left behind. */
async function pushedTurn({ files, compared = {}, extra = [], plan: over = {} }) {
  const gh = fakeGithub([
    ...extra,
    ['GET', /^\/repos\/botlite\/app\/git\/ref\/heads\/botlite-staging\/acme\/app\/7$/, { object: { sha: PUSHED } }],
    ['GET', new RegExp(`^/repos/botlite/app/compare/${BASE}\\.\\.\\.${PUSHED}$`), { ...compare(files, { ahead_by: 2, ...compared }), commits: [{ commit: { message: 'Fix the crash\n\nIt was null.\n\nCo-authored-by: X <x@y>' } }, { commit: { message: 'Add a test' } }] }],
    ['GET', new RegExp(`^/repos/botlite/app/git/commits/${PUSHED}$`), { tree: { sha: TREE } }],
    ['POST', /^\/repos\/botlite\/app\/git\/commits$/, { sha: SQUASH }],
    ['POST', /^\/repos\/botlite\/app\/git\/refs$/, {}],
    ['POST', /^\/repos\/acme\/app\/pulls$/, { number: 12, html_url: 'https://github.com/acme/app/pull/12' }],
    ['DELETE', /botlite-staging/, null],
  ])
  const app = fakeApp()
  const plan = {
    branch: 'botlite/acme/app/7', staging: 'botlite-staging/acme/app/7', base: BASE, target: { repo: 'acme/app', base: 'main' }, existing: null, branchExists: false,
    fork: 'botlite/app', token: 'ghs_turn', opened: Promise.resolve(), ...over,
  }
  return { gh, app, plan, publish: (more = {}) => publishWrite({ gh, app, me, plan, req, result: { pushed: PUSHED }, ...more }) }
}

test('publishWrite: checks the pushed commit, squashes it as the bot onto the base, opens a draft PR', async () => {
  const t = await pushedTurn({ files: [file('src/a.js'), file('package.json')] })
  assert.equal(await t.publish(), '📬 Opened draft PR https://github.com/acme/app/pull/12.')
  assert.deepEqual(t.app.revoked, ['ghs_turn']) // before anything is read
  const [squash] = t.gh.called('POST', /git\/commits$/)
  assert.deepEqual(squash.body, { message: `Fix the crash\n\nIt was null.\n\nAdd a test\n\nRequested by @alice in ${req.url}`, tree: TREE, parents: [BASE] }) // no author: the token's user, the bot
  assert.deepEqual(t.gh.called('POST', /git\/refs$/)[0].body, { ref: 'refs/heads/botlite/acme/app/7', sha: SQUASH })
  const pull = t.gh.called('POST', /pulls$/)[0].body
  assert.deepEqual({ ...pull, body: undefined }, { title: 'Fix the crash', head: 'botlite:botlite/acme/app/7', base: 'main', body: undefined, draft: true, maintainer_can_modify: true })
  assert.match(pull.body, /^It was null\.\n\nAdd a test\n\n---\n\nRequested by @alice in https:\/\/github\.com\/acme\/app\/issues\/7#issuecomment-1\. Written by an AI agent/)
  assert.match(pull.body, /\*\*Dependencies changed:\*\* `package\.json` — check these closely\./)
  assert.equal(t.gh.called('DELETE', /botlite-staging/).length, 1)
})

test('planSlackWrite: a draft PR into the default branch, from the commit the box built on — which must be on it', async () => {
  const onMain = ['GET', new RegExp(`^/repos/acme/app/compare/main\\.\\.\\.${BASE}$`), { status: 'behind' }]
  const gh = fakeGithub([upstream, onMain, ourFork])
  const id = 'T01ABC/C02DEF/1712345678.000100@1712345699.000200'
  const plan = await planSlackWrite({ gh, app: fakeApp(), me, repo: 'acme/app', base: BASE, id })
  assert.match(plan.branch, /^botlite\/slack-[0-9a-f]{12}$/)
  assert.equal(plan.staging, plan.branch.replace('botlite/', 'botlite-staging/'))
  assert.doesNotMatch(`${plan.branch} ${plan.staging} ${plan.describe}`, /T01ABC|C02DEF|1712345678/) // the fork is public; Slack's ids are the team's
  assert.deepEqual([plan.base, plan.target, plan.branchExists, plan.fork, plan.existing], [BASE, { repo: 'acme/app', base: 'main' }, false, 'botlite/app', null])
  assert.equal((await planSlackWrite({ gh, app: fakeApp(), me, repo: 'acme/app', base: BASE, id: `${id}x` })).branch === plan.branch, false) // each request, its own PR
  assert.equal(typeof plan.open, 'function')

  for (const status of ['ahead', 'diverged']) {
    const off = fakeGithub([upstream, ['GET', /\/compare\//, { status }]])
    await assert.rejects(planSlackWrite({ gh: off, app: fakeApp(), me, repo: 'acme/app', base: BASE, id }), /bbbbbbb isn't on acme\/app's main: build on it/)
  }
  await assert.rejects(planSlackWrite({ gh: fakeGithub([upstream]), app: fakeApp(), me, repo: 'acme/app', base: BASE, id }), /isn't on acme\/app's main/) // unknown to GitHub
  const secret = fakeGithub([['GET', /^\/repos\/acme\/app$/, { name: 'app', full_name: 'acme/app', default_branch: 'main', private: true }]])
  await assert.rejects(planSlackWrite({ gh: secret, app: fakeApp(), me, repo: 'acme/app', base: BASE, id }), /acme\/app is private/)
})

test('publishWrite: a PR asked for in Slack says only that — never who asked, where, or a link', async () => {
  const t = await pushedTurn({ files: [file('src/a.js')], plan: { branch: 'botlite/slack-0123456789ab', staging: 'botlite-staging/acme/app/7' } })
  const slack = { repo: 'acme/app', origin: 'Requested from Slack' }
  assert.equal(await publishWrite({ gh: t.gh, app: t.app, me, plan: t.plan, req: slack, result: { pushed: PUSHED } }), '📬 Opened draft PR https://github.com/acme/app/pull/12.')
  assert.equal(t.gh.called('POST', /git\/commits$/)[0].body.message, 'Fix the crash\n\nIt was null.\n\nAdd a test\n\nRequested from Slack')
  const pull = t.gh.called('POST', /pulls$/)[0].body
  assert.equal(pull.head, 'botlite:botlite/slack-0123456789ab')
  assert.match(pull.body, /\n---\n\nRequested from Slack\. Written by an AI agent/)
  assert.doesNotMatch(JSON.stringify(t.gh.calls), /slack\.com|undefined/)
  assert.equal(describeChange([], slack).title, 'Changes requested from Slack')
})

test('publishWrite: a PR on the bot’s own repo that touches its trust boundary says so, at the top and in the reply', async () => {
  const self = await pushedTurn({ files: [file('src/a.js'), file('src/publish.mjs')] })
  assert.equal(await self.publish({ selfRepo: 'Acme/App' }), '📬 Opened draft PR https://github.com/acme/app/pull/12. It changes my own trust boundary (`src/publish.mjs`) — review it closely.')
  assert.match(self.gh.called('POST', /pulls$/)[0].body.body, /^> \[!WARNING\]\n> This changes the bot's own trust boundary — `src\/publish\.mjs`\. Review it closely: once merged, an admin's `\/deploy` puts it live\./)

  const other = await pushedTurn({ files: [file('src/a.js'), file('src/publish.mjs')] })
  assert.equal(await other.publish({ selfRepo: 'acme/bot' }), '📬 Opened draft PR https://github.com/acme/app/pull/12.') // not the bot's own repo
  assert.doesNotMatch(other.gh.called('POST', /pulls$/)[0].body.body, /WARNING/)
})

test('publishWrite: a refused change publishes nothing and says why; staging is cleaned up either way', async () => {
  const t = await pushedTurn({ files: [file('src/a.js')], compared: { merge_base_commit: { sha: TIP } } })
  assert.equal(await t.publish(), "⚠️ Not published: the commits aren't on top of bbbbbbb.")
  assert.equal(t.gh.called('POST', /./).length, 0)
  assert.equal(t.gh.called('DELETE', /botlite-staging/).length, 1)

  const paused = await pushedTurn({ files: [file('src/a.js')] })
  assert.equal(await paused.publish({ refuse: 'an admin paused PR writing while I worked' }), '⚠️ Not published: an admin paused PR writing while I worked.')
  assert.equal(paused.gh.called('GET', /compare/).length, 0)
  assert.deepEqual(paused.app.revoked, ['ghs_turn'])
})

test('publishWrite: CI, review and funding files are published — called out at the top of the PR and in the reply', async () => {
  const t = await pushedTurn({ files: [file('src/a.js'), file('.github/workflows/ci.yml'), file('CODEOWNERS')] })
  assert.equal(await t.publish(), '📬 Opened draft PR https://github.com/acme/app/pull/12. It changes `.github/workflows/ci.yml`, `CODEOWNERS` — check what that does before merging.')
  const { body } = t.gh.called('POST', /pulls$/)[0].body
  assert.match(body, /^> \[!CAUTION\]\n> This changes CI, review routing, submodules or sponsorship links — `\.github\/workflows\/ci\.yml`, `CODEOWNERS`\. Check exactly what they do before you approve a CI run or merge/)
  assert.equal(t.gh.called('GET', /git\/trees/).length, 0) // no rule looks at modes or sizes any more

  const huge = await pushedTurn({ files: Array.from({ length: 300 }, (_, i) => file(`f${i}.txt`)) })
  await huge.publish()
  assert.match(huge.gh.called('POST', /pulls$/)[0].body.body, /^> \[!NOTE\]\n> This changes more files than GitHub lists in one diff \(300\), so the notes on this PR may miss some/)
})

test('publishWrite: a follow-up fast-forwards the branch of its open PR — and never overwrites a push made meanwhile', async () => {
  const existing = { number: 12, html_url: 'https://github.com/acme/app/pull/12' }
  const ff = await pushedTurn({ files: [file('src/a.js')], plan: { branchExists: true, existing }, extra: [['PATCH', /git\/refs\/heads\/botlite\/acme\/app\/7$/, {}]] })
  assert.equal(await ff.publish(), '📬 Pushed c0ffee0 to draft PR https://github.com/acme/app/pull/12.')
  assert.deepEqual(ff.gh.called('PATCH', /refs/)[0].body, { sha: SQUASH, force: false })
  assert.equal(ff.gh.called('POST', /pulls$/).length, 0)

  const moved = await pushedTurn({ files: [file('src/a.js')], plan: { branchExists: true, existing }, extra: [['PATCH', /git\/refs\/heads\/botlite\/acme\/app\/7$/, () => { throw fail(422) }]] })
  assert.match(await moved.publish(), /Not published: `botlite\/acme\/app\/7` changed while I worked/)

  const own = await pushedTurn({ files: [file('src/a.js')], plan: { target: null, branchExists: true }, extra: [['PATCH', /git\/refs\/heads\/botlite\/acme\/app\/7$/, {}]] })
  assert.equal(await own.publish(), '📬 Pushed c0ffee0 to this PR.')
})

test('publishWrite: nothing pushed — silence, or a word when changes were left uncommitted or the push failed', async () => {
  const quiet = { branch: 'b', staging: 's', base: BASE, opened: null }
  assert.equal(await publishWrite({ gh: fakeGithub([]), app: fakeApp(), me, plan: quiet, req, result: { pushed: null, uncommitted: false } }), null)
  assert.equal(await publishWrite({ gh: fakeGithub([]), app: fakeApp(), me, plan: quiet, req, result: { pushed: null, uncommitted: true } }), '⚠️ Nothing was published: the changes were left uncommitted.')
  const failed = await pushedTurn({ files: [] })
  failed.gh.calls.length = 0
  const gh = fakeGithub([['DELETE', /./, null]])
  assert.equal(await publishWrite({ gh, app: failed.app, me, plan: failed.plan, req, result: { pushed: null, error: 'HTTP 403' } }), '⚠️ Nothing was published: my push failed (HTTP 403).')
  const broken = { ...failed.plan, opened: Promise.reject(new Error("the push App isn't installed on @botlite")) }
  assert.equal(await publishWrite({ gh, app: fakeApp(), me, plan: broken, req, result: null }), "⚠️ Couldn't set up the PR branch: the push App isn't installed on @botlite")
})
