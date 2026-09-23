import assert from 'node:assert/strict'
import { test } from 'node:test'
import { slackChannel } from '../src/slack-channel.mjs'
import { scheduler } from '../src/jobs.mjs'

function deferred() {
  let resolve
  const promise = new Promise((r) => { resolve = r })
  return { promise, resolve }
}

test('channel requests isolate credentials, context, replies and queues per person', { timeout: 5000 }, async (t) => {
  const calls = [], records = [], work = []
  const first = deferred(), second = deferred(), release = deferred()
  let failure = false
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    const method = new URL(url).pathname.split('/').pop()
    const params = Object.fromEntries(new URLSearchParams(init.body))
    calls.push({ method, params })
    const data = method === 'auth.test' ? { user_id: 'UBOT', team_id: 'T1', user: 'boxliteai', team: 'Example', url: 'https://example.slack.com' }
      : method === 'users.info' ? { user: { id: params.user, team_id: 'T1', name: params.user } }
        : method === 'apps.connections.open' ? { url: 'wss://slack.example' }
          : method === 'conversations.replies' ? { messages: [
            { user: 'U1', ts: '1.000001', text: 'Alice context' },
            { user: 'U2', ts: '1.000002', text: 'Bob context' },
            { user: 'UBOT', ts: '1.000003', text: 'legacy shared answer' },
          ] } : {}
    return Response.json({ ok: true, ...data })
  })
  const opened = deferred()
  const original = globalThis.WebSocket
  globalThis.WebSocket = class {
    constructor() { queueMicrotask(() => opened.resolve(this)) }
    send() {}
    close() { this.onclose?.() }
  }
  const jobs = {
    issue: (_, key, job) => { records.push({ key, job }); return String(records.length - 1) },
    revoke() {},
  }
  const bl = {
    getBox: async () => null,
    createBox: async (spec) => ({ id: spec.name, status: 'running' }),
    stopBox: async () => {},
    startExec: async (box, exec) => {
      const id = Number(exec.env.BOTLITE_JOB_TOKEN)
      Object.assign(records[id], { box, exec })
      return { execution_id: id }
    },
    attach: async (_, id, { stdin, onStdout }) => {
      const record = records[id]
      record.input = JSON.parse(stdin)
      if (id === 0) first.resolve()
      if (id === 1) second.resolve()
      await release.promise
      const owner = record.job.logins.linear?.owner
      const answer = record.job.tools.length ? `private-${owner}` : 'Please /link linear'
      if (failure) record.job.writes.push('linear save_comment')
      onStdout(JSON.stringify({ type: 'thread.started', thread_id: `session-${id}` }) + '\n')
      onStdout(JSON.stringify({ type: 'botlite.result', code: failure ? 1 : 0, lastMessage: failure ? '' : answer }) + '\n')
    },
  }
  const state = { seen: new Set(), deferred: [], usage: {}, threads: {
    'T1/C1/1.000001': { sessionId: 'legacy-shared', lastTs: '1.000003' },
  } }
  const cfg = { boxDeleteSec: 900, maxFilesBytes: 1024 }
  const channel = await slackChannel({
    tokens: { bot: 'test', app: 'test' }, cfg, slackState: state, bl, jobs,
    persist() {}, draining: () => false, log() {}, status() {},
    schedule: scheduler(2), track: (promise) => work.push(promise),
    turnCfg: () => ({ ...cfg, volume: 'github', slackVolume: 'slack', contextSecret: 'github-key', slackContextSecret: 'slack-key', jobTimeoutMs: 1000 }),
    proxyUrl: 'https://controller.example', prs: { status: async () => ({ ok: false, why: 'off' }) },
    policy: { linear: { read: ['get_issue'], write: [] } },
    userLogins: { kinds: { linear: 'key' }, forUser: async (user) => ({ linear: { owner: user, ready: () => user !== 'U3', token: async () => `token-${user}` } }) },
  })
  t.after(async () => { release.resolve(); await Promise.all(work); channel.stop(); globalThis.WebSocket = original })
  channel.start()
  const ws = await opened.promise
  let number = 2
  const message = async (user) => {
    const ts = `${number++}.000001`
    ws.onmessage({ data: JSON.stringify({ type: 'events_api', envelope_id: ts, payload: { team_id: 'T1', event: {
      type: 'app_mention', channel_type: 'channel', channel: 'C1', user, ts, thread_ts: '1.000001', text: '<@UBOT> look up my Linear issue',
    } } }) })
    await Promise.resolve()
    await channel.settle()
  }
  await message('U1')
  await first.promise
  assert.deepEqual(records[0].job.tools, ['linear'])
  await message('U1')
  await message('U2')
  await message('U3')
  await second.promise
  assert.equal(records.length, 2) // the second Alice turn waits; Bob can use the other slot
  assert.equal(records[0].job.logins.linear.owner, 'U1')
  assert.equal(records[1].job.logins.linear.owner, 'U2')
  assert.notEqual(records[0].key, records[1].key)
  for (const field of ['SNAPSHOT', 'CONTEXT_KEY']) assert.notEqual(records[0].exec.env[field], records[1].exec.env[field])
  assert.notEqual(records[0].box, records[1].box)
  assert.doesNotMatch(records[0].exec.env.BOTLITE_ARGS, /legacy-shared/)
  assert.doesNotMatch(records[0].input.prompt, /Bob context|legacy shared answer/)
  assert.doesNotMatch(records[1].input.prompt, /Alice context|legacy shared answer/)
  release.resolve()
  await Promise.all(work)
  const alice = records.filter((r) => r.job.logins.linear.owner === 'U1')
  assert.equal(alice[0].key, alice[1].key)
  assert.match(alice[1].exec.env.BOTLITE_ARGS, /session-0/)
  const unlinked = records.find((r) => r.job.logins.linear.owner === 'U3')
  assert.deepEqual(unlinked.job.tools, [])
  failure = true
  await message('U1')
  await Promise.all(work)
  const replies = calls.filter((c) => c.method.startsWith('chat.post'))
  assert.equal(replies.length, 5)
  assert.ok(replies.every((c) => c.method === 'chat.postEphemeral'))
  for (const reply of replies) {
    const body = JSON.stringify(reply.params)
    if (body.includes('private-U1')) assert.equal(reply.params.user, 'U1')
    if (body.includes('private-U2')) assert.equal(reply.params.user, 'U2')
    if (body.includes('Please /link linear')) assert.equal(reply.params.user, 'U3')
  }
  assert.match(replies.at(-1).params.text, /make changes before it stopped/)
  assert.equal(replies.at(-1).params.user, 'U1')
})
