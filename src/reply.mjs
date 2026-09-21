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

export function reply(gh, req, text) {
  const t = String(text || '').trim() || '(no answer)'
  const body = (t.length > MAX_BODY ? `${t.slice(0, MAX_BODY)}\n\n…(truncated)` : t) + FOOTER
  return req.kind === 'review_comment'
    ? gh.json('POST', `/repos/${req.repo}/pulls/${req.number}/comments/${req.commentId}/replies`, { body: { body } })
    : gh.json('POST', `/repos/${req.repo}/issues/${req.number}/comments`, { body: { body } })
}
