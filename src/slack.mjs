// Slack's Web API as the bot — only what the controller needs. Every call is a form-encoded POST to
// https://slack.com/api/<method> with the token in the Authorization header, never in the body: in
// the deployed controller the token is a BoxLite secret placeholder, which the platform swaps for
// the real one on the way out to slack.com (and files.slack.com, for downloads) and nowhere else.
// Slack answers most failures with a 200 and { ok: false, error }, so `ok` decides, not the status;
// a 429 says how long to back off (Retry-After) and is retried. `fetchImpl`/`sleep` are for tests.
const API = 'https://slack.com/api'
const MAX_BACKOFF_S = 60 // a longer Retry-After fails the call instead of stalling a turn

export function slack(token, { fetchImpl = fetch, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  const auth = { Authorization: `Bearer ${token}`, 'User-Agent': 'boxlite-github-agent' }

  /** One Web API method. Throws `slack <method>: <error>`, with Slack's error string as `.code`. */
  async function call(method, params = {}) {
    const form = new URLSearchParams()
    for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null) form.set(k, typeof v === 'string' ? v : JSON.stringify(v))
    for (let attempt = 1; ; attempt++) {
      const res = await fetchImpl(`${API}/${method}`, {
        method: 'POST',
        headers: { ...auth, 'Content-Type': 'application/x-www-form-urlencoded; charset=utf-8' },
        body: form.toString(),
      })
      if (res.status === 429) {
        const wait = Number(res.headers.get('retry-after')) || 1
        if (attempt >= 3 || wait > MAX_BACKOFF_S) throw failure(method, `ratelimited (retry after ${wait}s)`, 'ratelimited')
        await sleep(wait * 1000)
        continue
      }
      if (!res.ok) throw failure(method, `HTTP ${res.status}`, `http_${res.status}`)
      const data = await res.json()
      if (!data.ok) throw failure(method, data.error || 'unknown_error', data.error)
      return data
    }
  }

  /**
   * A file's bytes, from its url_private_download. The bot token goes to files.slack.com and nowhere
   * else, and the download stops at `maxBytes`. When Slack won't authorize a download it answers with
   * its HTML sign-in page and a 200 — so HTML for a file that isn't HTML is an error too.
   */
  async function download(url, { maxBytes, mimetype = '' } = {}) {
    const u = new URL(url)
    if (u.protocol !== 'https:' || u.hostname !== 'files.slack.com') throw new Error(`not a Slack file URL (${u.hostname})`)
    const res = await fetchImpl(u, { headers: auth })
    if (!res.ok) throw new Error(`download failed: HTTP ${res.status}`)
    if (/text\/html/i.test(res.headers.get('content-type') || '') && !/html/i.test(mimetype)) {
      await res.body?.cancel()
      throw new Error('Slack sent its sign-in page instead of the file — does the app have the files:read scope?')
    }
    const chunks = []
    let size = 0
    for await (const chunk of res.body) {
      if ((size += chunk.length) > maxBytes) throw new Error(`larger than ${maxBytes} bytes`) // leaving the loop cancels the stream
      chunks.push(chunk)
    }
    return Buffer.concat(chunks)
  }

  return { call, download }
}

function failure(method, what, code) {
  const err = new Error(`slack ${method}: ${what}`)
  err.code = code
  return err
}
