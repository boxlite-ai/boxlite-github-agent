import assert from 'node:assert/strict'
import { test } from 'node:test'
import http from 'node:http'
import { spawn, execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createProxy } from '../src/proxy.mjs'
import { jobTokens } from '../src/chatgpt.mjs'
import { codexArgs, applyEvent, newRun, CODEX_VERSION } from '../src/codex.mjs'

// The whole model path with the REAL Codex CLI: box runner → codex (stand-in ChatGPT login) →
// our proxy (job token) → a fake chatgpt.com that streams one answer. Opt-in (BOTLITE_E2E=1):
// it needs the pinned Codex installed, and guards exactly what a Codex upgrade could break.
let codexVersion = ''
try {
  codexVersion = execFileSync('codex', ['--version'], { encoding: 'utf8' })
} catch {
  /* not installed */
}
const skip = !process.env.BOTLITE_E2E ? 'set BOTLITE_E2E=1 to run' : !codexVersion.includes(CODEX_VERSION) ? `needs codex ${CODEX_VERSION}` : false

test('e2e: a real Codex turn — then a resume — goes through the proxy on the job token, the real login is swapped in', { skip, timeout: 300_000 }, async () => {
  const seen = []
  const sse = (e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`
  const upstream = http.createServer(async (req, res) => {
    let body = ''
    for await (const c of req) body += c
    seen.push({ method: req.method, url: req.url, auth: req.headers.authorization, account: req.headers['chatgpt-account-id'], body: req.method === 'POST' ? JSON.parse(body) : null })
    if (req.url.startsWith('/backend-api/codex/models')) return res.writeHead(404).end()
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.write(sse({ type: 'response.created', response: { id: 'resp_1' } }))
    res.write(sse({ type: 'response.output_item.done', item: { type: 'message', role: 'assistant', id: 'msg_1', content: [{ type: 'output_text', text: 'Hello from the fake backend.' }] } }))
    res.end(sse({ type: 'response.completed', response: { id: 'resp_1', usage: { input_tokens: 1, input_tokens_details: { cached_tokens: 0 }, output_tokens: 1, output_tokens_details: { reasoning_tokens: 0 }, total_tokens: 2 } } }))
  })
  await new Promise((r) => upstream.listen(0, '127.0.0.1', r))
  const secret = Buffer.from('e2e-secret')
  const jobs = jobTokens(secret)
  const login = { get: () => ({ access_token: 'REAL-ACCESS-TOKEN', account_id: 'acct-real' }), refresh: async () => {} }
  const proxy = createProxy({ login, secret, jobs, upstream: `http://127.0.0.1:${upstream.address().port}` })
  await new Promise((r) => proxy.listen(0, '127.0.0.1', r))

  const ctx = mkdtempSync(path.join(tmpdir(), 'e2e-'))
  mkdirSync(path.join(ctx, 'repo'))
  execFileSync('git', ['init', '-q', path.join(ctx, 'repo')])
  const token = jobs.issue(12 * 3_600_000, 'acme/app#7')
  const base = { cwd: path.join(ctx, 'repo'), outFile: path.join(ctx, 'last-message.md'), proxyUrl: `http://127.0.0.1:${proxy.address().port}`, model: 'gpt-6-astra', effort: 'xhigh' }
  const turn = (args, prompt) =>
    new Promise((resolve) => {
      const child = spawn(process.execPath, [path.resolve('box/session.mjs')], {
        env: { PATH: process.env.PATH, CTX: ctx, CONTEXT_KEY: Buffer.alloc(32).toString('base64'), REPO: 'acme/app', NUMBER: '7', IS_PR: '0', CODEX_VERSION, BOTLITE_ARGS: JSON.stringify(args), BOTLITE_JOB_TOKEN: token },
      })
      let stdout = ''
      child.stdout.on('data', (d) => (stdout += d))
      child.on('close', () => resolve({ run: stdout.split('\n').reduce(applyEvent, newRun()), result: JSON.parse(stdout.trim().split('\n').at(-1)) }))
      child.stdin.end(prompt)
    })
  try {
    const first = await turn(codexArgs(base), 'Say hello.')
    assert.equal(first.result.code, 0)
    assert.equal(first.run.completed, true)
    assert.equal(first.result.lastMessage, 'Hello from the fake backend.')
    assert.ok(first.run.sessionId)

    const second = await turn(codexArgs({ ...base, sessionId: first.run.sessionId }), 'Say hello again.') // `exec resume`
    assert.equal(second.result.code, 0, JSON.stringify(second.result))
    assert.equal(second.run.completed, true)
    assert.equal(second.run.sessionId, first.run.sessionId)

    const turns = seen.filter((s) => s.method === 'POST' && s.url === '/backend-api/codex/responses')
    assert.ok(turns.length >= 2)
    for (const t of turns) {
      assert.equal(t.body.model, 'gpt-6-astra') // -m
      assert.equal(t.body.reasoning?.effort, 'xhigh') // model_reasoning_effort
    }
    for (const s of seen) {
      assert.match(s.url, /^\/backend-api\/codex\/(responses|models)/) // nothing else got through
      assert.equal(s.auth, 'Bearer REAL-ACCESS-TOKEN')
      assert.equal(s.account, 'acct-real')
    }
  } finally {
    jobs.revoke(token)
    proxy.close()
    upstream.close()
    rmSync(ctx, { recursive: true, force: true })
  }
})
