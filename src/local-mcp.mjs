// Local agent tools use the same live job token as remote MCP services. Their implementations
// stay in the controller. No caller-supplied identity, credential or URL reaches an API client.
export async function localMcp(req, res, { job, active, limits = {} }) {
  const json = (status, body) => res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body))
  const error = (id, code, message, status = 200) => json(status, { jsonrpc: '2.0', id, error: { code, message } })
  if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return error(null, -32600, 'use POST', 405) }
  let msg
  try {
    const chunks = []; let size = 0
    for await (const chunk of req) {
      if ((size += chunk.length) > 64 * 1024) return error(null, -32600, 'request too large', 413)
      chunks.push(chunk)
    }
    msg = JSON.parse(Buffer.concat(chunks).toString())
  } catch { return error(null, -32700, 'invalid JSON', 400) }
  if (!msg || Array.isArray(msg) || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') return error(null, -32600, 'one JSON-RPC request required', 400)
  if (!Object.hasOwn(msg, 'id') && msg.method.startsWith('notifications/')) return res.writeHead(202).end()
  if (!['string', 'number'].includes(typeof msg.id)) return error(null, -32600, 'request id required', 400)
  const answer = (result) => json(200, { jsonrpc: '2.0', id: msg.id, result })
  const local = job.slack
  if (msg.method === 'initialize') return answer({ protocolVersion: ['2024-11-05', '2025-03-26', '2025-06-18'].includes(msg.params?.protocolVersion) ? msg.params.protocolVersion : '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'boxlite-slack', version: '1.0.0' } })
  if (msg.method === 'ping') return answer({})
  if (msg.method === 'tools/list') return answer({ tools: local.tools.map(({ run, write, ...tool }) => tool) })
  if (msg.method !== 'tools/call') return error(msg.id, -32601, 'method unavailable')
  const tool = local.tools.find((t) => t.name === msg.params?.name)
  if (!tool) return answer(failed('tool unavailable for this request'))
  const args = msg.params.arguments ?? {}
  const invalid = validate(tool.inputSchema, args)
  if (invalid) return answer(failed(invalid))
  // All local calls share a queue: duplicate writes and parallel calls cannot race each other.
  const run = async () => {
    const check = () => { if (!active()) throw new Error('This request has stopped or expired.') }
    try {
      check()
      if (++job.toolCalls > (limits.maxCalls ?? 60)) throw new Error('Tool call budget exhausted.')
      const key = JSON.stringify([tool.name, Object.entries(args).sort(([a], [b]) => a.localeCompare(b))])
      const cache = (local.results ??= new Map())
      if (tool.write && cache.has(key)) return cache.get(key)
      if (tool.write && job.writes.length >= (limits.maxWrites ?? 10)) throw new Error('Change budget exhausted.')
      let result
      try {
        const value = await tool.run(args, check)
        if (tool.write) job.writes.push(`Slack ${tool.name}`)
        result = { content: [{ type: 'text', text: JSON.stringify(value) }], isError: false }
      } catch (e) {
        result = failed(e.code ? `Slack ${e.code}. Check permissions and the destination before retrying.` : e.message || 'Could not confirm the result. Check before retrying.')
      }
      // Cache ambiguous failures too: Slack may have accepted a write before the response was lost.
      if (tool.write) cache.set(key, result)
      await local.record?.()
      return result
    } catch (e) { return failed(e.message) }
  }
  const pending = (local.queue ?? Promise.resolve()).then(run)
  local.queue = pending.then(() => {}, () => {})
  return answer(await pending)
}
const failed = (text) => ({ content: [{ type: 'text', text }], isError: true })

// The small schema vocabulary used by our tools. Reject unknown fields rather than forwarding
// arbitrary Web API parameters (identity overrides, unfurls, broadcast flags, tokens, etc.).
export function validate(schema, value) {
  if (schema.type === 'object') {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return 'Expected an object.'
    for (const name of schema.required ?? []) if (!Object.hasOwn(value, name)) return `Missing ${name}.`
    for (const [name, v] of Object.entries(value)) {
      if (!Object.hasOwn(schema.properties, name)) return `Unknown argument: ${name}.`
      const why = validate(schema.properties[name], v)
      if (why) return `${name}: ${why}`
    }
  } else if (schema.type === 'integer') {
    if (!Number.isInteger(value) || value < (schema.minimum ?? -Infinity) || value > (schema.maximum ?? Infinity)) return 'Integer outside allowed range.'
  } else if (typeof value !== schema.type) return `Expected ${schema.type}.`
  if (schema.enum && !schema.enum.includes(value)) return 'Value is not allowed.'
  if (typeof value === 'string' && (value.length < (schema.minLength ?? 0) || value.length > (schema.maxLength ?? Infinity) || (schema.pattern && !new RegExp(schema.pattern).test(value)))) return 'Invalid string.'
  return null
}
