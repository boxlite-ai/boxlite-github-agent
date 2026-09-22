// Posting as the bot: 👀 on a request the moment it's picked up, then the answer in its thread.
// Codex writes Markdown, and Slack's `markdown` block renders it as such — code blocks with their
// language, lists, tables — up to 12,000 characters of it per message; a longer answer goes out as
// a few messages, split between paragraphs, and never inside a code block without closing it and
// opening it again. The controller's own words (help, apologies) are plain Slack text, and notices
// meant for one person only (not allowed, over the limit) are ephemeral: only they see them.
const LIMIT = 12_000 // Slack: all markdown blocks of one message together
const MAX_ANSWER = 40_000 // beyond this an answer is cut: four messages is plenty for a thread

export async function react(slack, req, name = 'eyes') {
  try {
    await slack.call('reactions.add', { channel: req.channel, timestamp: req.ts, name })
  } catch (e) {
    if (e.code !== 'already_reacted') throw e
  }
}

/**
 * Codex's answer, in the thread, with the BoxLite footer under its last part — and above it, the
 * changes the turn made in the team's tools (`changes`, as the controller recorded them: Codex's
 * own account of them is in its answer, this one it can't leave out).
 */
export async function reply(slack, req, markdown, { changes = [] } = {}) {
  let text = String(markdown || '').trim() || '(no answer)'
  if (text.length > MAX_ANSWER) {
    text = text.slice(0, MAX_ANSWER)
    const open = openFence(text)
    text += `${open ? `\n${open.fence}` : ''}\n\n…(truncated)`
  }
  const parts = split(text)
  for (const [i, part] of parts.entries()) {
    await slack.call('chat.postMessage', {
      channel: req.channel,
      thread_ts: req.threadTs,
      text: part.slice(0, 300), // what notifications show
      blocks: [{ type: 'markdown', text: part }, ...(i === parts.length - 1 ? [footer(req, changes)] : [])],
      unfurl_links: false,
      unfurl_media: false,
    })
  }
}

/** The controller's own words, in the thread (Slack's mrkdwn: *bold*, <@U123> mentions). */
export function say(slack, req, text) {
  return slack.call('chat.postMessage', { channel: req.channel, thread_ts: req.threadTs, text, unfurl_links: false })
}

/** A notice only the requester sees. Slack shows an ephemeral reply in a thread only once the thread exists. */
export function whisper(slack, req, text) {
  return slack.call('chat.postEphemeral', { channel: req.channel, user: req.user, text, thread_ts: req.threadTs === req.ts ? undefined : req.threadTs })
}

const footer = (req, changes) => ({
  type: 'context',
  elements: [
    ...(changes.length ? [{ type: 'mrkdwn', text: `✏️ Changed as the bot: ${tally(changes)}` }] : []),
    { type: 'mrkdwn', text: `📦 Ran in an isolated <https://boxlite.ai|BoxLite> microVM · ${req.isDM ? 'reply in this thread' : 'mention me in this thread'} to follow up` },
  ],
})

/** ['Linear save_comment', 'Linear save_comment', 'Notion notion-update-page'] → "Linear save_comment ×2 · Notion notion-update-page" */
export const tally = (xs) => [...Map.groupBy(xs, (x) => x)].map(([x, all]) => (all.length > 1 ? `${x} ×${all.length}` : x)).join(' · ')

/**
 * Markdown in parts of at most `limit` characters: cut at the last blank line if it's in the second
 * half of the part, else at the last line break there, else anywhere (never inside a surrogate
 * pair). A code block the cut falls in is closed at the end of the part and reopened — with its
 * opening line, so the language survives — at the start of the next.
 */
export function split(text, limit = LIMIT) {
  const parts = []
  let rest = text
  let reopen = ''
  while (reopen.length + rest.length > limit) {
    const room = limit - reopen.length - 8 // space to close a code block: "\n" + its fence
    let cut = rest.lastIndexOf('\n\n', room)
    if (cut < room / 2) cut = rest.lastIndexOf('\n', room)
    if (cut < room / 2) cut = /[\uD800-\uDBFF]/.test(rest[room - 1]) ? room - 1 : room
    const part = reopen + rest.slice(0, cut)
    const open = openFence(part)
    parts.push(open ? `${part}\n${open.fence}` : part)
    reopen = open ? `${open.line}\n` : ''
    rest = rest.slice(cut).replace(/^\n+/, '')
  }
  parts.push(reopen + rest)
  return parts
}

/** The code block still open at the end of `md`: its opening line and fence, or null. */
function openFence(md) {
  let open = null
  for (const line of md.split('\n')) {
    const m = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line)
    if (!m) continue
    if (!open) open = { fence: m[1], line: line.trimEnd() }
    else if (m[1][0] === open.fence[0] && m[1].length >= open.fence.length && !m[2].trim()) open = null
  }
  return open
}
