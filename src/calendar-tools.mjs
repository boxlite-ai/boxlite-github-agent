// Google's Calendar MCP has event tools, but no calendar creation tool. This small MCP
// endpoint uses Calendar REST with the same requester token and broker checks as other tools.
const fields = { summary: { type: 'string', minLength: 1, maxLength: 1024 }, description: { type: 'string', maxLength: 4096 }, timeZone: { type: 'string', maxLength: 128 } }
const createCalendar = {
  name: 'create_calendar',
  description: 'Create a separate Google calendar owned by the requesting user. This does not share it or invite anyone. Use calendar.create_event with the returned calendar id for events and invitations.',
  inputSchema: { type: 'object', properties: fields, required: ['summary'], additionalProperties: false },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
}

export async function calendarMcp({ method, body, headers, signal }, fetchImpl = fetch) {
  if (method !== 'POST') return new Response(null, { status: 405 })
  const msg = JSON.parse(body)
  const answer = (result) => Response.json({ jsonrpc: '2.0', id: msg.id ?? null, result })
  const error = (status, code, message) => Response.json({ jsonrpc: '2.0', id: msg.id ?? null, error: { code, message } }, { status })
  if (msg.method?.startsWith('notifications/')) return new Response(null, { status: 202 })
  if (msg.method === 'initialize') return answer({ protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'boxlite-calendars', version: '1' } })
  if (msg.method === 'ping') return answer({})
  if (msg.method === 'tools/list') return answer({ tools: [createCalendar] })
  if (msg.method !== 'tools/call' || msg.params?.name !== createCalendar.name) return error(400, -32601, 'Unknown calendar tool')
  const args = msg.params.arguments
  if (!args || typeof args !== 'object' || Array.isArray(args) || typeof args.summary !== 'string' || !args.summary.trim()
    || Object.entries(args).some(([key, value]) => !Object.hasOwn(fields, key) || typeof value !== 'string' || value.length > fields[key].maxLength)) {
    return error(400, -32602, 'Provide a nonempty summary (up to 1024 characters), optional description (4096), and optional IANA timeZone (128); no other fields.')
  }
  if (args.timeZone !== undefined) {
    try { new Intl.DateTimeFormat('en', { timeZone: args.timeZone }) } catch { return error(400, -32602, 'timeZone must be an IANA time zone') }
  }
  // Calendar insertion is not idempotent: the broker retries only a rejected token (401),
  // never a timeout or 5xx response that might have followed a successful insertion.
  const response = await fetchImpl('https://www.googleapis.com/calendar/v3/calendars', {
    method: 'POST', headers: { authorization: headers.authorization, 'content-type': 'application/json' },
    body: JSON.stringify(args), signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]), redirect: 'error',
  })
  if (!response.ok) {
    await response.body?.cancel()
    return error(response.status, -32603, `Google Calendar creation failed: HTTP ${response.status}`)
  }
  const calendar = await response.json()
  return answer({ content: [{ type: 'text', text: JSON.stringify(calendar) }] })
}
