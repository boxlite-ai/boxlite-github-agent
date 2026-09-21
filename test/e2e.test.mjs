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

test('e2e: a real Codex turn goes through the proxy on the job token, the real login is swapped in', { skip, timeout: 180_000 }, async () => {
  const seen = []
  const sse = (e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`
  const upstream = http.createServer(async (req, res) => {
    for await (const _ of req);
    seen.push({ method: req.method, url: req.url, auth: req.headers.authorization, account: req.headers['chatgpt-account-id'] })
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
  const args = codexArgs({ cwd: path.join(ctx, 'repo'), outFile: path.join(ctx, 'last-message.md'), proxyUrl: `http://127.0.0.1:${proxy.address().port}` })
  try {
    const out = await new Promise((resolve) => {
      const child = spawn(process.execPath, [path.resolve('box/session.mjs')], {
        env: { PATH: process.env.PATH, CTX: ctx, CONTEXT_KEY: Buffer.alloc(32).toString('base64'), REPO: 'acme/app', NUMBER: '7', IS_PR: '0', CODEX_VERSION, BOTLITE_ARGS: JSON.stringify(args), BOTLITE_JOB_TOKEN: token },
      })
      let stdout = ''
      child.stdout.on('data', (d) => (stdout += d))
      child.on('close', () => resolve(stdout))
      child.stdin.end('Say hello.')
    })
    const run = out.split('\n').reduce(applyEvent, newRun())
    const result = JSON.parse(out.trim().split('\n').at(-1))
    assert.equal(result.code, 0)
    assert.equal(run.completed, true)
    assert.equal(result.lastMessage, 'Hello from the fake backend.')
    assert.ok(seen.some((s) => s.method === 'POST' && s.url === '/backend-api/codex/responses'))
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
