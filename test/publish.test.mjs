import assert from 'node:assert/strict'
import { test } from 'node:test'
import { branchesFor, checkChange, describeChange, treeEntries, planWrite, publishWrite, LIMITS } from '../src/publish.mjs'

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
  app.token = async (repo) => (app.minted.push(repo), 'ghs_turn')
  app.revoke = async (t) => app.revoked.push(t)
  return app
}

test('branchesFor: readable, one per thread, valid ref names even for .github or x.lock repos', () => {
  assert.deepEqual(branchesFor('acme/app#7'), { branch: 'botlite/acme/app/7', staging: 'botlite-staging/acme/app/7' })
  assert.equal(branchesFor('acme/.github#3').branch, 'botlite/acme/_github/3')
  assert.equal(branchesFor('acme/x.lock#1').branch, 'botlite/acme/x_lock/1')
  assert.equal(branchesFor('acme/a..b#1').branch, 'botlite/acme/a__b/1')
})

const compare = (files, over = {}) => ({ merge_base_commit: { sha: BASE }, behind_by: 0, ahead_by: 1, files, ...over })
const file = (filename, over = {}) => ({ filename, status: 'modified', additions: 2, deletions: 1, ...over })
const blob = (size = 100, mode = '100644') => ({ mode, type: 'blob', size })

test('checkChange: a normal change passes; dependency files are flagged, not blocked', () => {
  const files = [file('src/a.js'), file('package.json'), file('web/yarn.lock'), file('gone.txt', { status: 'removed' })]
  const entries = { 'src/a.js': blob(), 'package.json': blob(), 'web/yarn.lock': blob() }
  assert.deepEqual(checkChange({ base: BASE, compare: compare(files), entries }), { ok: true, flagged: ['package.json', 'web/yarn.lock'] })
})

test('checkChange: workflows, actions, CODEOWNERS, submodules and funding links are never written', () => {
  for (const f of [
    file('.github/workflows/ci.yml'),
    file('.github/actions/setup/action.yml'),
    file('docs/CODEOWNERS'),
    file('.gitmodules'),
    file('.github/FUNDING.yml'),
    file('.GitHub/Workflows/x.yml'), // case doesn't help
    file('ci.yml', { status: 'renamed', previous_filename: '.github/workflows/ci.yml' }), // nor moving one away
    file('.github/workflows/old.yml', { status: 'removed' }), // nor deleting one
  ]) {
    const v = checkChange({ base: BASE, compare: compare([f]), entries: { [f.filename]: blob() } })
    assert.equal(v.ok, false, f.filename)
    assert.match(v.reason, /it touches `.+` — I never change workflows/, f.filename)
  }
})

test('checkChange: symlinks, submodules, big files, too much, wrong base, nothing — refused with the reason', () => {
  const one = (entry, f = file('x')) => checkChange({ base: BASE, compare: compare([f]), entries: { x: entry } }).reason
  assert.equal(one(blob(10, '120000')), '`x` is a symlink')
  assert.equal(one(blob(0, '160000')), '`x` is a submodule')
  assert.equal(one(blob(LIMITS.blobBytes + 1)), '`x` is over 1 MiB')
  assert.equal(one(null), "`x` couldn't be checked")
  const many = Array.from({ length: LIMITS.files + 1 }, (_, i) => file(`f${i}`))
  assert.match(checkChange({ base: BASE, compare: compare(many), entries: {} }).reason, /changes 101 files \(limit 100\)/)
  assert.match(checkChange({ base: BASE, compare: compare([file('x', { additions: 6000 })]), entries: { x: blob() } }).reason, /changes 6001 lines/)
  assert.match(checkChange({ base: BASE, compare: compare([file('x')], { ahead_by: 51 }), entries: { x: blob() } }).reason, /51 commits/)
  assert.match(checkChange({ base: BASE, compare: compare([file('x')], { merge_base_commit: { sha: TIP } }), entries: { x: blob() } }).reason, /aren't on top of bbbbbbb/)
  assert.match(checkChange({ base: BASE, compare: compare([file('x')], { behind_by: 1 }), entries: { x: blob() } }).reason, /aren't on top/)
  assert.equal(checkChange({ base: BASE, compare: compare([], { ahead_by: 2 }), entries: {} }).reason, 'the commits add up to no change')
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

test('treeEntries: only the directories on the way to the changed paths, each once', async () => {
  const gh = fakeGithub([
    ['GET', /trees\/ROOT$/, { tree: [{ path: 'a', type: 'tree', sha: 'A' }, { path: 'f.txt', ...blob(1) }] }],
    ['GET', /trees\/A$/, { tree: [{ path: 'b', type: 'tree', sha: 'AB' }, { path: 'e.txt', ...blob(2) }] }],
    ['GET', /trees\/AB$/, { tree: [{ path: 'c.txt', ...blob(3) }, { path: 'l', ...blob(4, '120000') }] }],
  ])
  const out = await treeEntries(gh, 'botlite/app', 'ROOT', ['a/b/c.txt', 'a/b/l', 'a/e.txt', 'f.txt', 'new/dir/x.txt'])
  assert.deepEqual(Object.fromEntries(Object.entries(out).map(([p, e]) => [p, e && e.size])), { 'a/b/c.txt': 3, 'a/b/l': 4, 'a/e.txt': 2, 'f.txt': 1, 'new/dir/x.txt': null })
  assert.equal(gh.calls.length, 3)
  await assert.rejects(treeEntries(gh, 'botlite/app', 'ROOT', ['a/b/c.txt'], { maxCalls: 2 }), /too many directories/)
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

test('plan.open: on the first push — fork, sync, clear stale staging, mint a token for that fork; once', async () => {
  const gh = fakeGithub([
    upstream, upstreamTip,
    ['POST', /^\/repos\/acme\/app\/forks$/, { full_name: 'botlite/app', name: 'app', default_branch: 'main' }],
    ['GET', /^\/repos\/botlite\/app\/git\/ref\/heads\/main$/, { object: { sha: BASE } }],
    ['POST', /^\/repos\/botlite\/app\/merge-upstream$/, {}],
    ['DELETE', /^\/repos\/botlite\/app\/git\/refs\/heads\/botlite-staging\/acme\/app\/7$/, null],
  ])
  const app = fakeApp()
  const plan = await planWrite({ gh, app, me, req, pr: null, key: 'acme/app#7' })
  assert.deepEqual(await Promise.all([plan.open(), plan.open()]), [{ repo: 'botlite/app', token: 'ghs_turn' }, { repo: 'botlite/app', token: 'ghs_turn' }])
  assert.deepEqual(app.minted, ['app'])
  assert.deepEqual(gh.called('POST', /forks$/)[0].body, { default_branch_only: true })
  assert.deepEqual(gh.called('POST', /merge-upstream$/)[0].body, { branch: 'main' })
  assert.equal(gh.called('DELETE', /botlite-staging/).length, 1)
  assert.equal(plan.fork, 'botlite/app')
})

/** A planned, opened issue turn and the GitHub that the box's push left behind. */
async function pushedTurn({ files, entries = { 'src/a.js': blob(), 'package.json': blob() }, extra = [], plan: over = {} }) {
  const gh = fakeGithub([
    ...extra,
    ['GET', /^\/repos\/botlite\/app\/git\/ref\/heads\/botlite-staging\/acme\/app\/7$/, { object: { sha: PUSHED } }],
    ['GET', new RegExp(`^/repos/botlite/app/compare/${BASE}\\.\\.\\.${PUSHED}$`), { ...compare(files, { ahead_by: 2 }), commits: [{ commit: { message: 'Fix the crash\n\nIt was null.\n\nCo-authored-by: X <x@y>' } }, { commit: { message: 'Add a test' } }] }],
    ['GET', new RegExp(`^/repos/botlite/app/git/commits/${PUSHED}$`), { tree: { sha: TREE } }],
    ['GET', new RegExp(`^/repos/botlite/app/git/trees/${TREE}$`), { tree: [{ path: 'src', type: 'tree', sha: 'SRC' }, { path: 'package.json', ...entries['package.json'] }, { path: '.gitmodules', ...blob() }] }],
    ['GET', /^\/repos\/botlite\/app\/git\/trees\/SRC$/, { tree: [{ path: 'a.js', ...entries['src/a.js'] }] }],
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

test('publishWrite: a refused change publishes nothing and says why; staging is cleaned up either way', async () => {
  const t = await pushedTurn({ files: [file('src/a.js'), file('.gitmodules')] })
  assert.equal(await t.publish(), '⚠️ Not published: it touches `.gitmodules` — I never change workflows, actions, CODEOWNERS, submodules or funding links.')
  assert.equal(t.gh.called('POST', /./).length, 0)
  assert.equal(t.gh.called('DELETE', /botlite-staging/).length, 1)

  const link = await pushedTurn({ files: [file('src/a.js')], entries: { 'src/a.js': blob(9, '120000'), 'package.json': blob() } })
  assert.equal(await link.publish(), '⚠️ Not published: `src/a.js` is a symlink.')

  const paused = await pushedTurn({ files: [file('src/a.js')] })
  assert.equal(await paused.publish({ refuse: 'an admin paused PR writing while I worked' }), '⚠️ Not published: an admin paused PR writing while I worked.')
  assert.equal(paused.gh.called('GET', /compare/).length, 0)
  assert.deepEqual(paused.app.revoked, ['ghs_turn'])
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
  assert.equal(await publishWrite({ gh, app: failed.app, me, plan: failed.plan, req, result: { pushed: null, error: 'HTTP 403' } }), '⚠️ Nothing was published: the push failed (HTTP 403).')
  const broken = { ...failed.plan, opened: Promise.reject(new Error("the push App isn't installed on @botlite")) }
  assert.equal(await publishWrite({ gh, app: fakeApp(), me, plan: broken, req, result: null }), "⚠️ Couldn't set up the PR branch: the push App isn't installed on @botlite")
})
