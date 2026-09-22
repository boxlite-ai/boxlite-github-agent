import assert from 'node:assert/strict'
import { test } from 'node:test'
import { COMMANDS, parseCommand, writeAccess, helpText, runCommand } from '../src/access.mjs'

test('parseCommand: `@bot /word` at the start of a comment, or a comment that is only `@bot help`', () => {
  assert.deepEqual(parseCommand('@boxliteai /add @alice', 'boxliteai'), { name: 'add', arg: '@alice' })
  assert.deepEqual(parseCommand('  @BoxLiteAI   /REMOVE alice\nthanks!', 'boxliteai'), { name: 'remove', arg: 'alice' })
  assert.deepEqual(parseCommand('@boxliteai\n/list', 'boxliteai'), { name: 'list', arg: '' })
  assert.deepEqual(parseCommand('@boxliteai /help', 'boxliteai'), { name: 'help', arg: '' })
  for (const body of ['@boxliteai help', '@boxliteai Help!', '@boxliteai help?']) assert.deepEqual(parseCommand(body, 'boxliteai'), { name: 'help', arg: '' }, body)
})

test('parseCommand: requests stay requests — they go to Codex', () => {
  for (const body of [
    '@boxliteai help me fix this test', // a request that starts with "help"
    '@boxliteai /usr/bin/node crashes on start', // a path, not a command word
    'hey @boxliteai /add @alice', // not at the start
    '> @boxliteai /add @alice\n\nsee above', // quoted
    '@boxliteai-dev /add @alice', // someone else
    '@boxliteai why does /help 404?',
    '',
    null,
  ]) {
    assert.equal(parseCommand(body, 'boxliteai'), null, String(body))
  }
})

test('parseCommand: an unknown command word is caught, never handed to the model', () => {
  assert.deepEqual(parseCommand('@boxliteai /ad @alice', 'boxliteai'), { unknown: 'ad' })
  assert.deepEqual(parseCommand('@boxliteai /Review this', 'boxliteai'), { unknown: 'review' })
})

const ADMINS = new Map([[1, 'root']])
const req = (over = {}) => ({ repo: 'Acme/App', author: 'alice', userId: 42, association: 'NONE', kind: 'comment', edited: false, ...over })

test('writeAccess: admins anywhere, maintainers in their repo, added people where added — nobody else', () => {
  const state = { grants: { 'acme/app': { 42: { login: 'alice', by: 'root', at: 'T' } } }, paused: null }
  assert.deepEqual(writeAccess({ state, admins: ADMINS, req: req({ userId: 1, author: 'root' }) }), { ok: true, why: "you're an admin of this bot" })
  for (const association of ['OWNER', 'MEMBER', 'COLLABORATOR']) {
    assert.equal(writeAccess({ state: {}, admins: ADMINS, req: req({ userId: 7, association }) }).ok, true, association)
  }
  assert.deepEqual(writeAccess({ state, admins: ADMINS, req: req() }), { ok: true, why: '@root added you' }) // repo names are case-insensitive
  for (const r of [req({ repo: 'acme/other' }), req({ userId: 43 }), req({ userId: 43, association: 'CONTRIBUTOR' }), req({ userId: 43, association: 'FIRST_TIME_CONTRIBUTOR' })]) {
    assert.deepEqual(writeAccess({ state, admins: ADMINS, req: r }), { ok: false, why: 'only maintainers of this repo and people an admin added can' })
  }
})

test('writeAccess: a pause or a missing push App stops everyone, admins too', () => {
  const paused = { grants: {}, paused: { by: 'root', at: 'T' } }
  assert.deepEqual(writeAccess({ state: paused, admins: ADMINS, req: req({ userId: 1 }) }), { ok: false, why: 'an admin (@root) paused PR writing' })
  assert.deepEqual(writeAccess({ state: {}, admins: ADMINS, req: req({ userId: 1 }), ready: false }), { ok: false, why: "PR writing isn't set up on this bot" })
})

test('helpText: what this person can do here; admin commands only for admins; the table is the source', () => {
  const allowed = { ok: true, why: "you're a maintainer here" }
  const text = helpText({ login: 'boxliteai', req: req(), access: allowed, isAdmin: false, left: 18, limit: 20 })
  assert.match(text, /^@alice mention me with a question or a task/)
  assert.match(text, /`@boxliteai \/help` — this list/)
  assert.match(text, /\*\*PRs:\*\* you can ask me to open or update PRs in Acme\/App \(you're a maintainer here\)\. They're drafts from my fork/)
  assert.match(text, /18 of 20 requests left today \(resets at 00:00 UTC\)\./)
  assert.doesNotMatch(text, /\/add/)

  const denied = helpText({ login: 'boxliteai', req: req(), access: { ok: false, why: 'only maintainers of this repo and people an admin added can' }, isAdmin: true, left: 0, limit: 20 })
  assert.match(denied, /\*\*PRs:\*\* you can't ask me for PRs in Acme\/App: only maintainers of this repo and people an admin added can\./)
  for (const c of COMMANDS.filter((x) => x.admin)) assert.match(denied, new RegExp(`\`@boxliteai ${c.usage.replace('/', '\\/')}\` — ${c.does}`))
})

const lookup = async (login) => ({ bob: { id: 77, login: 'Bob' } })[login.toLowerCase()] ?? null
const ctx = (state, over = {}) => ({ state, admins: ADMINS, req: req({ userId: 1, author: 'root' }), login: 'boxliteai', lookup, access: { ok: true, why: 'x' }, left: 5, limit: 20, now: new Date('2026-09-22T10:00:00Z'), ...over })

test('runCommand: /add, /list, /remove — by numeric id, per repo, admins only', async () => {
  const state = { grants: {}, paused: null }
  assert.equal(await runCommand({ name: 'add', arg: '@bob' }, ctx(state)), '@root ✅ @Bob can now ask me for PRs in Acme/App.')
  assert.deepEqual(state.grants, { 'acme/app': { 77: { login: 'Bob', by: 'root', at: '2026-09-22T10:00:00.000Z' } } })
  assert.equal(writeAccess({ state, admins: ADMINS, req: req({ userId: 77, author: 'Bob' }) }).ok, true)
  assert.equal(writeAccess({ state, admins: ADMINS, req: req({ userId: 77, repo: 'acme/other' }) }).ok, false)
  assert.match(await runCommand({ name: 'list', arg: '' }, ctx(state)), /- @Bob — added by @root on 2026-09-22/)

  assert.equal(await runCommand({ name: 'remove', arg: 'bob' }, ctx(state)), '@root ✅ @Bob can no longer ask me for PRs in Acme/App.')
  assert.equal(writeAccess({ state, admins: ADMINS, req: req({ userId: 77 }) }).ok, false)
  assert.equal(await runCommand({ name: 'remove', arg: 'bob' }, ctx(state)), "@root @Bob wasn't on the list for Acme/App.")
  assert.match(await runCommand({ name: 'list', arg: '' }, ctx(state)), /nobody else can ask me for PRs in Acme\/App/)

  assert.equal(await runCommand({ name: 'add', arg: '@ghost' }, ctx(state)), "@root there's no GitHub user @ghost.")
  assert.equal(await runCommand({ name: 'add', arg: '' }, ctx(state)), '@root usage: `@boxliteai /add @user`')
  assert.equal(await runCommand({ name: 'add', arg: '../../etc' }, ctx(state)), '@root usage: `@boxliteai /add @user`')
})

test('runCommand: admin commands refused from non-admins, edited comments and issue bodies', async () => {
  const state = { grants: {}, paused: null }
  assert.equal(await runCommand({ name: 'add', arg: '@bob' }, ctx(state, { req: req({ association: 'OWNER' }) })), "@alice only this bot's admins can use `/add`.")
  for (const over of [{ edited: true }, { kind: 'body' }]) {
    assert.match(await runCommand({ name: 'pause', arg: '' }, ctx(state, { req: req({ userId: 1, author: 'root', ...over }) })), /only count in a new comment that was never edited/)
  }
  assert.deepEqual(state, { grants: {}, paused: null }) // nothing changed
})

test('runCommand: /pause and /resume; /help and unknown words answer with the help text', async () => {
  const state = { grants: {}, paused: null }
  assert.match(await runCommand({ name: 'pause', arg: '' }, ctx(state)), /⏸️ PR writing is paused everywhere\. `@boxliteai \/resume` turns it back on\./)
  assert.deepEqual(state.paused, { by: 'root', at: '2026-09-22T10:00:00.000Z' })
  assert.match(await runCommand({ name: 'resume', arg: '' }, ctx(state)), /▶️ PR writing is back on/)
  assert.equal(state.paused, null)

  const help = await runCommand({ name: 'help', arg: '' }, ctx(state, { req: req() }))
  assert.match(help, /^@alice mention me/)
  assert.doesNotMatch(help, /\*\*Admin:\*\*/) // alice isn't an admin
  const unknown = await runCommand({ unknown: 'ad' }, ctx(state))
  assert.match(unknown, /^I don't know `\/ad`\.\n\n@root mention me/)
  assert.match(unknown, /\*\*Admin:\*\*/) // root is
})
