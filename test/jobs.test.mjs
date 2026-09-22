import assert from 'node:assert/strict'
import { test } from 'node:test'
import { scheduler } from '../src/jobs.mjs'
import { loadState, saveState, takeQuota } from '../src/state.mjs'
import { mkdtempSync, statSync } from 'node:fs'
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
  assert.deepEqual({ ...s, seen: [...s.seen] }, { lastModified: null, seen: [], threads: {}, usage: {}, grants: {}, paused: null, forks: {} })
  s.seen.add('ic:1')
  s.threads['acme/app#7'] = { sessionId: 's1', boxId: 'b1' }
  s.lastModified = 'T1'
  s.grants['acme/app'] = { 42: { login: 'alice', by: 'root', at: 'T0' } }
  s.paused = { by: 'root', at: 'T1' }
  s.forks['acme/app'] = 'botlite/app'
  await saveState(file, s)
  const again = await loadState(file)
  assert.deepEqual([...again.seen], ['ic:1'])
  assert.deepEqual(again.threads, { 'acme/app#7': { sessionId: 's1', boxId: 'b1' } })
  assert.deepEqual([again.grants, again.paused, again.forks], [s.grants, s.paused, s.forks])
  assert.equal(statSync(file).mode & 0o777, 0o600)
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
