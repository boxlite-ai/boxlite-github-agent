import assert from 'node:assert/strict'
import { test } from 'node:test'
import { split, reply, say, whisper, react } from '../src/slack-reply.mjs'

function fakeSlack(fail = {}) {
  const calls = []
  return {
    calls,
    call: async (method, params) => {
      calls.push({ method, ...params })
      if (fail[method]) {
        const e = new Error(`slack ${method}: ${fail[method]}`)
        e.code = fail[method]
        throw e
      }
      return { ok: true }
    },
  }
}
const req = { channel: 'C1', ts: '2.000002', threadTs: '1.000001', user: 'U1', isDM: false }

test('split: short text is one part; long text breaks between paragraphs; no part is over the limit', () => {
  assert.deepEqual(split('hello', 100), ['hello'])
  const paras = Array.from({ length: 10 }, (_, i) => `paragraph ${i} `.repeat(4).trim())
  const parts = split(paras.join('\n\n'), 200)
  assert.ok(parts.length > 1)
  for (const p of parts) assert.ok(p.length <= 200, p.length)
  assert.equal(parts.join('\n\n'), paras.join('\n\n')) // cut only at blank lines
})

test('split: a code block the cut falls in is closed, then reopened with its language', () => {
  const code = Array.from({ length: 40 }, (_, i) => `console.log(${i})`).join('\n')
  const parts = split(`Run this:\n\n\`\`\`js\n${code}\n\`\`\`\n\nDone.`, 300)
  assert.ok(parts.length > 2)
  for (const p of parts) {
    assert.ok(p.length <= 300, p.length)
    const fences = p.split('\n').filter((l) => l.startsWith('```')).length
    assert.equal(fences % 2, 0, `balanced fences in:\n${p}`)
  }
  assert.match(parts[1], /^```js\n/)
  assert.match(parts.at(-1), /Done\.$/)
})

test('split: one enormous line is cut anyway, never inside an emoji', () => {
  const parts = split('😀'.repeat(150), 101)
  for (const p of parts) {
    assert.ok(p.length <= 101)
    assert.doesNotMatch(p, /^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/) // no half surrogate pairs at the edges
  }
  assert.equal(parts.join(''), '😀'.repeat(150))
})

test('reply: markdown blocks in the request’s thread, the footer under the last part only', async () => {
  const sk = fakeSlack()
  await reply(sk, req, `${'a'.repeat(11_000)}\n\n${'b'.repeat(2_000)}`)
  assert.equal(sk.calls.length, 2)
  for (const c of sk.calls) {
    assert.deepEqual([c.method, c.channel, c.thread_ts, c.unfurl_links], ['chat.postEphemeral', 'C1', '1.000001', false])
    assert.equal(c.user, 'U1')
    assert.equal(c.blocks[0].type, 'markdown')
    assert.ok(c.text.length <= 300) // notification text
  }
  assert.equal(sk.calls[0].blocks.length, 1)
  assert.equal(sk.calls[1].blocks[1].type, 'context')
  assert.match(sk.calls[1].blocks[1].elements[0].text, /BoxLite.*mention me in this thread/)
  const dm = fakeSlack()
  await reply(dm, { ...req, isDM: true }, '')
  assert.equal(dm.calls[0].method, 'chat.postMessage')
  assert.equal(dm.calls[0].blocks[0].text, '(no answer)')
  assert.match(dm.calls[0].blocks[1].elements[0].text, /reply in this thread/)
  const top = fakeSlack()
  await reply(top, { ...req, threadTs: req.ts }, 'Private top-level answer')
  assert.equal(top.calls[0].method, 'chat.postEphemeral')
  assert.equal(top.calls[0].thread_ts, undefined)
  const failed = fakeSlack({ 'chat.postEphemeral': 'user_not_in_channel' })
  await assert.rejects(reply(failed, req, 'private data'), /user_not_in_channel/)
  assert.equal(failed.calls.some((c) => c.method === 'chat.postMessage'), false)
})

test('reply: an overlong answer is cut — closing a code block it was in — and says so', async () => {
  const sk = fakeSlack()
  await reply(sk, req, `\`\`\`\n${'x\n'.repeat(30_000)}`)
  assert.ok(sk.calls.length <= 4)
  const last = sk.calls.at(-1).blocks[0].text
  assert.match(last, /```\n\n…\(truncated\)$/)
})

test('say, whisper and react', async () => {
  const sk = fakeSlack({ 'reactions.add': 'already_reacted' })
  await say(sk, req, 'hello <@U1>')
  assert.deepEqual(sk.calls[0], { method: 'chat.postMessage', channel: 'C1', thread_ts: '1.000001', text: 'hello <@U1>', unfurl_links: false })
  await whisper(sk, req, 'only you')
  assert.deepEqual(sk.calls[1], { method: 'chat.postEphemeral', channel: 'C1', user: 'U1', text: 'only you', thread_ts: '1.000001' })
  await whisper(sk, { ...req, threadTs: req.ts }, 'top level') // no thread yet: an ephemeral there would never show
  assert.equal(sk.calls[2].thread_ts, undefined)
  await react(sk, req) // 👀 already there is fine
  assert.deepEqual(sk.calls[3], { method: 'reactions.add', channel: 'C1', timestamp: '2.000002', name: 'eyes' })
  await assert.rejects(react(fakeSlack({ 'reactions.add': 'missing_scope' }), req), /missing_scope/)
})

test('reply: the changes the controller recorded go above the footer, tallied', async () => {
  const sk = fakeSlack()
  await reply(sk, req, 'Done.', { changes: ['Linear save_comment', 'Linear save_comment', 'Notion notion-update-page'] })
  const [changes, foot] = sk.calls[0].blocks[1].elements
  assert.equal(changes.text, '✏️ Changed as the bot: Linear save_comment ×2 · Notion notion-update-page')
  assert.match(foot.text, /BoxLite/)
  const none = fakeSlack()
  await reply(none, req, 'Read only.')
  assert.equal(none.calls[0].blocks[1].elements.length, 1)
})
