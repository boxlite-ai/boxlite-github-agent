// The one GitHub write a session box can make: a `git push` of its turn's commits to one staging
// branch of the bot's fork, through the controller. The box authenticates with its job token —
// the same one it uses for the model — and the controller forwards the push with that turn's
// GitHub App token, which never leaves the controller.
//
// GitHub can scope a token to a repository, not to a branch; this is where the branch is enforced.
// The URL names no repository at all (the turn's grant decides where it goes), and a push must
// update exactly the granted ref: no second ref, no tags, no delete. Only the ref-update commands
// at the start of the push are read — plain pkt-lines — and the pack after them is passed through
// untouched. What the commits contain is checked after the turn (publish.mjs), on GitHub's own diff.
import { verifyJobToken } from './chatgpt.mjs'

const ZERO = /^0+$/

/**
 * The ref-update commands that open a receive-pack request: pkt-lines up to the first flush.
 * Anything else there — a signed push certificate, shallow lines — is refused.
 * @returns {{ commands: { old: string, new: string, ref: string }[], caps: string[] }}
 */
export function receivePackCommands(buf) {
  const commands = []
  let caps = []
  for (let i = 0; ; ) {
    const hex = buf.toString('latin1', i, i + 4)
    if (!/^[0-9a-f]{4}$/i.test(hex)) throw new Error('not a git push')
    const len = parseInt(hex, 16)
    if (len === 0) return { commands, caps }
    if (len < 5 || i + len > buf.length) throw new Error('truncated git push')
    let line = buf.toString('latin1', i + 4, i + len).replace(/\n$/, '')
    i += len
    const nul = line.indexOf('\0')
    if (nul >= 0) {
      if (!commands.length) caps = line.slice(nul + 1).split(' ').filter(Boolean)
      line = line.slice(0, nul)
    }
    const m = /^([0-9a-f]{40}|[0-9a-f]{64}) ([0-9a-f]{40}|[0-9a-f]{64}) (\S+)$/.exec(line)
    if (!m) throw new Error('only plain ref updates can be pushed')
    commands.push({ old: m[1], new: m[2], ref: m[3] })
  }
}

/**
 * `GET /git/info/refs?service=git-receive-pack` and `POST /git/git-receive-pack` for a job whose
 * live entry carries a push grant `{ ref, open }`, set by the controller for a write turn:
 * `open()` resolves (once, on the first push) to `{ repo, token }` — the fork and its App token.
 */
export function gitPushHandler({ secret, jobs, upstream = 'https://github.com', maxBytes = 64 * 1024 * 1024, maxPushes = 5, fetchImpl = fetch, log = () => {} }) {
  return async (req, res) => {
    const url = new URL(req.url, 'http://proxy')
    const advert = req.method === 'GET' && url.pathname === '/git/info/refs' && url.search === '?service=git-receive-pack'
    const push = req.method === 'POST' && url.pathname === '/git/git-receive-pack'
    if (!advert && !push) return send(res, 404, 'not available through this proxy')
    const claims = verifyJobToken(secret, /^Bearer (\S+)$/.exec(req.headers.authorization || '')?.[1])
    const job = claims && jobs.live.get(claims.jti)
    const grant = job?.push
    if (!grant) return send(res, 403, 'this turn may not push')

    let body
    if (push) {
      if (++job.pushes > maxPushes) return send(res, 429, 'this turn used up its pushes')
      if (req.headers['content-encoding'] && req.headers['content-encoding'] !== 'identity') return send(res, 415, 'compressed pushes are not accepted')
      try {
        body = await readAll(req, maxBytes)
        const { commands } = receivePackCommands(body)
        const [c, ...more] = commands
        if (!c || more.length || c.ref !== grant.ref) return send(res, 403, `this turn may push only ${grant.ref}`)
        if (ZERO.test(c.new)) return send(res, 403, `${grant.ref} can't be deleted`)
      } catch (e) {
        return send(res, 400, e.message)
      }
    }

    try {
      const { repo, token } = await grant.open()
      const headers = {
        authorization: `Basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}`,
        'user-agent': req.headers['user-agent'] || 'git/botlite',
        ...(req.headers['git-protocol'] ? { 'git-protocol': req.headers['git-protocol'] } : {}),
        ...(push ? { 'content-type': 'application/x-git-receive-pack-request', accept: 'application/x-git-receive-pack-result' } : {}),
      }
      const up = await fetchImpl(`${upstream}/${repo}.git/${advert ? 'info/refs?service=git-receive-pack' : 'git-receive-pack'}`, { method: req.method, headers, body })
      res.writeHead(up.status, { 'content-type': up.headers.get('content-type') || 'application/octet-stream' })
      // A refused ref still comes back 200: git reports it inside the body (`ng <ref> <reason>`).
      let tail = Buffer.alloc(0)
      if (up.body) {
        for await (const chunk of up.body) {
          res.write(chunk)
          if (push) tail = Buffer.concat([tail, chunk]).subarray(-4096)
        }
      }
      res.end()
      const refused = push && /\bng (refs\/\S+) ([^\n\0]+)/.exec(tail.toString('latin1'))
      if (refused) log(`${claims.thread}: ${repo} refused the push of ${refused[1]}: ${refused[2]}`)
      else if (push) log(`${claims.thread}: pushed ${grant.ref} to ${repo} (${up.status})`)
    } catch (e) {
      log(`git push (${claims.thread}): ${e.message}`)
      if (!res.headersSent) send(res, 502, `the push couldn't go through: ${e.message.slice(0, 200)}`)
      else res.destroy()
    }
  }
}

async function readAll(req, limit) {
  const chunks = []
  let size = 0
  for await (const c of req) {
    if ((size += c.length) > limit) throw new Error('push too large')
    chunks.push(c)
  }
  return Buffer.concat(chunks)
}

function send(res, status, message) {
  res.writeHead(status, { 'content-type': 'text/plain' })
  res.end(`${message}\n`)
}
