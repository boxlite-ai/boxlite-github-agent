// GitHub App webhook — the trigger for the runner:
//   • pull_request (opened/synchronize/reopened/ready_for_review, non-draft) → review
//   • issue_comment "@boxlite-agent review" on a PR, by a maintainer → review (drafts allowed)
//   • installation.deleted → drop the stored keys.
// Payload authenticity is verified with the App's webhook secret (HMAC-SHA256).
import { BrokerError } from './claims.mjs'
import { loadKeys, deleteKeys } from './store.mjs'
import { mintToken } from './mint.mjs'
import { mintJob } from './job.mjs'
import { createBox, startExecution } from './boxes.mjs'
import { upsertComment, MARKER } from '../../lib/comment.mjs'

const TRIGGER = '@boxlite-agent review'
const PR_ACTIONS = new Set(['opened', 'synchronize', 'reopened', 'ready_for_review'])
const ALLOWED_ASSOC = new Set(['OWNER', 'MEMBER', 'COLLABORATOR']) // only maintainers may hand-trigger
const GH = 'https://api.github.com'
const ghHeaders = (token) => ({ Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'User-Agent': 'boxlite-agent', 'X-GitHub-Api-Version': '2022-11-28' })
const IN_PROGRESS = `${MARKER}
### 📦 BoxLite review — in progress…

Spinning up a disposable BoxLite microVM and running Claude on this PR — installing deps, running the tests, and checking the diff. This comment will update with the findings.

<sub>powered by <a href="https://boxlite.ai">BoxLite</a></sub>`

async function verifySignature(secret, body, header) {
  if (!secret || !header) return false
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body)))
  const expected = 'sha256=' + [...mac].map((b) => b.toString(16).padStart(2, '0')).join('')
  if (header.length !== expected.length) return false
  let diff = 0
  for (let i = 0; i < expected.length; i++) diff |= header.charCodeAt(i) ^ expected.charCodeAt(i)
  return diff === 0
}

// Mint a contents:read clone token, boot a box, and fire-and-forget the in-box reviewer
// (exec returns an execution_id immediately; the box runs for minutes and calls /publish).
async function startReview(env, url, keys, { repo, owner, name, prNumber, headSha, baseRef, installationId }) {
  // Immediately post an "in progress" sticky so the PR shows the review has started; /publish
  // PATCHes this same marker comment into the findings (one comment, not two).
  try {
    const { token: writeToken } = await mintToken({ appId: env.APP_ID, privateKey: env.APP_PRIVATE_KEY, owner, repo: name, permissions: { pull_requests: 'write', metadata: 'read' } })
    await upsertComment({ repo, pr: prNumber, token: writeToken, body: IN_PROGRESS })
  } catch (e) {
    console.error(`[startReview] in-progress comment failed (non-fatal): ${e?.stack || e?.message || e}`)
  }

  const { token: cloneToken } = await mintToken({
    appId: env.APP_ID,
    privateKey: env.APP_PRIVATE_KEY,
    owner,
    repo: name,
    permissions: { contents: 'read', metadata: 'read' },
  })
  const box = await createBox(keys.boxliteKey, env.BOXLITE_URL, `github-agent-${name}-${prNumber}`.replace(/[^a-zA-Z0-9._-]/g, '-').slice(0, 60))
  const boxId = box.id || box.name
  const job = await mintJob(env.STORE_SECRET, { repo, pr: prNumber, headSha, baseRef, boxId, installationId })
  await startExecution(keys.boxliteKey, env.BOXLITE_URL, boxId, {
    command: 'bash',
    args: ['-lc', 'curl -fsS "$BROKER/reviewer.mjs" -o /tmp/r.mjs && node /tmp/r.mjs'],
    env: {
      REPO: repo,
      PR: String(prNumber),
      HEAD_SHA: headSha,
      BASE_REF: baseRef,
      GH_CLONE_TOKEN: cloneToken,
      CLAUDE_CODE_OAUTH_TOKEN: keys.claudeToken,
      JOB_TOKEN: job,
      BROKER: url.origin,
      BOX_ID: boxId,
    },
    timeoutSeconds: 900,
  })
  return boxId
}

export async function handleWebhook(request, env, url) {
  const body = await request.text()
  if (!(await verifySignature(env.WEBHOOK_SECRET, body, request.headers.get('x-hub-signature-256')))) {
    throw new BrokerError(401, 'invalid webhook signature')
  }
  const event = request.headers.get('x-github-event')
  const payload = JSON.parse(body)
  const installationId = payload.installation?.id

  if (event === 'installation' && payload.action === 'deleted') {
    if (installationId) await deleteKeys(env, installationId)
    return new Response('keys dropped', { status: 200 })
  }

  // Manual re-trigger: "@boxlite-agent review" comment on a PR, from a maintainer. Reviews
  // even drafts — an explicit request is explicit intent.
  if (event === 'issue_comment') {
    if (payload.action !== 'created' || !payload.issue?.pull_request) return new Response('ignored', { status: 200 })
    if (!String(payload.comment?.body || '').toLowerCase().includes(TRIGGER)) return new Response('no trigger phrase', { status: 200 })
    if (!ALLOWED_ASSOC.has(payload.comment?.author_association)) return new Response('commenter not authorized', { status: 200 })
    const repo = payload.repository.full_name
    const [owner, name] = repo.split('/')
    const keys = await loadKeys(env, installationId)
    if (!keys) return new Response('not configured — run /setup once to store keys', { status: 200 })
    const { token } = await mintToken({
      appId: env.APP_ID,
      privateKey: env.APP_PRIVATE_KEY,
      owner,
      repo: name,
      permissions: { pull_requests: 'write', contents: 'read', metadata: 'read' },
    })
    const prNumber = payload.issue.number
    await fetch(`${GH}/repos/${repo}/issues/comments/${payload.comment.id}/reactions`, { method: 'POST', headers: ghHeaders(token), body: JSON.stringify({ content: 'eyes' }) }).catch(() => {})
    const pr = await fetch(`${GH}/repos/${repo}/pulls/${prNumber}`, { headers: ghHeaders(token) }).then((r) => r.json())
    if (!pr?.head?.sha) throw new BrokerError(502, `could not fetch ${repo}#${prNumber}`)
    const boxId = await startReview(env, url, keys, { repo, owner, name, prNumber, headSha: pr.head.sha, baseRef: pr.base.ref, installationId })
    return new Response(`review started via @mention: ${repo}#${prNumber} in box ${boxId}`, { status: 200 })
  }

  if (event !== 'pull_request' || !PR_ACTIONS.has(payload.action)) return new Response('ignored', { status: 200 })
  const pr = payload.pull_request
  if (pr.draft) return new Response('draft — skipped (comment "@boxlite-agent review" to force)', { status: 200 })
  const repo = payload.repository.full_name
  const [owner, name] = repo.split('/')
  const keys = await loadKeys(env, installationId)
  if (!keys) return new Response('not configured — run /setup once to store keys', { status: 200 })
  const boxId = await startReview(env, url, keys, { repo, owner, name, prNumber: pr.number, headSha: pr.head.sha, baseRef: pr.base.ref, installationId })
  return new Response(`review started: ${repo}#${pr.number} in box ${boxId}`, { status: 200 })
}
