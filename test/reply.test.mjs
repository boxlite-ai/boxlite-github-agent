import assert from 'node:assert/strict'
import { test } from 'node:test'
import { reply } from '../src/reply.mjs'

// A fake GitHub whose comment POSTs fail as told: `created` says whether the failed one was stored
// anyway, as GitHub did live (a 500, then the comment was there).
function fakeGithub(failures) {
  const comments = []
  const calls = []
  const gh = {
    json: async (method, path, opts) => {
      calls.push(`${method} ${path.split('?')[0]}`)
      if (method === 'GET') return comments
      const failure = failures.shift()
      if (failure?.created) comments.push({ id: comments.length + 1, body: opts.body.body })
      if (failure) throw Object.assign(new Error(`POST ${path}: ${failure.status}`), { status: failure.status })
      const c = { id: comments.length + 1, body: opts.body.body }
      comments.push(c)
      return c
    },
  }
  return { gh, comments, calls }
}
const review = { kind: 'review_comment', repo: 'acme/app', number: 7, commentId: 42 }

test('reply: a 5xx for a comment GitHub did create is not posted twice', async () => {
  const { gh, comments, calls } = fakeGithub([{ status: 500, created: true }])
  const c = await reply(gh, review, 'the answer', { retryDelayMs: 0 })
  assert.equal(c.body, comments[0].body)
  assert.equal(comments.length, 1)
  assert.deepEqual(calls, ['POST /repos/acme/app/pulls/7/comments/42/replies', 'GET /repos/acme/app/pulls/7/comments'])
})

test('reply: a 5xx for a comment that isn’t there is posted once more; a 4xx is not retried', async () => {
  const lost = fakeGithub([{ status: 502, created: false }])
  await reply(lost.gh, { kind: 'comment', repo: 'acme/app', number: 7 }, 'the answer', { retryDelayMs: 0 })
  assert.equal(lost.comments.length, 1)
  assert.deepEqual(lost.calls, ['POST /repos/acme/app/issues/7/comments', 'GET /repos/acme/app/issues/7/comments', 'POST /repos/acme/app/issues/7/comments'])

  const refused = fakeGithub([{ status: 422, created: false }])
  await assert.rejects(reply(refused.gh, review, 'x', { retryDelayMs: 0 }), /422/)
  assert.equal(refused.calls.length, 1)
})
