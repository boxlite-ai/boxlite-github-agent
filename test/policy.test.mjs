import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mayUseSlack as mayUse, isSlackAdmin, slackPrAllowed, SLACK_PR_REPOS } from '../src/policy.mjs'

// What any access policy must keep true. Add the cases that pin down yours — members, guests,
// Slack Connect — next to these.
const home = { teamId: 'T1', enterpriseId: null }
const channel = { extShared: false }
const member = { id: 'U1', team_id: 'T1', deleted: false, is_bot: false, is_restricted: false, is_ultra_restricted: false }

test('mayUse: a deactivated account or a bot never gets in', () => {
  for (const user of [{ ...member, deleted: true }, { ...member, is_bot: true }]) {
    assert.equal(mayUse(user, home, channel).ok, false, JSON.stringify(user))
  }
})

test('mayUse: always answers { ok, why }, with a reason a person can read', () => {
  for (const user of [member, { ...member, is_restricted: true }, { ...member, team_id: 'T9', is_stranger: true }]) {
    for (const where of [channel, { extShared: true }]) {
      const r = mayUse(user, home, where)
      assert.equal(typeof r.ok, 'boolean')
      assert.equal(typeof r.why, 'string')
      assert.ok(r.why.length > 0)
    }
  }
})

test('TOOLS: every service lists reads and writes as tool names, and nothing is both', async () => {
  const { TOOLS } = await import('../src/policy.mjs')
  const { SERVICES } = await import('../src/tools.mjs')
  assert.deepEqual(Object.keys(TOOLS).sort(), Object.keys(SERVICES).sort())
  for (const [service, { read, write }] of Object.entries(TOOLS)) {
    for (const tool of [...read, ...write]) assert.match(tool, /^[\w.-]+$/, `${service} ${tool}`)
    assert.deepEqual(write.filter((t) => read.includes(t)), [], `${service}: listed as both a read and a write`)
  }
})

test('mayUse (members only): members of the workspace or its Grid org — not guests, outsiders, or shared channels', () => {
  const grid = { teamId: 'T1', enterpriseId: 'E1' }
  const ok = (user, h = home, where = channel) => mayUse(user, h, where).ok
  assert.equal(ok(member), true)
  assert.equal(ok({ ...member, team_id: 'T2', enterprise_user: { enterprise_id: 'E1' } }, grid), true) // a sibling workspace, same org
  assert.equal(ok({ ...member, team_id: 'T2', enterprise_user: { enterprise_id: 'E9' } }, grid), false)
  assert.equal(ok({ ...member, team_id: 'T9' }), false) // another organization, e.g. in Slack Connect
  assert.equal(ok({ ...member, team_id: 'T9', enterprise_user: { enterprise_id: undefined } }, home), false) // no org: no match on undefined
  assert.equal(ok({ ...member, is_stranger: true }), false)
  assert.equal(ok({ ...member, is_restricted: true }), false)
  assert.equal(ok({ ...member, is_restricted: true, is_ultra_restricted: true }), false)
  const shared = mayUse(member, home, { extShared: true })
  assert.deepEqual(shared, { ok: false, why: 'this channel is shared with another organization; ask me in one of ours, or in a DM' })
})

test("isSlackAdmin: the workspace's owners and admins run the bot from Slack — not members, not a deactivated owner", () => {
  const member = { id: 'U1', team_id: 'T1' }
  assert.equal(isSlackAdmin(member), false)
  for (const role of ['is_primary_owner', 'is_owner', 'is_admin']) assert.equal(isSlackAdmin({ ...member, [role]: true }), true, role)
  assert.equal(isSlackAdmin({ ...member, is_owner: true, deleted: true }), false)
  assert.equal(isSlackAdmin(undefined), false)
})

test('slackPrAllowed: owner/name or owner/*, any case — never another owner, nor a name that only starts alike', () => {
  const rules = ['boxlite-ai/*', 'acme/app']
  for (const repo of ['boxlite-ai/boxlite', 'BoxLite-AI/Boxlite-Github-Agent', 'acme/app', 'ACME/App']) assert.equal(slackPrAllowed(repo, rules), true, repo)
  for (const repo of ['acme/app2', 'acme/other', 'boxlite-ai-evil/x', 'someone/boxlite-ai', 'boxlite/ai', '']) assert.equal(slackPrAllowed(repo, rules), false, repo)
  assert.deepEqual(SLACK_PR_REPOS, ['boxlite-ai/*']) // as shipped: the team's own public repos
})
