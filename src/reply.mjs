// Posting as @botlite: an 👀 on the request as soon as we pick it up, then the answer where the
// request was made — in the thread, or in the review thread when it came from a diff comment.
const MAX_BODY = 60_000 // GitHub rejects comment bodies over 65,536 chars
const FOOTER = '\n\n<sub>📦 Ran in an isolated <a href="https://boxlite.ai">BoxLite</a> microVM · reply with a mention to follow up</sub>'

export function react(gh, req, content = 'eyes') {
  const path =
    req.kind === 'review_comment'
      ? `/repos/${req.repo}/pulls/comments/${req.commentId}/reactions`
      : req.kind === 'comment'
        ? `/repos/${req.repo}/issues/comments/${req.commentId}/reactions`
        : `/repos/${req.repo}/issues/${req.number}/reactions`
  return gh.json('POST', path, { body: { content } })
}

/**
 * `footer: false` for the controller's own replies (commands), where nothing ran in a box. GitHub
 * sometimes answers 5xx for a comment it did create (seen live, followed by a second reply saying
 * something went wrong): on a 5xx it looks for the comment before posting it again.
 */
export async function reply(gh, req, text, { footer = true, retryDelayMs = 2000 } = {}) {
  const t = String(text || '').trim() || '(no answer)'
  const body = (t.length > MAX_BODY ? `${t.slice(0, MAX_BODY)}\n\n…(truncated)` : t) + (footer ? FOOTER : '')
  const [post, list] =
    req.kind === 'review_comment'
      ? [`/repos/${req.repo}/pulls/${req.number}/comments/${req.commentId}/replies`, `/repos/${req.repo}/pulls/${req.number}/comments`]
      : [`/repos/${req.repo}/issues/${req.number}/comments`, `/repos/${req.repo}/issues/${req.number}/comments`]
  const since = new Date(Date.now() - 60_000).toISOString()
  try {
    return await gh.json('POST', post, { body: { body } })
  } catch (e) {
    if (!(e.status >= 500)) throw e
    await new Promise((r) => setTimeout(r, retryDelayMs))
    const posted = (await gh.json('GET', `${list}?since=${since}&per_page=100`)).find((c) => c.body === body)
    return posted ?? gh.json('POST', post, { body: { body } })
  }
}
