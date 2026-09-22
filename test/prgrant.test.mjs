import assert from 'node:assert/strict'
import { test, before, after } from 'node:test'
import http from 'node:http'
import { prGrantHandler } from '../src/prgrant.mjs'
import { jobTokens } from '../src/chatgpt.mjs'

const SECRET = Buffer.from('job-secret')
const jobs = jobTokens(SECRET)
const logs = []
const BASE = 'b'.repeat(40)
let server
let url

before(async () => {
  server = http.createServer(prGrantHandler({ secret: SECRET, jobs, log: (l) => logs.push(l) }))
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  url = `http://127.0.0.1:${server.address().port}`
})
after(() => server.close())

const ask = (token, body, { path = '/pr', method = 'POST' } = {}) =>
  fetch(`${url}${path}`, { method, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), 'content-type': 'application/json' }, ...(method === 'POST' ? { body: typeof body === 'string' ? body : JSON.stringify(body) } : {}) })

/** A Slack turn's job whose grant takes one repo, as slack-channel.mjs's does. */
function slackJob(allowed = 'boxlite-ai/app') {
  const job = { who: 'Alice (U1)', writes: [] }
  job.pr = {
    grant: async ({ repo, base }) => {
      if (repo !== allowed) throw new Error(`I may open PRs only in ${allowed}`)
      job.push = { ref: 'refs/heads/botlite-staging/slack-0123456789ab', open: async () => ({}) }
      job.granted = { repo, base }
      return { ref: job.push.ref }
    },
  }
  return job
}

test('/pr: a Slack turn gets the one ref it may push — for the repo its rules allow — once', async () => {
  const job = slackJob()
  const t = jobs.issue(60_000, 'T1/C1/1.1', job)
  const r = await ask(t, { repo: 'boxlite-ai/app', base: BASE })
  assert.equal(r.status, 200)
  assert.deepEqual(await r.json(), { ref: 'refs/heads/botlite-staging/slack-0123456789ab' })
  assert.deepEqual(job.granted, { repo: 'boxlite-ai/app', base: BASE })
  assert.ok(logs.some((l) => l === 'T1/C1/1.1: PR into boxlite-ai/app for Alice (U1), from bbbbbbb'))
  const again = await ask(t, { repo: 'boxlite-ai/app', base: BASE })
  assert.equal(again.status, 409) // one PR per turn
  jobs.revoke(t)
})

test('/pr: the job’s rules say no — a repo it may not write, PR writing paused — and it says why, once', async () => {
  const job = slackJob()
  const t = jobs.issue(60_000, 'T1/C1/2.2', job)
  const r = await ask(t, { repo: 'someone/else', base: BASE })
  assert.equal(r.status, 403)
  assert.deepEqual(await r.json(), { error: 'I may open PRs only in boxlite-ai/app' })
  assert.equal(job.push, null) // nothing it may push
  assert.equal((await ask(t, { repo: 'boxlite-ai/app', base: BASE })).status, 409) // no second try at another repo
  assert.ok(logs.some((l) => /no PR into someone\/else for Alice \(U1\): I may open PRs only in boxlite-ai\/app/.test(l)))
  jobs.revoke(t)
})

test('/pr: only a live Slack turn’s token, only { repo, base } — a GitHub turn, a stranger, junk: refused', async () => {
  assert.equal((await ask(null, { repo: 'boxlite-ai/app', base: BASE })).status, 403)
  assert.equal((await ask('a.b.c', { repo: 'boxlite-ai/app', base: BASE })).status, 403)
  const gone = jobs.issue(60_000, 'T1/C1/3.3', slackJob())
  jobs.revoke(gone)
  assert.equal((await ask(gone, { repo: 'boxlite-ai/app', base: BASE })).status, 403)
  const github = jobs.issue(60_000, 'acme/app#7', { who: '@stranger' }) // a GitHub turn has no PR grant here
  const r = await ask(github, { repo: 'boxlite-ai/app', base: BASE })
  assert.equal(r.status, 403)
  assert.deepEqual(await r.json(), { error: 'this turn may not open a PR' })
  jobs.revoke(github)

  const job = slackJob()
  const t = jobs.issue(60_000, 'T1/C1/4.4', job)
  for (const body of ['{not json', { repo: '../../etc', base: BASE }, { repo: 'boxlite-ai/app', base: 'main' }, { repo: 'boxlite-ai/app' }, []]) {
    assert.equal((await ask(t, body)).status, 400, JSON.stringify(body))
  }
  assert.equal((await ask(t, 'x'.repeat(5000))).status, 400) // too large
  assert.equal((await ask(t, {}, { method: 'GET' })).status, 404)
  assert.equal((await ask(t, { repo: 'boxlite-ai/app', base: BASE }, { path: '/pr/x' })).status, 404)
  assert.equal(job.granted, undefined) // none of that reached the rules
  assert.equal((await ask(t, { repo: 'boxlite-ai/app', base: BASE })).status, 200) // and the one good ask still works
  jobs.revoke(t)
})
