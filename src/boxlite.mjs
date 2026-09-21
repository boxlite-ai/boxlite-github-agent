// BoxLite REST + exec attach — only what the controller needs. Base https://api.boxlite.ai; its
// balancer maps /v1/… onto the API's /api/v1/…, WebSocket upgrades included. Auth: Bearer <org
// API key>; in the deployed controller that value is a BoxLite secret placeholder the platform
// swaps in on the way out. Exec is fire-and-forget on the wire, and an exec nobody is attached to
// is reaped after ~5 min (SIGHUP → SIGTERM → SIGKILL), so a turn always runs attached.
const DEFAULT_BASE = 'https://api.boxlite.ai'

export function boxlite(apiKey, { base = DEFAULT_BASE, fetchImpl = fetch, WebSocketImpl = globalThis.WebSocket } = {}) {
  const root = base.replace(/\/+$/, '')
  const headers = { Authorization: `Bearer ${apiKey}` }

  async function call(method, path, body, { allow404 = false } = {}) {
    const res = await fetchImpl(`${root}${path}`, {
      method,
      headers: { ...headers, Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    })
    if (allow404 && res.status === 404) return null
    if (!res.ok) {
      const err = new Error(`boxlite ${method} ${path} → ${res.status}: ${(await res.text().catch(() => '')).slice(0, 300)}`)
      err.status = res.status
      throw err
    }
    return res.status === 204 ? null : res.json().catch(() => ({}))
  }

  return {
    getBox: (idOrName) => call('GET', `/v1/boxes/${encodeURIComponent(idOrName)}`, undefined, { allow404: true }),
    createBox: (spec) => call('POST', '/v1/boxes', spec),
    stopBox: (id) => call('POST', `/v1/boxes/${id}/stop`),
    listVolumes: () => call('GET', '/v1/volumes'),
    createVolume: (name) => call('POST', '/v1/volumes', { name }),
    startExec: (id, spec) => call('POST', `/v1/boxes/${id}/exec`, spec),
    /** A port's public URL (product API: /box/…, which api.boxlite.ai maps to /api/box/…). */
    previewUrl: (id, port) => call('GET', `/box/${encodeURIComponent(id)}/ports/${port}/preview-url`),
    killExec: (id, execId) => call('DELETE', `/v1/boxes/${id}/executions/${execId}`),

    /**
     * Attach to an execution: send `stdin` then EOF, stream output until the exit message.
     * Wire format: binary [0x01|stdout] / [0x02|stderr] frames, text {"type":"exit","exit_code":N}.
     * @returns {Promise<number>} the exit code
     */
    attach(id, execId, { stdin, onStdout, onStderr, timeoutMs }) {
      return new Promise((resolve, reject) => {
        const ws = new WebSocketImpl(`${root.replace(/^http/, 'ws')}/v1/boxes/${id}/executions/${execId}/attach`, { headers })
        ws.binaryType = 'arraybuffer'
        let exitCode = null
        let failure = null
        const timer = setTimeout(() => {
          failure = new Error(`attach timed out after ${Math.round(timeoutMs / 1000)}s`)
          ws.close()
        }, timeoutMs)
        ws.onopen = () => {
          if (stdin) ws.send(Buffer.from(stdin))
          ws.send(JSON.stringify({ type: 'stdin_eof' }))
        }
        ws.onmessage = ({ data }) => {
          if (typeof data === 'string') {
            const msg = JSON.parse(data)
            if (msg.type === 'exit') exitCode = msg.exit_code
            else if (msg.type === 'error') failure = new Error(`exec error: ${msg.message}`)
            return
          }
          const bytes = Buffer.from(data)
          if (bytes[0] === 0x01) onStdout?.(bytes.subarray(1))
          else if (bytes[0] === 0x02) onStderr?.(bytes.subarray(1))
        }
        ws.onerror = (e) => {
          failure ??= new Error(`attach failed: ${e.message || 'websocket error'}`)
        }
        ws.onclose = () => {
          clearTimeout(timer)
          if (exitCode !== null && !failure) resolve(exitCode)
          else reject(failure ?? new Error('attach closed before the exec exited'))
        }
      })
    },
  }
}
