import assert from 'node:assert/strict'
import { test } from 'node:test'
import { MARKER, MAX_BODY_CHARS, clampBody, upsertComment } from '../lib/comment.mjs'

// A fake GitHub API: records every call and replies from a scripted queue so the upsert
// branch (PATCH existing vs POST new) and truncation are exercised without the network.
function fakeFetch(responses) {
  const calls = []
  const queue = [...responses]
  const impl = async (url, init = {}) => {
    calls.push({ url, method: init.method ?? 'GET', body: init.body })
    const next = queue.shift() ?? { ok: true, json: {} }
    return {
      ok: next.ok,
      status: next.status ?? (next.ok ? 200 : 500),
      json: async () => next.json ?? {},
      text: async () => next.text ?? '',
    }
  }
  return { impl, calls }
}

test('clampBody truncates only past the limit, with a visible marker', () => {
  const short = 'x'.repeat(100)
  assert.equal(clampBody(short), short)

  const long = 'y'.repeat(MAX_BODY_CHARS + 500)
  const clamped = clampBody(long)
  assert.ok(clamped.length < long.length)
  assert.ok(clamped.endsWith('…(truncated)'))
  assert.ok(clamped.startsWith('y'.repeat(MAX_BODY_CHARS)))
})

test('PATCHes the existing marked comment (sticky reuse)', async () => {
  const { impl, calls } = fakeFetch([
    { ok: true, json: [{ id: 111, body: 'unrelated' }, { id: 222, body: `${MARKER}\nold review` }] },
    { ok: true, json: {} },
  ])
  const result = await upsertComment({ repo: 'acme/app', pr: '7', body: `${MARKER}\nnew`, token: 't', fetchImpl: impl })

  assert.deepEqual(result, { action: 'updated', id: 222 })
  assert.equal(calls[1].method, 'PATCH')
  assert.ok(calls[1].url.endsWith('/repos/acme/app/issues/comments/222'))
})

test('adopts a pre-rename sticky (legacy marker) instead of posting a duplicate', async () => {
  const { impl, calls } = fakeFetch([
    { ok: true, json: [{ id: 444, body: '<!-- boxlite-pr-review -->\nold review' }] },
    { ok: true, json: {} },
  ])
  const result = await upsertComment({ repo: 'acme/app', pr: '7', body: `${MARKER}\nnew`, token: 't', fetchImpl: impl })

  assert.deepEqual(result, { action: 'updated', id: 444 })
  assert.equal(calls[1].method, 'PATCH')
  assert.ok(JSON.parse(calls[1].body).body.startsWith(MARKER)) // re-marked with the new marker
})

test('POSTs a new comment when no marked comment exists', async () => {
  const { impl, calls } = fakeFetch([
    { ok: true, json: [{ id: 111, body: 'someone else' }] },
    { ok: true, json: { id: 333 } },
  ])
  const result = await upsertComment({ repo: 'acme/app', pr: '7', body: `${MARKER}\nfirst`, token: 't', fetchImpl: impl })

  assert.deepEqual(result, { action: 'created', id: 333 })
  assert.equal(calls[1].method, 'POST')
  assert.ok(calls[1].url.endsWith('/repos/acme/app/issues/7/comments'))
})

test('a long body is truncated in the request sent to GitHub', async () => {
  const { impl, calls } = fakeFetch([
    { ok: true, json: [] },
    { ok: true, json: { id: 1 } },
  ])
  await upsertComment({ repo: 'a/b', pr: '1', body: `${MARKER}\n` + 'z'.repeat(MAX_BODY_CHARS + 1000), token: 't', fetchImpl: impl })

  const sent = JSON.parse(calls[1].body).body
  assert.ok(sent.length <= MAX_BODY_CHARS + '\n\n…(truncated)'.length)
  assert.ok(sent.endsWith('…(truncated)'))
})

test('a non-ok GitHub response throws with method, path and status', async () => {
  const { impl } = fakeFetch([{ ok: false, status: 403, text: 'forbidden' }])
  await assert.rejects(
    upsertComment({ repo: 'a/b', pr: '1', body: 'x', token: 't', fetchImpl: impl }),
    /GET .*comments.*: 403 forbidden/,
  )
})
