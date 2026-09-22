import assert from 'node:assert/strict'
import { test } from 'node:test'
import { scheduler } from '../src/jobs.mjs'
import { loadState, saveState, takeQuota, quotaLeft, importSlackState } from '../src/state.mjs'
import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

test('scheduler: one job at a time per thread, in order; a failure does not block the next', async () => {
  const schedule = scheduler(4)
  const log = []
  const task = (name, ms, fail = false) => async () => {
    log.push(`start ${name}`)
    await sleep(ms)
    log.push(`end ${name}`)
    if (fail) throw new Error(name)
  }
  await Promise.allSettled([schedule('a#1', task('first', 20, true)), schedule('a#1', task('second', 5))])
  assert.deepEqual(log, ['start first', 'end first', 'start second', 'end second'])
})

test('scheduler: at most `max` jobs at once across threads', async () => {
  const schedule = scheduler(2)
  let running = 0
  let peak = 0
  const task = async () => {
    peak = Math.max(peak, ++running)
    await sleep(10)
    running--
  }
  await Promise.all(['a#1', 'b#2', 'c#3', 'd#4', 'e#5'].map((k) => schedule(k, task)))
  assert.equal(peak, 2)
})

test('state: defaults when missing, round-trips, owner-only file', async () => {
  const file = path.join(mkdtempSync(path.join(tmpdir(), 'state-')), 'state', 'state.json')
  const s = await loadState(file)
  assert.deepEqual({ ...s, seen: [...s.seen], slack: { ...s.slack, seen: [...s.slack.seen] } }, { unknown: {}, lastModified: null, polledAt: null, sweeps: {}, seen: [], threads: {}, usage: {}, grants: {}, paused: null, forks: {}, codex: null, deploy: null, slack: { seen: [], threads: {}, usage: {}, deferred: [] } })
  s.seen.add('ic:1')
  s.threads['acme/app#7'] = { sessionId: 's1', boxId: 'b1' }
  s.lastModified = 'T1'
  s.grants['acme/app'] = { 42: { login: 'alice', by: 'root', at: 'T0' } }
  s.paused = { by: 'root', at: 'T1' }
  s.forks['acme/app'] = 'botlite/app'
  s.codex = { model: 'gpt-6-astra', effort: 'xhigh', by: 'root', at: 'T2' }
  s.deploy = { from: 'a', to: 'b', by: 'root', at: 'T3', reply: { repo: 'acme/bot', number: 7, kind: 'comment', commentId: 1 } }
  s.polledAt = '2026-09-22T10:20:09Z'
  s.sweeps['acme/bot#7'] = { repo: 'acme/bot', number: 7, since: '2026-09-22T10:20:09Z' } // a second look outlives a restart
  await saveState(file, s)
  const again = await loadState(file)
  assert.deepEqual([...again.seen], ['ic:1'])
  assert.deepEqual(again.threads, { 'acme/app#7': { sessionId: 's1', boxId: 'b1' } })
  assert.deepEqual([again.grants, again.paused, again.forks, again.codex, again.deploy, again.polledAt, again.sweeps], [s.grants, s.paused, s.forks, s.codex, s.deploy, s.polledAt, s.sweeps])
  assert.equal(statSync(file).mode & 0o777, 0o600)
})

test('state: Slack’s memory is apart from GitHub’s, round-trips, and forgets a thread quiet for 90 days', async () => {
  const file = path.join(mkdtempSync(path.join(tmpdir(), 'state-')), 'state.json')
  const s = await loadState(file)
  s.slack.seen.add('C01:1712345678.000100')
  s.slack.threads['T01/C01/1712345678.000100'] = { sessionId: 's1', lastTs: '1712345678.000100', lastUsed: '2026-09-22T00:00:00.000Z' }
  s.slack.threads['T01/C01/1700000000.000100'] = { sessionId: 'old', lastTs: '1700000000.000100', lastUsed: '2026-01-01T00:00:00.000Z' }
  s.slack.deferred.push({ id: 'C01:1712345679.000100' })
  await saveState(file, s, Date.parse('2026-09-22T12:00:00Z'))
  const again = await loadState(file)
  assert.deepEqual([...again.slack.seen], ['C01:1712345678.000100'])
  assert.deepEqual(Object.keys(again.slack.threads), ['T01/C01/1712345678.000100']) // the January one is forgotten
  assert.deepEqual(again.slack.deferred, [{ id: 'C01:1712345679.000100' }])
  assert.equal(again.seen.size, 0) // GitHub's handled comments are another set
})

test('state: the Slack agent’s memory, handed over at the switch, carries on here', async () => {
  const s = await loadState(path.join(mkdtempSync(path.join(tmpdir(), 'state-')), 'state.json'))
  s.slack.threads['T01/C01/1.1'] = { sessionId: 'mine', lastUsed: '2026-09-22T10:00:00.000Z' }
  importSlackState(s, {
    seen: ['C01:1.1', 'C01:2.2'],
    threads: { 'T01/C01/1.1': { sessionId: 'older', lastUsed: '2026-09-21T10:00:00.000Z' }, 'T01/C01/2.2': { sessionId: 'theirs', lastUsed: '2026-09-22T09:00:00.000Z' } },
    deferred: [{ id: 'C01:3.3' }],
  })
  assert.deepEqual([...s.slack.seen].sort(), ['C01:1.1', 'C01:2.2'])
  assert.equal(s.slack.threads['T01/C01/1.1'].sessionId, 'mine') // the newer one wins
  assert.equal(s.slack.threads['T01/C01/2.2'].sessionId, 'theirs')
  assert.deepEqual(s.slack.deferred, [{ id: 'C01:3.3' }])
})

test('state: fields this build doesn’t know survive a load and save — a rollback never drops a newer build’s settings', async () => {
  const file = path.join(mkdtempSync(path.join(tmpdir(), 'state-')), 'state.json')
  writeFileSync(file, JSON.stringify({ seen: ['ic:1'], usage: {}, fromTheFuture: { keep: 'me' }, alsoNew: [1, 2] }))
  const s = await loadState(file)
  s.usage.bob = { day: 'D', count: 1 }
  await saveState(file, s)
  const raw = JSON.parse(readFileSync(file, 'utf8'))
  assert.deepEqual([raw.fromTheFuture, raw.alsoNew, raw.usage.bob], [{ keep: 'me' }, [1, 2], { day: 'D', count: 1 }])
  assert.equal('unknown' in raw, false)
})

test('state: remembers only the newest 10k handled comments', async () => {
  const file = path.join(mkdtempSync(path.join(tmpdir(), 'state-')), 'state.json')
  const s = await loadState(file)
  for (let i = 0; i < 10_005; i++) s.seen.add(`ic:${i}`)
  await saveState(file, s)
  const again = await loadState(file)
  assert.equal(again.seen.size, 10_000)
  assert.equal(again.seen.has('ic:4'), false)
  assert.equal(again.seen.has('ic:10004'), true)
})

test('takeQuota: counts per user per UTC day', () => {
  const s = { usage: {} }
  const d1 = new Date('2026-09-21T23:00:00Z')
  assert.equal(takeQuota(s, 'bob', 2, d1), true)
  assert.equal(takeQuota(s, 'bob', 2, d1), true)
  assert.equal(takeQuota(s, 'bob', 2, d1), false)
  assert.equal(takeQuota(s, 'amy', 2, d1), true)
  assert.equal(takeQuota(s, 'bob', 2, new Date('2026-09-22T00:01:00Z')), true) // new day
})

test('quotaLeft: what is left today; yesterday’s count doesn’t carry over', () => {
  const s = { usage: { bob: { day: '2026-09-21', count: 17 } } }
  assert.equal(quotaLeft(s, 'bob', 20, new Date('2026-09-21T23:00:00Z')), 3)
  assert.equal(quotaLeft(s, 'bob', 20, new Date('2026-09-22T00:01:00Z')), 20)
  assert.equal(quotaLeft(s, 'amy', 20, new Date('2026-09-21T23:00:00Z')), 20)
  assert.equal(quotaLeft({ usage: { bob: { day: '2026-09-21', count: 25 } } }, 'bob', 20, new Date('2026-09-21T23:00:00Z')), 0)
})
