// Who may make a turn publish (open or update a PR), and the controller's own commands. Pure —
// no I/O except the user lookup `/add` is handed — so all of it is unit-tested.
//
// A turn may publish when its requester is one of the bot's admins (BOT_ADMINS, anywhere), a
// maintainer of the repo (GitHub's author_association on their comment), or someone an admin
// added for that repo with `/add`. Commands are parsed here, never by Codex: a model that read
// them could be talked into "granting" access. People are keyed by numeric GitHub id — a login
// can be renamed and re-registered by someone else, who would inherit a grant made to the name.
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const LOGIN = /^[a-z\d](?:[a-z\d]|-(?=[a-z\d])){0,38}$/i
const MAINTAINER = new Set(['OWNER', 'MEMBER', 'COLLABORATOR'])

/** Every command, once: the parser and the help reply both read this table. */
export const COMMANDS = [
  { name: 'help', admin: false, usage: '/help', does: 'this list' },
  { name: 'add', admin: true, usage: '/add @user', does: 'let @user ask me for PRs in this repo' },
  { name: 'remove', admin: true, usage: '/remove @user', does: 'take that back' },
  { name: 'list', admin: true, usage: '/list', does: 'who can ask me for PRs in this repo' },
  { name: 'pause', admin: true, usage: '/pause', does: 'stop all PR writing, everywhere' },
  { name: 'resume', admin: true, usage: '/resume', does: 'start it again' },
]

/**
 * A comment that starts with `@login /word …` is a command; so is one that is only `@login help`
 * (not "@login help me fix this", which is a request). A command word is `/` plus letters, then a
 * space or the end, so "@login /usr/bin/node crashes" still reaches Codex. An unknown word is
 * returned as `{ unknown }`, so it gets the help text instead of falling through to the model.
 * @returns {null | { name: string, arg: string } | { unknown: string }}
 */
export function parseCommand(body, login) {
  const text = String(body || '').trim()
  const lead = new RegExp(`^@${escapeRe(login)}(?![\\w-])\\s*`, 'i').exec(text)
  if (!lead) return null
  const rest = text.slice(lead[0].length)
  if (/^help[.!?]*$/i.test(rest)) return { name: 'help', arg: '' }
  const m = /^\/([a-z]+)(?=\s|$)[ \t]*([^\n]*)/i.exec(rest)
  if (!m) return null
  const name = m[1].toLowerCase()
  return COMMANDS.some((c) => c.name === name) ? { name, arg: m[2].trim() } : { unknown: name }
}

const repoKey = (repo) => repo.toLowerCase()

/**
 * May this request publish? `ready` is false while the bot has no GitHub App to push with.
 * @returns {{ ok: boolean, why: string }} `why` is shown to the requester (help) and to Codex.
 */
export function writeAccess({ state, admins, req, ready = true }) {
  if (!ready) return { ok: false, why: "PR writing isn't set up on this bot" }
  if (state.paused) return { ok: false, why: `an admin (@${state.paused.by}) paused PR writing` }
  if (admins.has(req.userId)) return { ok: true, why: "you're an admin of this bot" }
  if (MAINTAINER.has(req.association)) return { ok: true, why: "you're a maintainer here" }
  const grant = state.grants?.[repoKey(req.repo)]?.[req.userId]
  if (grant) return { ok: true, why: `@${grant.by} added you` }
  return { ok: false, why: 'only maintainers of this repo and people an admin added can' }
}

/** The help reply, for this person in this repo: what they can do, and whether PRs are open to them. */
export function helpText({ login, req, access, isAdmin, left, limit }) {
  const lines = [
    `@${req.author} mention me with a question or a task — I run the code in an isolated [BoxLite](https://boxlite.ai) box and answer here.`,
    '',
    `- \`@${login} <question or task>\` — ask anything about this repo`,
    `- \`@${login} /help\` — this list`,
    '',
    access.ok
      ? `**PRs:** you can ask me to open or update PRs in ${req.repo} (${access.why}). They're drafts from my fork, one commit per request.`
      : `**PRs:** you can't ask me for PRs in ${req.repo}: ${access.why}.`,
  ]
  if (isAdmin) {
    lines.push('', '**Admin:**')
    for (const c of COMMANDS.filter((x) => x.admin)) lines.push(`- \`@${login} ${c.usage}\` — ${c.does}`)
  }
  lines.push('', `${Math.max(0, left)} of ${limit} requests left today (resets at 00:00 UTC).`)
  return lines.join('\n')
}

/**
 * Carry out a command; returns the reply text. Admin commands count only in a comment that was
 * never edited: anyone with write access to a repo can edit other people's comments there, so an
 * edited comment is not proof of what its author wrote. `lookup(login)` → { id, login } | null.
 */
export async function runCommand(cmd, { state, admins, req, login, lookup, access, left, limit, now = new Date() }) {
  const help = () => helpText({ login, req, access, isAdmin: admins.has(req.userId), left, limit })
  if (cmd.unknown) return `I don't know \`/${cmd.unknown}\`.\n\n${help()}`
  if (cmd.name === 'help') return help()
  const who = `@${req.author}`
  if (!admins.has(req.userId)) return `${who} only this bot's admins can use \`/${cmd.name}\`.`
  if (req.kind === 'body' || req.edited) return `${who} admin commands only count in a new comment that was never edited — please post it again as a fresh comment.`

  const at = now.toISOString()
  const grants = (state.grants ??= {})
  const here = grants[repoKey(req.repo)] ?? {}
  if (cmd.name === 'pause') {
    state.paused = { by: req.author, at }
    return `${who} ⏸️ PR writing is paused everywhere. \`@${login} /resume\` turns it back on.`
  }
  if (cmd.name === 'resume') {
    state.paused = null
    return `${who} ▶️ PR writing is back on.`
  }
  if (cmd.name === 'list') {
    const people = Object.values(here).map((g) => `- @${g.login} — added by @${g.by} on ${g.at.slice(0, 10)}`)
    return `${who} besides this repo's maintainers and the bot's admins, ${people.length ? `these people can ask me for PRs in ${req.repo}:\n\n${people.join('\n')}` : `nobody else can ask me for PRs in ${req.repo}.`}`
  }
  const name = cmd.arg.replace(/^@/, '').split(/\s+/)[0]
  if (!LOGIN.test(name)) return `${who} usage: \`@${login} /${cmd.name} @user\``
  const user = await lookup(name)
  if (!user) return `${who} there's no GitHub user @${name}.`
  if (cmd.name === 'add') {
    here[user.id] = { login: user.login, by: req.author, at }
    grants[repoKey(req.repo)] = here
    return `${who} ✅ @${user.login} can now ask me for PRs in ${req.repo}.`
  }
  if (!here[user.id]) return `${who} @${user.login} wasn't on the list for ${req.repo}.`
  delete here[user.id]
  return `${who} ✅ @${user.login} can no longer ask me for PRs in ${req.repo}.`
}
