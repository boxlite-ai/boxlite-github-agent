import assert from 'node:assert/strict'
import { test } from 'node:test'
import { slack } from '../src/slack.mjs'

const json = (status, body, headers = {}) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } })

test('call: form-encoded POST, token only in the header, non-strings as JSON; ok:false throws with the code', async () => {
  const calls = []
  const fetchImpl = async (url, init) => {
    calls.push({ url, init, form: Object.fromEntries(new URLSearchParams(init.body)) })
    return calls.length === 1 ? json(200, { ok: true, ts: '1.2' }) : json(200, { ok: false, error: 'channel_not_found' })
  }
  const sk = slack('xoxb-test', { fetchImpl })
  const blocks = [{ type: 'markdown', text: '**hi**' }]
  assert.deepEqual(await sk.call('chat.postMessage', { channel: 'C1', blocks, unfurl_links: false, thread_ts: undefined }), { ok: true, ts: '1.2' })
  assert.equal(calls[0].url, 'https://slack.com/api/chat.postMessage')
  assert.equal(calls[0].init.method, 'POST')
  assert.equal(calls[0].init.headers.Authorization, 'Bearer xoxb-test')
  assert.match(calls[0].init.headers['Content-Type'], /^application\/x-www-form-urlencoded/)
  assert.deepEqual(calls[0].form, { channel: 'C1', blocks: JSON.stringify(blocks), unfurl_links: 'false' }) // undefined left out
  assert.ok(!calls[0].init.body.includes('xoxb-test'))
  const err = await sk.call('chat.postMessage', { channel: 'nope' }).catch((e) => e)
  assert.equal(err.code, 'channel_not_found')
  assert.match(err.message, /^slack chat\.postMessage: channel_not_found$/)
})

test('call: a 429 waits Retry-After and tries again; a long wait or a third 429 fails; HTTP errors fail', async () => {
  const waits = []
  let n = 0
  const flaky = slack('t', { fetchImpl: async () => (++n === 1 ? json(429, {}, { 'retry-after': '2' }) : json(200, { ok: true })), sleep: async (ms) => waits.push(ms) })
  assert.deepEqual(await flaky.call('reactions.add'), { ok: true })
  assert.deepEqual(waits, [2000])

  const always = slack('t', { fetchImpl: async () => json(429, {}, { 'retry-after': '1' }), sleep: async () => {} })
  assert.equal((await always.call('x').catch((e) => e)).code, 'ratelimited')
  const long = slack('t', { fetchImpl: async () => json(429, {}, { 'retry-after': '600' }), sleep: async () => assert.fail('must not wait 10 min') })
  assert.match((await long.call('conversations.replies').catch((e) => e)).message, /ratelimited \(retry after 600s\)/)
  const down = slack('t', { fetchImpl: async () => new Response('bad gateway', { status: 502 }) })
  assert.equal((await down.call('x').catch((e) => e)).code, 'http_502')
})

test('download: bytes from files.slack.com with the bot token — and nowhere else', async () => {
  const seen = []
  const sk = slack('xoxb-test', {
    fetchImpl: async (url, init) => {
      seen.push({ url: String(url), auth: init.headers.Authorization })
      return new Response(Buffer.from('log line\n'), { headers: { 'content-type': 'text/plain' } })
    },
  })
  const data = await sk.download('https://files.slack.com/files-pri/T1-F1/download/ci.log', { maxBytes: 100, mimetype: 'text/plain' })
  assert.equal(data.toString(), 'log line\n')
  assert.deepEqual(seen, [{ url: 'https://files.slack.com/files-pri/T1-F1/download/ci.log', auth: 'Bearer xoxb-test' }])
  for (const url of ['https://evil.example/files-pri/x', 'http://files.slack.com/x', 'https://files.slack.com.evil.example/x']) {
    await assert.rejects(sk.download(url, { maxBytes: 100 }), /not a Slack file URL/, url)
  }
  assert.equal(seen.length, 1)
})

test('download: Slack’s sign-in page instead of the file, a file over the limit, an HTTP error → errors', async () => {
  const page = slack('t', { fetchImpl: async () => new Response('<!DOCTYPE html><title>Slack</title>', { headers: { 'content-type': 'text/html; charset=utf-8' } }) })
  await assert.rejects(page.download('https://files.slack.com/f', { maxBytes: 1e6, mimetype: 'text/plain' }), /files:read/)
  assert.equal((await page.download('https://files.slack.com/f', { maxBytes: 1e6, mimetype: 'text/html' })).length, 35) // an actual HTML file is fine
  const big = slack('t', { fetchImpl: async () => new Response(Buffer.alloc(2048)) })
  await assert.rejects(big.download('https://files.slack.com/f', { maxBytes: 1024 }), /larger than 1024 bytes/)
  const gone = slack('t', { fetchImpl: async () => new Response('', { status: 404 }) })
  await assert.rejects(gone.download('https://files.slack.com/f', { maxBytes: 1024 }), /HTTP 404/)
})
