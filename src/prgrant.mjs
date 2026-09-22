// A Slack turn's PR, asked for by its box once the work is done (box/session.mjs): `POST /pr` with
// the turn's job token and { repo, base } — which repo, and the commit its clone builds on. A
// Slack thread belongs to no repo, so this can't be planned before the turn, as a GitHub thread's
// write turn is. The controller decides: the job must carry a PR grant (slack-channel.mjs, which
// holds the rules), for one repo, once. The answer is the one ref the box may then push
// (gitpush.mjs); what the commits contain is checked after the turn (publish.mjs).
import { verifyJobToken } from './chatgpt.mjs'

const REPO = /^[\w.-]+\/[\w.-]+$/
const SHA = /^[0-9a-f]{40}$/

/** The /pr handler. A live job's `pr.grant({ repo, base })` resolves to `{ ref }`, or throws why not. */
export function prGrantHandler({ secret, jobs, log = () => {} }) {
  return async (req, res) => {
    if (req.method !== 'POST' || req.url !== '/pr') return send(res, 404, 'not available through this proxy')
    const claims = verifyJobToken(secret, /^Bearer (\S+)$/.exec(req.headers.authorization || '')?.[1])
    const job = claims && jobs.live.get(claims.jti)
    if (!job) return send(res, 403, 'unknown or expired job token')
    if (!job.pr) return send(res, 403, 'this turn may not open a PR')
    if (job.push || job.pr.asked) return send(res, 409, 'this turn has asked for its PR already')
    let body
    try {
      body = JSON.parse(await readAll(req, 4096))
    } catch {
      return send(res, 400, 'send {"repo": "owner/name", "base": "<commit>"}')
    }
    const repo = String(body?.repo ?? '')
    const base = String(body?.base ?? '')
    if (!REPO.test(repo) || !SHA.test(base)) return send(res, 400, 'send {"repo": "owner/name", "base": "<commit>"}')
    job.pr.asked = true // one ask per turn, granted or not
    try {
      const { ref } = await job.pr.grant({ repo, base })
      log(`${claims.thread}: PR into ${repo} for ${job.who ?? 'someone'}, from ${base.slice(0, 7)}`)
      return json(res, 200, { ref })
    } catch (e) {
      log(`${claims.thread}: no PR into ${repo} for ${job.who ?? 'someone'}: ${e.message}`)
      return send(res, 403, e.message)
    }
  }
}

async function readAll(req, limit) {
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

const send = (res, status, message) => json(res, status, { error: message })
