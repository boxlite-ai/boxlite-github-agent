// BoxLite REST + exec attach — only what the controller needs. Base https://api.boxlite.ai; its
// balancer maps /v1/… onto the API's /api/v1/…, WebSocket upgrades included. Auth: Bearer <org
// API key>; in the deployed controller that value is a BoxLite secret placeholder the platform
// swaps in on the way out. Exec is fire-and-forget on the wire, and an exec nobody is attached to
// is reaped after ~5 min (SIGHUP → SIGTERM → SIGKILL), so a turn always runs attached.
const DEFAULT_BASE = 'https://api.boxlite.ai'
const STDIN_FRAME = 1024 * 1024

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
    startBox: (id) => call('POST', `/v1/boxes/${id}/start`),
    listVolumes: () => call('GET', '/v1/volumes'),
    createVolume: (name) => call('POST', '/v1/volumes', { name }),
    startExec: (id, spec) => call('POST', `/v1/boxes/${id}/exec`, spec),
    /** A port's public URL (product API: /box/…, which api.boxlite.ai maps to /api/box/…). */
    previewUrl: (id, port) => call('GET', `/box/${encodeURIComponent(id)}/ports/${port}/preview-url`),
    killExec: (id, execId) => call('DELETE', `/v1/boxes/${id}/executions/${execId}`),

    /**
     * Attach to an execution: send `stdin` then EOF, stream output until the exit message.
     * Wire format: binary [0x01|stdout] / [0x02|stderr] frames, text {"type":"exit","exit_code":N}.
     * A handshake that fails (the box still resuming — seen live) is retried: the exec runs on
     * unattached for minutes and replays its output on attach, so nothing is lost.
     * @returns {Promise<number>} the exit code
     */
    async attach(id, execId, opts) {
      for (let attempt = 1; ; attempt++) {
        try {
          return await attachOnce(id, execId, opts)
        } catch (e) {
          if (!e.beforeOpen || attempt >= (opts.handshakeRetries ?? 5)) throw e
          await new Promise((r) => setTimeout(r, (opts.retryDelayMs ?? 2000) * attempt))
        }
      }
    },
  }

  function attachOnce(id, execId, { stdin, onStdout, onStderr, timeoutMs }) {
    return new Promise((resolve, reject) => {
      const ws = new WebSocketImpl(`${root.replace(/^http/, 'ws')}/v1/boxes/${id}/executions/${execId}/attach`, { headers })
      ws.binaryType = 'arraybuffer'
      let exitCode = null
      let failure = null
      let opened = false
      const timer = setTimeout(() => {
        failure = new Error(`attach timed out after ${Math.round(timeoutMs / 1000)}s`)
        ws.close()
      }, timeoutMs)
      ws.onopen = () => {
        opened = true
        // In frames of at most 1 MiB: a turn's stdin can carry a Slack request's files.
        const bytes = Buffer.from(stdin ?? '')
        for (let i = 0; i < bytes.length; i += STDIN_FRAME) ws.send(bytes.subarray(i, i + STDIN_FRAME))
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
        if (exitCode !== null && !failure) return resolve(exitCode)
        const err = failure ?? new Error('attach closed before the exec exited')
        err.beforeOpen = !opened
        reject(err)
      }
    })
  }
}
