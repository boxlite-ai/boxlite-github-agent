// Slack: the bot's second place to be asked, beside GitHub. A Socket Mode connection the
// controller dials out (slack-socket.mjs) brings each message that mentions the bot, or is sent to
// it directly; each becomes one Codex turn in that thread's own box, and the answer goes back in
// the thread. Who may ask is decided here, by the workspace's rules (policy.mjs: members only),
// before any box starts; the team's tools come with every turn, since everyone who can ask may
// read what the bot's accounts read.
//
// A Slack thread lives apart from GitHub ones (session.mjs: `slack`): its own boxes, volume and
// context key. Its memory is state.slack — handled messages, each thread's Codex session, daily
// usage, and requests kept for the next controller when this one is shutting down (Slack pushes an
// event once; a restart must not drop it).
import { slack } from './slack.mjs'
import { socketMode } from './slack-socket.mjs'
import { requestFromEvent, isHelp, displayName, threadLabel, mentionedIds, plainText, threadLine, tsBefore, permalink, attachmentPlan, size } from './slack-events.mjs'
import { react, reply, say, whisper, tally } from './slack-reply.mjs'
import { mayUseSlack } from './policy.mjs'
import { enabledServices } from './tools.mjs'
import { takeQuota } from './state.mjs'
import { runTurn, slackThreadKey, boxName } from './session.mjs'
import { slackSessionPrompt, slackFollowUpPrompt } from './codex.mjs'

/**
 * `tokens` { bot, app } are the Slack app's (xoxb-, xapp-). The rest is the controller's: `slackState`
 * is state.slack; `track(promise)` counts a running turn, so a shutdown waits for it; `draining()`
 * says the controller is on its way out; `turnCfg()` the config a turn runs on right now (/model).
 */
export async function slackChannel({ tokens, cfg, slackState, persist, schedule, track, draining, jobs, bl, proxyUrl, logins, policy, turnCfg, status, log }) {
  const sk = slack(tokens.bot)
  // Who we are is whoever the bot token belongs to: its bot user is the one people mention.
  const me = await sk.call('auth.test')
  const bot = { userId: me.user_id, botId: me.bot_id, name: me.user, teamId: me.team_id, teamName: me.team, enterpriseId: me.enterprise_id ?? null, url: me.url }
  /** How long a quiet thread keeps its box, in words: "15 minutes", "2 hours", "3 days". */
  const ttl = ((m) => (m % 1440 === 0 ? `${m / 1440} day${m === 1440 ? '' : 's'}` : m % 60 === 0 ? `${m / 60} hour${m === 60 ? '' : 's'}` : `${m} minute${m === 1 ? '' : 's'}`))(Math.max(1, Math.round(cfg.boxDeleteSec / 60)))

  /** Slack users (users.info), kept for an hour: names for the prompt, and who someone is (mayUseSlack). */
  const people = new Map()
  function person(id) {
    const hit = people.get(id)
    if (hit && Date.now() - hit.at < 3_600_000) return hit.user
    const user = sk.call('users.info', { user: id }).then((r) => r.user)
    people.set(id, { at: Date.now(), user })
    user.catch(() => people.delete(id))
    return user
  }
  /** A channel's name, for its threads' box names — '' when Slack won't say (that takes channels:read, groups:read). */
  const channelNames = new Map()
  function channelName(id) {
    if (!channelNames.has(id)) channelNames.set(id, sk.call('conversations.info', { channel: id }).then((r) => r.channel?.name ?? '', () => ''))
    return channelNames.get(id)
  }
  /** User id → display name, for everyone given; someone Slack won't tell us about keeps their id. */
  async function namesOf(ids) {
    const unique = [...new Set(ids.filter((id) => id && id !== bot.userId))].slice(0, 50)
    const names = await Promise.all(unique.map((id) => person(id).then(displayName, () => id)))
    return new Map([[bot.userId, bot.name], ...unique.map((id, i) => [id, names[i]])])
  }

  /**
   * What was said in the thread before the request, as the prompt shows it: for a new session its
   * first message and the latest 30, for a follow-up what others said since the bot's last turn.
   * Best effort — without it (a scope missing, Slack throttling) the request is still answered.
   */
  async function transcript(req, sinceTs) {
    if (!sinceTs && req.threadTs === req.ts) return [] // the request starts the thread
    const messages = []
    try {
      for (let cursor, page = 0; page < 5; page++) {
        const r = await sk.call('conversations.replies', { channel: req.channel, ts: req.threadTs, limit: 200, oldest: sinceTs, cursor })
        messages.push(...(r.messages ?? []))
        cursor = r.response_metadata?.next_cursor
        if (!r.has_more || !cursor) break
      }
    } catch (e) {
      log(`${slackThreadKey(req)}: no thread history: ${e.message}`)
      return []
    }
    const mine = (m) => m.user === bot.userId || (m.bot_id && m.bot_id === bot.botId)
    const before = messages.filter((m) => tsBefore(m.ts, req.ts) && (!sinceTs || (tsBefore(sinceTs, m.ts) && !mine(m))))
    const kept = sinceTs ? before.slice(-30) : before.length <= 31 ? before : [before[0], ...before.slice(-30)]
    const names = await namesOf(kept.flatMap((m) => [m.user, ...mentionedIds(m.text)]))
    return kept.map((m) => threadLine(m, names, bot))
  }

  /** The request's files that go into the box, and a word on those that don't — best effort too. */
  async function attachments(req) {
    const plan = attachmentPlan(req.files, { ts: req.ts, maxFileBytes: cfg.maxFileBytes, maxTotalBytes: cfg.maxFilesBytes })
    const saved = []
    const skipped = [...plan.skip]
    let total = 0
    for (const { file, path: where } of plan.take) {
      try {
        const data = await sk.download(file.url, { maxBytes: cfg.maxFileBytes, mimetype: file.mimetype })
        if ((total += data.length) > cfg.maxFilesBytes) throw new Error(`the message's files add up to more than ${size(cfg.maxFilesBytes)}`)
        saved.push({ path: where, size: data.length, mimetype: file.mimetype, data: data.toString('base64') })
      } catch (e) {
        skipped.push({ name: file.name, why: `not downloaded: ${e.message.slice(0, 160)}` })
      }
    }
    return { saved, skipped }
  }

  /** One turn with its own job token (see the controller's turn()); `job` is its record — who asked, what it changed. */
  async function turn(key, label, prompt, sessionId, files, services, job) {
    const jobToken = jobs.issue(12 * 3_600_000, key, job)
    try {
      const run = turnCfg()
      log(`${key}: turn in ${boxName(key, { slack: true, label })} on ${run.model ?? "Codex's default model"}${run.effort ? `, ${run.effort} effort` : ''}`)
      return await runTurn({ bl, cfg: run, key, label, prompt, files, tools: services, sessionId, jobToken, proxyUrl, slack: true, log })
    } finally {
      jobs.revoke(jobToken)
    }
  }

  async function handle(req) {
    const key = slackThreadKey(req)
    try {
      const known = slackState.threads[key]?.sessionId ? slackState.threads[key] : null
      const [asker, files, names] = await Promise.all([person(req.user), attachments(req), namesOf(mentionedIds(req.text)), Promise.all(Object.values(logins).map((l) => l.load()))])
      const services = enabledServices(logins, policy)
      const talk = { bot: bot.name, workspace: bot.teamName, place: req.isDM ? 'a direct message' : 'a channel', permalink: permalink(bot.url, req), asker: displayName(asker), text: plainText(req.text, names), files, ttl, services }
      const job = { who: `${talk.asker} (${req.user})`, writes: [], tools: services.map((s) => s.name) } // what its token opens
      const fresh = async () => slackSessionPrompt({ ...talk, history: await transcript(req) })
      const prompt = known ? slackFollowUpPrompt({ ...talk, since: await transcript(req, known.lastTs) }) : await fresh()
      // The thread's box keeps the name it got first, whoever asks now and whatever the channel is called.
      const label = slackState.threads[key]?.label ?? threadLabel(req, { asker, channel: req.isDM ? '' : await channelName(req.channel) })
      let out = await turn(key, label, prompt, known?.sessionId, files.saved, services, job)
      if (out.sessionLost) {
        log(`${key}: session ${known.sessionId} is gone; starting over with the whole thread`)
        out = await turn(key, label, await fresh(), null, files.saved, services, job)
      }
      slackState.threads[key] = { sessionId: out.sessionId ?? null, lastTs: req.ts, lastUsed: new Date().toISOString(), label }
      persist()
      await req.ack // the 👀 always lands before the answer
      if (out.message) {
        await reply(sk, req, out.message, { changes: job.writes })
        log(`${key}: answered ${talk.asker}${job.writes.length ? `, changed: ${tally(job.writes)}` : ''}`)
      } else {
        log(`${key}: no answer — ${out.error}`)
        const changed = job.writes.length ? `\nIt did make changes before it stopped, as the bot: ${tally(job.writes)}.` : ''
        await say(sk, req, `<@${req.user}> sorry, I couldn't finish this one — the run failed on my side. Please try again in a bit.${changed}`)
      }
    } catch (e) {
      log(`${key}: ${e.stack || e.message}`)
      await say(sk, req, `<@${req.user}> sorry, something went wrong on my side. Please try again in a bit.`).catch(() => {})
    }
  }

  function helpText(req) {
    const today = new Date().toISOString().slice(0, 10)
    const used = slackState.usage[req.user]?.day === today ? slackState.usage[req.user].count : 0
    return [
      `I'm a coding agent. Ask me a question or give me a task and I work on it in my own isolated <https://boxlite.ai|BoxLite> microVM — a full shell and network, so I run things before I answer — then reply in the thread.`,
      '',
      `• \`@${bot.name} <question or task>\` in a channel I'm in, or message me directly`,
      `• follow up in the same thread${req.isDM ? '' : ' (mention me again)'}: I remember it, and its files stay on my machine until it's been quiet for ${ttl}`,
      `• attach files — logs, screenshots, code — and I get them too (up to ${size(cfg.maxFilesBytes)} a message)`,
      `• \`@${bot.name} help\` — this message`,
      ...(cfg.slackDailyLimit ? ['', `You have ${Math.max(0, cfg.slackDailyLimit - used)} of ${cfg.slackDailyLimit} requests left today (resets at 00:00 UTC).`] : []),
    ].join('\n')
  }

  async function accept(req, via) {
    if (slackState.seen.has(req.id)) return // Slack redelivers: one message is one request
    if (draining()) {
      // Slack won't send it again: keep it for the next controller, which starts with it.
      if (!slackState.deferred.some((d) => d.id === req.id)) slackState.deferred.push(req)
      return persist()
    }
    slackState.seen.add(req.id) // at most once: a crash mid-run must not produce a second reply later
    persist()
    const key = slackThreadKey(req)
    const user = await person(req.user)
    const who = `${displayName(user)} (${req.user})`
    const access = mayUseSlack(user, { teamId: bot.teamId, enterpriseId: bot.enterpriseId }, { extShared: req.extShared })
    if (!access.ok) {
      log(`${key}: ${who} refused — ${access.why}`)
      return whisper(sk, req, `Sorry, I can't take requests from you: ${access.why}.`).catch((e) => log(`${key}: ${e.message}`))
    }
    if (isHelp(req.text, bot)) {
      log(`${key}: help for ${who}`)
      return say(sk, req, helpText(req))
    }
    if (cfg.slackDailyLimit && !takeQuota(slackState, req.user, cfg.slackDailyLimit)) {
      log(`${key}: ${who} is over today's limit`)
      return whisper(sk, req, `You've reached today's limit of ${cfg.slackDailyLimit} requests — it resets at 00:00 UTC.`).catch((e) => log(`${key}: ${e.message}`))
    }
    log(`${key}: request from ${who} via ${via}`)
    // 👀 the moment we have it — not queued behind other turns; the reply waits for it (handle()).
    req.ack = react(sk, req).catch((e) => log(`${key}: 👀 reaction failed: ${e.message}`))
    track(schedule(key, () => handle(req)))
  }

  /** Requests are accepted one at a time, in the order Slack sent them. */
  let accepting = Promise.resolve()
  function enqueue(req, via = 'slack') {
    accepting = accepting.then(() => accept(req, via)).catch((e) => {
      log(`${req.id}: ${e.stack || e.message}`)
      say(sk, req, `<@${req.user}> sorry, something went wrong on my side. Please try again in a bit.`).catch(() => {})
    })
  }

  const socket = socketMode({
    open: () => slack(tokens.app).call('apps.connections.open'),
    onEvent: (payload) => {
      const req = requestFromEvent(payload, bot)
      if (req) enqueue(req)
    },
    onStatus: (line) => status(line && `slack: ${line}`, 'slack-socket'),
    log,
  })

  return {
    bot,
    start() {
      socket.start()
      const kept = slackState.deferred.splice(0)
      for (const req of kept) enqueue(req, 'the last controller')
      if (kept.length) persist()
    },
    /** Requests already being accepted, which may still start turns: a shutdown waits for these first. */
    settle: () => accepting,
    stop: () => socket.stop(),
    get live() {
      return socket.live
    },
  }
}
