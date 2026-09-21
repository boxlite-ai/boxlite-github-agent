import assert from 'node:assert/strict'
import { test } from 'node:test'
import { codexArgs, applyEvent, newRun, newSessionPrompt, followUpPrompt } from '../src/codex.mjs'

const base = { cwd: '/ctx/repo', outFile: '/ctx/last.md', proxyUrl: 'https://8788-d-abc.proxy.boxlite.ai/' }

test('codexArgs: a new session runs in the checkout; a resume names the session; prompt on stdin', () => {
  const fresh = codexArgs(base)
  assert.deepEqual(fresh.slice(0, 5), ['exec', '--json', '-o', '/ctx/last.md', '--skip-git-repo-check'])
  assert.deepEqual(fresh.slice(-3), ['-C', '/ctx/repo', '-'])
  assert.ok(fresh.includes('--dangerously-bypass-approvals-and-sandbox'))
  // ChatGPT-mode auth, but every backend call goes to the controller, never to chatgpt.com
  assert.ok(fresh.includes('model_providers.botlite={ name = "botlite", base_url = "https://8788-d-abc.proxy.boxlite.ai/backend-api/codex", wire_api = "responses", requires_openai_auth = true }'))
  assert.ok(fresh.includes('chatgpt_base_url="https://8788-d-abc.proxy.boxlite.ai/backend-api/"'))
  assert.ok(fresh.includes('cli_auth_credentials_store="file"'))

  const resumed = codexArgs({ ...base, sessionId: '01a0c45b-edb0', model: 'gpt-5.6-sol' })
  assert.deepEqual(resumed.slice(0, 2), ['exec', 'resume'])
  assert.deepEqual(resumed.slice(-4), ['-m', 'gpt-5.6-sol', '01a0c45b-edb0', '-'])
  assert.equal(resumed.includes('-C'), false) // `exec resume` has no --cd; the box runs it in the checkout
})

test('codexArgs: needs a proxy url, and refuses one that could break out of the TOML string', () => {
  assert.throws(() => codexArgs({ ...base, proxyUrl: 'http://x" , base_url = "http://evil' }), /bad proxy url/)
  assert.throws(() => codexArgs({ ...base, proxyUrl: undefined }), /bad proxy url/)
})

const run = (lines) => lines.map((l) => JSON.stringify(l)).reduce(applyEvent, newRun())

test('applyEvent: the failed probe run — session id kept, turn failure reported', () => {
  const r = run([
    { type: 'thread.started', thread_id: '01a0c45b-edb0' },
    { type: 'item.completed', item: { id: 'item_0', type: 'error', message: 'Skill descriptions were shortened' } },
    { type: 'turn.started' },
    { type: 'error', message: 'probe: stop here' },
    { type: 'turn.failed', error: { message: 'probe: stop here' } },
  ])
  assert.equal(r.sessionId, '01a0c45b-edb0')
  assert.equal(r.completed, false)
  assert.equal(r.error, 'probe: stop here')
})

test('applyEvent: a completed turn succeeds despite earlier non-fatal errors; last message wins', () => {
  const r = run([
    { type: 'thread.started', thread_id: 's1' },
    { type: 'error', message: 'stream disconnected, retrying 1/5' },
    { type: 'item.completed', item: { type: 'agent_message', text: 'draft' } },
    { type: 'item.completed', item: { type: 'agent_message', text: 'final answer' } },
    { type: 'turn.completed', usage: { input_tokens: 10, output_tokens: 2 } },
  ])
  assert.equal(r.completed, true)
  assert.equal(r.error, null)
  assert.equal(r.message, 'final answer')
  assert.deepEqual(r.usage, { input_tokens: 10, output_tokens: 2 })
  assert.deepEqual(['not json', ''].reduce(applyEvent, newRun()), newRun())
})

const req = {
  id: 'rc:20', kind: 'review_comment', commentId: 20, path: 'src/a.js', line: 42, author: 'dave', repo: 'acme/app', number: 7, isPR: true,
  url: 'https://github.com/acme/app/pull/7#r20', body: '@botlite is this line safe?',
  thread: { title: 'Fix it', body: 'Fixes the crash', url: 'https://github.com/acme/app/pull/7', author: 'alice', state: 'open' },
}
const pr = { headSha: 'abcdef1234567', baseRef: 'main' }

test('newSessionPrompt: identity, sandbox, fenced thread, request, reply contract', () => {
  const p = newSessionPrompt({
    login: 'botlite',
    req,
    pr,
    comments: [{ id: 20, body: 'the request itself', user: { login: 'dave' } }, { id: 9, body: 'x'.repeat(5000), user: { login: 'carol' } }],
  })
  assert.match(p, /You are @botlite/)
  assert.match(p, /git diff origin\/main\.\.\.HEAD/)
  assert.match(p, /<github>\nPull request acme\/app#7 "Fix it" by @alice \(open\)/)
  assert.match(p, /Request from @dave on `src\/a\.js` line 42 — https:\/\/github\.com\/acme\/app\/pull\/7#r20:\n\n@botlite is this line safe\?\n<\/github>/)
  assert.doesNotMatch(p, /the request itself/) // not repeated as history
  assert.match(p, /@carol: x{1500}\n…\(truncated\)/)
  assert.match(p, /addressed to @dave/)
})

test('followUpPrompt: only the new request, and a note when the PR head moved', () => {
  assert.doesNotMatch(followUpPrompt({ login: 'botlite', req, headMoved: false, pr }), /new commits/)
  const moved = followUpPrompt({ login: 'botlite', req, headMoved: true, pr })
  assert.match(moved, /new commits since your last reply — the checkout now points at abcdef1/)
  assert.match(moved, /Request from @dave/)
})
