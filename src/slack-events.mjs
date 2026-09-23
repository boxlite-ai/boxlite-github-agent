// Slack events → requests for the bot, and Slack's text → what Codex reads. Pure — no I/O — so all
// of it is unit-tested.
//
// A request is a new message from a person that either mentions the bot (`app_mention`, in any
// channel the bot was added to) or is sent to the bot directly (`message.im`). Each requester has
// a private answer, box, session and sealed context within the thread. session.mjs derives the key
// from workspace, channel and parent message, plus the requester for channels.

// Subtypes of a person writing something new; every other one (edits, deletions, joins, bot posts…)
// is not a request.
const NEW_MESSAGE = new Set([undefined, 'file_share', 'thread_broadcast'])
const ID = /^[A-Z0-9]+$/
const TS = /^\d+\.\d+$/
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * The request in one Events API payload, or null. `bot` is the bot's own identity (auth.test): no
 * bot's message counts, its own least of all, and neither does an edit — an edit isn't a new
 * request (and edits re-deliver `app_mention` for old messages); asking again means a new message.
 */
export function requestFromEvent(payload, bot) {
  const e = payload?.event
  if (!e || !(e.type === 'app_mention' || (e.type === 'message' && e.channel_type === 'im'))) return null
  if (!NEW_MESSAGE.has(e.subtype) || e.edited || e.bot_id || !e.user || e.user === bot.userId) return null
  // The ids become box names and volume paths: anything else than Slack's own formats is refused.
  if (![payload.team_id, e.channel, e.user].every((v) => ID.test(v ?? '')) || !TS.test(e.ts ?? '') || (e.thread_ts && !TS.test(e.thread_ts))) return null
  return {
    id: `${e.channel}:${e.ts}`, // one message is one request, whichever event brought it
    team: payload.team_id,
    channel: e.channel,
    ts: e.ts,
    threadTs: e.thread_ts || e.ts, // a top-level message starts a new session for this requester
    isDM: e.channel_type === 'im' || e.channel.startsWith('D'),
    user: e.user,
    text: e.text ?? '',
    files: (e.files ?? []).map((f) => ({ id: f.id, name: f.name || f.title || f.id, mimetype: f.mimetype ?? '', size: f.size ?? 0, url: f.mode === 'external' ? null : (f.url_private_download ?? null) })),
    extShared: Boolean(payload.is_ext_shared_channel), // a Slack Connect channel: people from another organization are in it
  }
}

/** `@bot help` — or `help` alone in a DM — is answered by the controller itself, no box. */
export function isHelp(text, bot) {
  const rest = String(text || '').replace(new RegExp(`<@${escapeRe(bot.userId)}(\\|[^>]*)?>`, 'g'), '')
  return /^\s*\/?help[.!?]*\s*$/i.test(rest)
}

/** /link is a Slack member command, including without a mention in a DM. */
export function linkCommand(req, bot) {
  const text = req.text.trim().replace(new RegExp(`^<@${escapeRe(bot.userId)}(\\|[^>]*)?>\\s*`), '')
  if (!req.isDM && text === req.text.trim()) return null
  return /^\/link(?:\s|$)/i.test(text) ? text.slice(5).trim().toLowerCase() : null
}

/** The name a person goes by in the workspace. */
export const displayName = (user) => user?.profile?.display_name || user?.real_name || user?.name || user?.id || 'someone'

/**
 * The words a new thread's box is named by (session.mjs boxName): where — "dm", or the channel's
 * name when Slack tells us — who asked first, and the day the thread began (UTC). E.g.
 * "dm-alice-0922", "backend-bob-0922".
 */
export function threadLabel(req, { asker, channel = '' } = {}) {
  const day = new Date(Number(req.threadTs.split('.')[0]) * 1000).toISOString().slice(5, 10).replace('-', '')
  const who = asker?.name || displayName(asker) // the handle first: it's usually plain letters
  return [req.isDM ? 'dm' : channel, who, day].filter(Boolean).join('-')
}

/** Every user id mentioned (<@U123>) in some Slack texts. */
export const mentionedIds = (...texts) => [...new Set(texts.flatMap((t) => [...String(t ?? '').matchAll(/<@([A-Z0-9]+)(?:\|[^>]*)?>/g)].map((m) => m[1])))]

/**
 * Slack markup → plain text: <@U1> → @name (names: user id → name), <#C1|general> → #general,
 * <!here> → @here, <https://x|label> → label (https://x), then &lt; &gt; &amp; unescaped — in that
 * order, since a literal "<" arrives as "&lt;" and must not be read as markup.
 */
export function plainText(text, names = new Map()) {
  return String(text ?? '')
    .replace(/<([^<>]+)>/g, (_, inner) => {
      const bar = inner.indexOf('|')
      const [target, label] = bar < 0 ? [inner, null] : [inner.slice(0, bar), inner.slice(bar + 1)]
      if (target.startsWith('@')) return `@${names.get(target.slice(1)) ?? label ?? target.slice(1)}`
      if (target.startsWith('#')) return `#${label ?? target.slice(1)}`
      if (target.startsWith('!')) return label ?? `@${target.slice(1).split('^')[0]}` // <!here>, <!subteam^S1|@devs>, <!date^…|Jan 1>
      if (target.startsWith('mailto:')) return label ?? target.slice(7)
      return label && label !== target ? `${label} (${target})` : target
    })
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
}

/** One message of a thread as the prompt shows it: who wrote it — you, a person or an app — and what. */
export function threadLine(m, names, bot) {
  const who =
    m.user === bot.userId || (m.bot_id && m.bot_id === bot.botId) ? `@${bot.name} (you)`
      : m.user ? `@${names.get(m.user) ?? m.user}`
        : `${m.bot_profile?.name ?? m.username ?? 'an app'} (app)`
  const files = (m.files ?? []).map((f) => `[file: ${f.name || f.title || 'untitled'}]`)
  return { ts: m.ts, who, text: [plainText(m.text, names), ...files].filter(Boolean).join('\n') }
}

/** Slack timestamps ("1712345678.000100") compared as numbers — too many digits for a double. */
export const tsBefore = (a, b) => a.padStart(24, '0') < b.padStart(24, '0')

/** A link to the request message (workspaceUrl from auth.test, e.g. https://acme.slack.com/). */
export function permalink(workspaceUrl, req) {
  const url = `${workspaceUrl.replace(/\/*$/, '/')}archives/${req.channel}/p${req.ts.replace('.', '')}`
  return req.threadTs === req.ts ? url : `${url}?thread_ts=${req.threadTs}&cid=${req.channel}`
}

/**
 * Which of a request's files go into the box, and where: `take` [{ file, path }] under
 * slack-files/<message ts>/ in the thread's working directory, `skip` [{ name, why }] for the
 * rest — too many, too large (by the size Slack reports; the download enforces it again), or not
 * hosted by Slack (a Google Drive link, say).
 */
export function attachmentPlan(files, { ts, maxFiles = 10, maxFileBytes, maxTotalBytes }) {
  const take = []
  const skip = []
  const used = new Set()
  let total = 0
  for (const [i, f] of files.entries()) {
    const name = safeName(f.name, f.id)
    if (i >= maxFiles) skip.push({ name, why: `only the first ${maxFiles} files of a message are read` })
    else if (!f.url) skip.push({ name, why: "it isn't a file Slack hosts" })
    else if (f.size > maxFileBytes) skip.push({ name, why: `larger than ${size(maxFileBytes)}` })
    else if (total + f.size > maxTotalBytes) skip.push({ name, why: `the message's files add up to more than ${size(maxTotalBytes)}` })
    else {
      total += f.size
      let unique = name
      for (let n = 2; used.has(unique); n++) unique = `${n}-${name}`
      used.add(unique)
      take.push({ file: f, path: `slack-files/${ts}/${unique}` })
    }
  }
  return { take, skip }
}

/** A file name that is safe as one path segment: its last part, tame characters only, no leading dot. */
function safeName(name, fallback) {
  const base = String(name ?? '').split(/[\\/]/).filter(Boolean).pop() ?? ''
  const s = base.replace(/[^\w.\- ]+/g, '_').replace(/^[.\s]+/, '').trim().slice(0, 100)
  return s || `file-${fallback ?? 'unnamed'}`
}

export const size = (n) => (n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : n >= 1024 ? `${Math.round(n / 1024)} KB` : `${n} bytes`)
