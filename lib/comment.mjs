// Upsert the sticky review summary: find our marker, PATCH in place, else POST new.
// Runner-side (imported by orchestrate.mjs) — the box no longer posts to GitHub.
import { ghJson } from './github.mjs'

export const MARKER = '<!-- boxlite-github-agent -->'
// Stickies posted before the rename (pr-review-agent) carry this marker; still match it so an
// open PR's summary is PATCHed — and re-marked — instead of duplicated.
const LEGACY_MARKER = '<!-- boxlite-pr-review -->'
export const MAX_BODY_CHARS = 60000 // GitHub rejects comment bodies above 65536 chars.

/** GitHub caps a comment body; truncate with a visible marker before sending. */
export function clampBody(body) {
  return body.length > MAX_BODY_CHARS ? body.slice(0, MAX_BODY_CHARS) + '\n\n…(truncated)' : body
}

/**
 * One sticky comment per PR: reuse the comment carrying our marker (PATCH), else create
 * it (POST). Marker-based, not author-based, so it survives a bot-identity change.
 * `fetchImpl` is injectable for tests.
 */
export async function upsertComment({ repo, pr, body, token, fetchImpl = fetch }) {
  const clamped = clampBody(body)
  const comments = await ghJson(`/repos/${repo}/issues/${pr}/comments?per_page=100`, { token, fetchImpl })
  const mine = comments.find((c) => c.body?.startsWith(MARKER) || c.body?.startsWith(LEGACY_MARKER))
  if (mine) {
    await ghJson(`/repos/${repo}/issues/comments/${mine.id}`, { token, fetchImpl, method: 'PATCH', body: { body: clamped } })
    return { action: 'updated', id: mine.id }
  }
  const created = await ghJson(`/repos/${repo}/issues/${pr}/comments`, { token, fetchImpl, method: 'POST', body: { body: clamped } })
  return { action: 'created', id: created.id }
}
