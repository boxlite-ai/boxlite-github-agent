// Linear, Notion and Google Workspace for Codex, as MCP servers on the controller's public port —
// /mcp/<service> — guarded the way the model is. A box's Codex presents its job token; the
// controller checks it, checks the call against the tool policy (access.mjs), swaps in the bot's
// own credential and forwards the call to the service's official MCP server. No credential of any
// of them ever enters a box, and a tool the policy doesn't list can't be called, however Codex is
// talked to.
//
// MCP here is JSON-RPC over HTTP ("streamable HTTP"): the box POSTs one message at a time, and the
// answer comes back as JSON or a stream of server-sent events, passed through as it arrives. Only
// what a tool session needs gets through: initialize, ping, tools/list, notifications, and
// tools/call for listed tools. (Codex's `enabled_tools` hides the rest from the model; this is what
// enforces it.)
import { verifyJobToken } from './chatgpt.mjs'
import { localMcp } from './local-mcp.mjs'

const G = 'https://www.googleapis.com/auth/'
/** The services, their official MCP servers, the login each uses — and for Google, the scopes. */
export const SERVICES = {
  linear: { label: 'Linear', url: 'https://mcp.linear.app/mcp', login: 'linear' },
  notion: { label: 'Notion', url: 'https://mcp.notion.com/mcp', login: 'notion' },
  drive: { label: 'Google Drive', url: 'https://drivemcp.googleapis.com/mcp/v1', login: 'google', scopes: { read: [`${G}drive.readonly`], write: [`${G}drive.file`] } },
  docs: { label: 'Google Docs', url: 'https://docsmcp.googleapis.com/mcp/v1', login: 'google', scopes: { read: [`${G}documents.readonly`], write: [`${G}documents`] } },
  sheets: { label: 'Google Sheets', url: 'https://sheetsmcp.googleapis.com/mcp/v1', login: 'google', scopes: { read: [`${G}spreadsheets.readonly`], write: [`${G}spreadsheets`] } },
  slides: { label: 'Google Slides', url: 'https://slidesmcp.googleapis.com/mcp/v1', login: 'google', scopes: { read: [`${G}presentations.readonly`], write: [`${G}presentations`] } },
  calendar: { label: 'Google Calendar', url: 'https://calendarmcp.googleapis.com/mcp/v1', login: 'google', scopes: { read: [`${G}calendar.readonly`], write: [`${G}calendar.events`] } },
}
const SESSION = new Set(['initialize', 'ping', 'tools/list'])
const REQ_HEADERS = ['accept', 'content-type', 'mcp-session-id', 'mcp-protocol-version', 'last-event-id']
// Back to the box: what MCP needs, nothing else — never a vendor's cookies.
const RES_HEADERS = ['content-type', 'mcp-session-id', 'mcp-protocol-version', 'retry-after', 'cache-control']

/** What a turn's Codex gets: the services whose login is in place and that allow a tool at all. */
export function enabledServices(logins, policy) {
  return Object.entries(SERVICES)
    .filter(([name, s]) => logins[s.login]?.ready() && tools(policy, name).length)
    .map(([name, s]) => ({ name, label: s.label, tools: tools(policy, name), writes: policy[name].write.length > 0 }))
}
const tools = (policy, name) => [...(policy[name]?.read ?? []), ...(policy[name]?.write ?? [])]

/** The Google scopes a login needs for what the policy allows (`ctl link google` asks for these). */
export function googleScopes(policy) {
  const scopes = new Set(['openid', 'email'])
  for (const [name, s] of Object.entries(SERVICES)) {
    if (s.login !== 'google') continue
    if (policy[name]?.read.length) s.scopes.read.forEach((x) => scopes.add(x))
    if (policy[name]?.write.length) s.scopes.write.forEach((x) => scopes.add(x))
  }
  return [...scopes]
}

/**
 * One POSTed JSON-RPC message: let it through ({ tool, write } for a tool call), or the answer to
 * give in its place ({ answer, status }). Counts the job's tool calls and changes against its budget.
 */
export function check(service, body, allowed, job, { maxCalls = 60, maxWrites = 10 } = {}) {
  let msg
  try {
    msg = JSON.parse(body)
  } catch {
    return { status: 400, answer: rpcError(null, -32700, 'not JSON') }
  }
  if (!msg || typeof msg !== 'object' || Array.isArray(msg)) return { status: 400, answer: rpcError(null, -32600, 'one JSON-RPC message per request') }
  const id = msg.id ?? null
  const method = typeof msg.method === 'string' ? msg.method : null
  // A response to the server (no method), a notification, or the session's own plumbing.
  if (!method || method.startsWith('notifications/') || SESSION.has(method)) return {}
  if (method !== 'tools/call') return { answer: rpcError(id, -32601, `${method} isn't available through this bot`) }
  const tool = String(msg.params?.name ?? '')
  const write = allowed.write.includes(tool)
  if (!write && !allowed.read.includes(tool)) return { answer: toolError(id, `${tool} isn't allowed on this bot: it may use only the ${service} tools it lists`), refused: tool }
  if (++job.toolCalls > maxCalls) return { answer: toolError(id, 'this request has used up its tool calls') }
  if (write && job.writes.length >= maxWrites) return { answer: toolError(id, 'this request has used up the changes it may make') }
  return { tool, write }
}

/**
 * The /mcp/<service> handler. `logins`: { linear, notion, google } (oauth.mjs), each ready() once
 * it's in place, with token() — and refresh() where there's one. `policy`: access.mjs TOOLS.
 */
export function toolBroker({ secret, jobs, policy, fetchImpl = fetch, log = () => {}, limits }) {
  return async (req, res) => {
    // Never a 401: it would send Codex into an OAuth login of its own, which can't work in a box.
    const claims = verifyJobToken(secret, /^Bearer (\S+)$/.exec(req.headers.authorization || '')?.[1])
    const job = claims && jobs.live.get(claims.jti)
    if (!job) return send(res, 403, 'unknown or expired job token')
    const name = /^\/mcp\/([a-z]+)$/.exec(req.url)?.[1]
    if (name === 'slack') {
      if (!job.tools?.includes('slack') || !job.slack?.tools) return send(res, 404, 'no Slack tools for this request')
      return localMcp(req, res, { job, limits, active: () => jobs.live.get(claims.jti) === job && claims.exp > Math.floor(Date.now() / 1000) })
    }
    const service = Object.hasOwn(SERVICES, name ?? '') ? SERVICES[name] : null
    // Only the services this turn was given (job.tools): every turn's box holds a live job token,
    // and a public GitHub thread's turn that has no tools must not reach them with its own.
    if (!service || !job.tools?.includes(name)) {
      if (service) log(`${claims.thread}: refused ${name} for ${job.who ?? 'someone'} — this request wasn't given it`)
      return send(res, 404, 'no such tool service for this request')
    }
    // Whose login this turn uses: the requester's own (Slack) or the bot's shared one (GitHub
    // admins) — set on the job when the turn is built, never a login another request could reach.
    const login = job.logins?.[service.login]
    if (!login?.ready() || !tools(policy, name).length) return send(res, 404, 'no such tool service on this bot')
    if (!['POST', 'GET', 'DELETE'].includes(req.method)) return send(res, 405, 'not an MCP request')

    let body
    let call = {}
    if (req.method === 'POST') {
      body = await readAll(req).catch(() => null)
      if (body === null) return send(res, 413, 'request too large')
      call = check(name, body, policy[name], job, limits)
      if (call.refused) log(`${claims.thread}: refused ${name} ${call.refused} for ${job.who ?? 'someone'} — not on the tool list (access.mjs)`)
      if (call.answer) return json(res, call.status ?? 200, call.answer)
      if (call.tool) log(`${claims.thread}: ${name} ${call.tool}${call.write ? ' (a change)' : ''} for ${job.who ?? 'someone'}`)
    }

    const abort = new AbortController()
    res.on('close', () => abort.abort()) // the box hung up → stop the upstream stream
    try {
      const headers = Object.fromEntries(REQ_HEADERS.filter((h) => req.headers[h]).map((h) => [h, req.headers[h]]))
      const forward = async () => {
        const token = await login.token()
        if (jobs.live.get(claims.jti) !== job || claims.exp <= Math.floor(Date.now() / 1000)) throw new Error('This request has stopped or expired.')
        return fetchImpl(service.url, { method: req.method, headers: { ...headers, authorization: `Bearer ${token}` }, body, signal: abort.signal })
      }
      let up = await forward()
      if (up.status === 401 && login.refresh) {
        await up.body?.cancel()
        log(`${service.label} rejected the bot's access token; refreshing`)
        await login.refresh()
        up = await forward()
      }
      if (up.status === 401) {
        await up.body?.cancel()
        return send(res, 502, `the bot's ${service.label} login was rejected — an admin needs to link it again (see the README)`)
      }
      const out = {}
      for (const h of RES_HEADERS) if (up.headers.get(h)) out[h] = up.headers.get(h)
      res.writeHead(up.status, out)
      if (up.body) for await (const chunk of up.body) res.write(chunk)
      res.end()
      if (call.write && up.ok) {
        job.writes.push(`${service.label} ${call.tool}`)
        await job.slack?.record?.()
      }
    } catch (e) {
      if (abort.signal.aborted) return
      log(`${service.label} (${claims.thread}): ${e.message}`)
      if (!res.headersSent) send(res, 502, `${service.label} can't be reached right now`)
      else res.destroy()
    }
  }
}

const rpcError = (id, code, message) => ({ jsonrpc: '2.0', id, error: { code, message } })
// A refused tool call as the tool's own failure, so the model reads why and can tell the person.
const toolError = (id, text) => ({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text }], isError: true } })

async function readAll(req, limit = 4 * 1024 * 1024) {
  const chunks = []
  let size = 0
  for await (const c of req) {
    if ((size += c.length) > limit) throw new Error('too large')
    chunks.push(c)
  }
  return Buffer.concat(chunks).toString('utf8')
}

function json(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}

function send(res, status, message) {
  json(res, status, { error: { message } })
}
