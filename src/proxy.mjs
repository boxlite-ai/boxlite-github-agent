// The controller's public door for session boxes: the model endpoints of the bot's ChatGPT login,
// plus a write turn's one git push (gitpush.mjs; a Slack turn asks for it at /pr, prgrant.mjs)
// and, for a turn that has them, the team's tools at /mcp/<service> (tools.mjs). A box's Codex
// presents its job token (chatgpt.mjs); the proxy verifies it, swaps in the real access token +
// account id, and streams the answer back. Every other ChatGPT backend path Codex tries —
// plugins, MCP, analytics, settings — gets a 404:
// forwarding those with the real token would let any request read the account's ChatGPT data.
// (A 404, never a 401: a 401 sends Codex into its own token refresh, which can't work in a box
// and fails the turn.)
import http from 'node:http'
import { verifyJobToken } from './chatgpt.mjs'

const ALLOWED = [
  ['POST', /^\/backend-api\/codex\/responses(\/[\w-]+)?(\?.*)?$/], // the turn (+ remote compaction)
  ['GET', /^\/backend-api\/codex\/models(\?.*)?$/], // model catalog
]
const DROP_REQ = new Set(['host', 'connection', 'keep-alive', 'content-length', 'transfer-encoding', 'authorization', 'chatgpt-account-id', 'accept-encoding'])
// fetch has already decoded the upstream body, so its encoding/length headers no longer apply.
const DROP_RES = new Set(['content-encoding', 'content-length', 'transfer-encoding', 'connection', 'keep-alive'])

export function createProxy({ login, secret, jobs, upstream = 'https://chatgpt.com', model, maxRequestsPerJob = 400, fetchImpl = fetch, log = () => {}, webhook, git, pr, tools, linking, health = () => ({ ok: true }) }) {
  return http.createServer(async (req, res) => {
    if (req.url === '/healthz') {
      const h = health()
      return send(res, h.ok ? 200 : 503, h.ok ? 'ok' : h.why)
    }
    if (webhook && req.method === 'POST' && req.url === '/webhook') return webhook(req, res) // GitHub App deliveries (webhook.mjs)
    if (git && req.url.startsWith('/git/')) return git(req, res) // a write turn's one push (gitpush.mjs)
    if (pr && req.url === '/pr') return pr(req, res) // a Slack turn asking for its PR's push (prgrant.mjs)
    if (tools && req.url.startsWith('/mcp/')) return tools(req, res) // Linear, Notion, Google Workspace (tools.mjs)
    if (linking && req.url.startsWith('/link/')) return linking(req, res)
    if (!ALLOWED.some(([m, re]) => m === req.method && re.test(req.url))) return send(res, 404, 'not available through this proxy')
    const claims = verifyJobToken(secret, /^Bearer (\S+)$/.exec(req.headers.authorization || '')?.[1])
    const job = claims && jobs.live.get(claims.jti)
    if (!job) return send(res, 403, 'unknown or expired job token')
    if (++job.requests > maxRequestsPerJob) return send(res, 429, 'this job used up its model request budget')

    const abort = new AbortController()
    res.on('close', () => abort.abort()) // the box hung up → stop the upstream stream
    try {
      let body = req.method === 'POST' ? await readAll(req) : undefined
      const pinned = typeof model === 'function' ? model() : model // an admin's /model applies from the next request
      if (body && pinned) body = pinModel(body, pinned)
      const headers = Object.fromEntries(Object.entries(req.headers).filter(([k]) => !DROP_REQ.has(k)))
      const forward = () => {
        const t = login.get()
        return fetchImpl(upstream + req.url, {
          method: req.method,
          headers: { ...headers, authorization: `Bearer ${t.access_token}`, 'chatgpt-account-id': t.account_id },
          body,
          signal: abort.signal,
        })
      }
      let up = await forward()
      if (up.status === 401) {
        await up.body?.cancel()
        log(`ChatGPT rejected the access token (${claims.thread}); refreshing`)
        await login.refresh()
        up = await forward()
      }
      if (up.status === 401) {
        await up.body?.cancel()
        return send(res, 502, "the bot's ChatGPT login was rejected — run the device login again and redeploy")
      }
      const out = {}
      up.headers.forEach((v, k) => {
        if (!DROP_RES.has(k)) out[k] = v
      })
      res.writeHead(up.status, out)
      if (up.body) for await (const chunk of up.body) res.write(chunk)
      res.end()
    } catch (e) {
      if (abort.signal.aborted) return // the box hung up (e.g. Codex's short models fetch) — not an error
      log(`proxy (${claims.thread}): ${e.message}`)
      if (!res.headersSent) send(res, 502, 'upstream error')
      else res.destroy()
    }
  })
}

// Whatever a job asks for, it runs on the configured model — cost is set here, not in the box.
function pinModel(body, model) {
  try {
    return JSON.stringify({ ...JSON.parse(body), model })
  } catch {
    return body
  }
}

async function readAll(req, limit = 32 * 1024 * 1024) {
  const chunks = []
  let size = 0
  for await (const c of req) {
    if ((size += c.length) > limit) throw new Error('request body too large')
    chunks.push(c)
  }
  return Buffer.concat(chunks)
}

function send(res, status, message) {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify({ error: { message } }))
}
