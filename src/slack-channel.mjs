// Slack: the bot's second place to be asked, beside GitHub. A Socket Mode connection the
// controller dials out (slack-socket.mjs) brings mentions, DMs and subscribed thread follow-ups;
// each becomes one Codex turn in that thread's own box, and the answer goes back in
// the thread. Who may ask is decided here, by the workspace's rules (policy.mjs: members only),
// before any box starts. Personal service logins are available only in DMs. A turn may also open
// a draft PR into a repo policy.mjs allows (asked for by its box when the work is done: prgrant.mjs),
// and the workspace's admins run the bot's commands (`@bot /model`, `/deploy`, `/pause`…).
//
// A Slack thread lives apart from GitHub ones (session.mjs: `slack`): its own boxes, volume and
// context key. Its memory is state.slack — handled messages, each thread's Codex session, daily
// usage, saved tasks, and requests kept for the next controller when this one is shutting down
// (Slack pushes an event once; a restart must not drop it).
import { slack } from './slack.mjs'
import { slackTools, slackService } from './slack-tools.mjs'
import { slackTasks } from './slack-tasks.mjs'
import { socketMode } from './slack-socket.mjs'
import { requestFromEvent, isHelp, displayName, threadLabel, mentionedIds, plainText, threadLine, tsBefore, permalink, attachmentPlan, size } from './slack-events.mjs'
import { react, reply, say, whisper, tally } from './slack-reply.mjs'
import { mayUseSlack, isSlackAdmin, slackPrAllowed, prTargets } from './policy.mjs'
import { parseCommand } from './access.mjs'
import { pushFailure } from './publish.mjs'
import { enabledServices } from './tools.mjs'
import { takeQuota } from './state.mjs'
import { runTurn, slackThreadKey, boxName } from './session.mjs'
import { slackSessionPrompt, slackFollowUpPrompt } from './codex.mjs'

/**
 * `tokens` { bot, app } are the Slack app's (xoxb-, xapp-). The rest is the controller's: `slackState`
 * is state.slack; `track(promise)` counts a running turn, so a shutdown waits for it; `draining()`
 * says the controller is on its way out; `turnCfg()` the config a turn runs on right now (/model).
 * `prs`: { status() → { ok, why, repos }, plan({ repo, base, id }), publish(plan, result) → a line }
 * — the controller's GitHub side of a PR. `commands.run(cmd, { isAdmin, who, by, reply, help, post })`
 * runs a command on the controller's state and posts its answer (then restarts, for a /deploy).
 */
export async function slackChannel({ tokens, cfg, slackState, persist, schedule, track, draining, jobs, bl, proxyUrl, userLogins, policy, turnCfg, status, log, prs, commands }) {
  const sk = slack(tokens.bot)
  // Who we are is whoever the bot token belongs to: its bot user is the one people mention.
  const me = await sk.call('auth.test')
  const bot = { userId: me.user_id, botId: me.bot_id, name: me.user, teamId: me.team_id, teamName: me.team, enterpriseId: me.enterprise_id ?? null, url: me.url }
  const work = new Map() // thread → queued and running requests, each cancellable
  const contexts = new Map() // current Agent View context, keyed by user and expiring after an hour
  const tasks = slackTasks({
    state: slackState, persist, track, draining, log,
    run: (req) => scheduleRequest(req),
    stopRun: (task) => {
      for (const entry of work.get(slackThreadKey(task)) ?? []) if (entry.req.task?.id === task.id) entry.abort.abort()
    },
  })
  let agentUi = true
  async function sessionStatus(req, value) {
    if (!agentUi) return
    try { await sk.call('agents.sessions.setStatus', { channel_id: req.channel, thread_ts: req.threadTs, status: value }) }
    catch (e) {
      if (['missing_scope', 'unknown_method', 'feature_not_enabled'].includes(e.code)) agentUi = false
      log(`Slack agent status: ${e.code ?? e.message}`)
    }
  }
  function scheduleRequest(req) {
    const key = slackThreadKey(req)
    const entry = { req, abort: new AbortController() }
    if (!work.has(key)) work.set(key, new Set())
    work.get(key).add(entry)
    return schedule(key, () => handle(req, entry.abort.signal)).finally(() => {
      work.get(key)?.delete(entry)
      if (!work.get(key)?.size) work.delete(key)
    })
  }
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
  async function turn(key, label, prompt, sessionId, files, services, job, signal) {
    signal.throwIfAborted()
    const jobToken = jobs.issue(12 * 3_600_000, key, job)
    const revoke = () => jobs.revoke(jobToken)
    signal.addEventListener('abort', revoke, { once: true })
    try {
      const run = turnCfg()
      log(`${key}: turn in ${boxName(key, { slack: true, label })} on ${run.model ?? "Codex's default model"}${run.effort ? `, ${run.effort} effort` : ''}`)
      return await runTurn({ bl, cfg: run, key, label, prompt, files, tools: services, sessionId, jobToken, proxyUrl, slack: true, prs: Boolean(job.pr), signal, log })
    } finally {
      signal.removeEventListener('abort', revoke)
      revoke()
      // A tool write already accepted before Stop may still finish. Collect its result/audit
      // before reporting the stopped turn; queued calls now fail their live-token checks.
      await job.slack?.queue
      await job.slack?.record?.() // also persist changes made through external MCP services
    }
  }

  /**
   * A turn's box asks for its PR's push (prgrant.mjs): the rules are checked again now — an admin
   * may have paused PR writing meanwhile — and the repo must be one policy.mjs allows. Granted,
   * the job may push exactly the plan's staging ref (gitpush.mjs), and nothing else.
   */
  async function grantPr({ repo, base }, job, id) {
    const now = await prs.status()
    if (!now.ok) throw new Error(now.why)
    if (!slackPrAllowed(repo, now.repos)) throw new Error(`I may open PRs only into ${prTargets(now.repos)}`)
    const plan = await prs.plan({ repo, base, id })
    job.pr.plan = plan
    job.push = { ref: `refs/heads/${plan.staging}`, open: () => plan.open() }
    return { ref: job.push.ref }
  }

  /** What became of the turn's PR, for under its answer — null when it asked for none. */
  async function prOutcome(job, push) {
    if (job.pr?.plan) return prs.publish(job.pr.plan, push).catch((e) => `⚠️ Couldn't open the PR: ${e.message.slice(0, 200)}`)
    if (push?.refused) return `⚠️ No PR: ${push.refused}.`
    if (push?.error) return `⚠️ No PR: ${pushFailure(push.error)}.`
    return null
  }

  async function handle(req, signal) {
    const key = slackThreadKey(req)
    let job
    let showingStatus = false
    try {
      signal.throwIfAborted()
      if (req.task) {
        if (slackState.tasks[req.task.id]?.status !== 'enabled') return { error: 'Task is not enabled.' }
        const { user } = await sk.call('users.info', { user: req.user })
        const access = mayUseSlack(user, { teamId: bot.teamId, enterpriseId: bot.enterpriseId }, { extShared: false })
        if (!access.ok) throw new Error(access.why)
        // Revalidate channel membership and Slack Connect on every background run.
        if (!req.isDM) await slackTools({ sk, req, bot }).find((t) => t.name === 'channel_info').run({ channel: req.channel }, () => signal.throwIfAborted())
        if (cfg.slackDailyLimit && !takeQuota(slackState, req.user, cfg.slackDailyLimit)) throw new Error('Task owner reached the daily request limit.')
      }
      signal.throwIfAborted()
      await sessionStatus(req, 'processing')
      showingStatus = true
      const known = slackState.threads[key]?.sessionId ? slackState.threads[key] : null
      // Personal service logins are available only in DMs; Slack tools use the bot identity.
      const [asker, files, names, userLog] = await Promise.all([person(req.user), attachments(req), namesOf(mentionedIds(req.text)), userLogins.forUser(req.user)])
      const tools = slackTools({ sk, req, bot, tasks })
      const services = [...(req.isDM ? enabledServices(userLog, policy) : []), slackService(tools)]
      const linkable = req.isDM ? Object.keys(userLogins.kinds).filter((name) => !userLog[name]?.ready()) : []
      const dmForTools = !req.isDM && Object.values(userLog).some((l) => l.ready())
      const prsNow = req.task ? { ok: false, why: 'background tasks cannot publish PRs' } : await prs.status()
      const talk = { bot: bot.name, workspace: bot.teamName, place: req.isDM ? 'a direct message' : 'a channel', permalink: permalink(bot.url, req), asker: displayName(asker), text: plainText(req.text, names), files, ttl, services, linkable, dmForTools, prs: prsNow,
        slackContext: { channel: req.channel, thread_ts: req.threadTs, user: req.user, time: new Date().toISOString(),
          viewed_channel: req.isDM && Date.now() - (contexts.get(req.user)?.at ?? 0) < 3_600_000 ? contexts.get(req.user).channel : null,
          task: req.task ?? null },
      }
      job = { who: `${talk.asker} (${req.user})`, writes: [], tools: services.map((s) => s.name), logins: req.isDM ? userLog : {} } // what its token opens
      job.slack = { tools, record: () => tasks.record(req, job.writes) }
      // A PR is planned only when the box asks for it, for the request's own branch (publish.mjs).
      if (prsNow.ok) job.pr = { grant: (want) => grantPr(want, job, `${key}@${req.ts}`) }
      const fresh = async () => slackSessionPrompt({ ...talk, history: await transcript(req) })
      const prompt = known ? slackFollowUpPrompt({ ...talk, since: await transcript(req, known.lastTs) }) : await fresh()
      // The thread's box keeps the name it got first, whoever asks now and whatever the channel is called.
      const label = slackState.threads[key]?.label ?? threadLabel(req, { asker, channel: req.isDM ? '' : await channelName(req.channel) })
      let out = await turn(key, label, prompt, known?.sessionId, files.saved, services, job, signal)
      if (out.sessionLost && !signal.aborted) {
        log(`${key}: session ${known.sessionId} is gone; starting over with the whole thread`)
        out = await turn(key, label, await fresh(), null, files.saved, services, job, signal)
      }
      signal.throwIfAborted()
      slackState.threads[key] = { ...slackState.threads[key], sessionId: out.sessionId ?? null, lastTs: req.task ? (known?.lastTs ?? req.threadTs) : req.ts, lastUsed: new Date().toISOString(), label }
      persist()
      const pr = await prOutcome(job, out.push) // after the turn: its job token is revoked, nothing moves the branch now
      if (pr) log(`${key}: ${pr}`)
      await req.ack // the 👀 always lands before the answer
      if (out.message === 'NO_REPLY') {
        if (job.writes.length) await say(sk, req, `Completed task actions: ${tally(job.writes)}.`)
      } else if (out.message) {
        await reply(sk, req, pr ? `${out.message}\n\n${pr}` : out.message, { changes: job.writes })
        log(`${key}: answered ${talk.asker}${job.writes.length ? `, changed: ${tally(job.writes)}` : ''}`)
      } else {
        log(`${key}: no answer — ${out.error}`)
        const changed = job.writes.length ? `\nIt did make changes before it stopped, as the bot: ${tally(job.writes)}.` : ''
        await say(sk, req, `<@${req.user}> sorry, I couldn't finish this one — the run failed on my side.${req.task ? ' The saved task has been paused.' : ' Please try again in a bit.'}${changed}${pr ? `\n${pr}` : ''}`)
      }
      return { message: out.message, error: out.error || (!out.message ? 'Run produced no answer.' : undefined) }
    } catch (e) {
      const changed = job?.writes.length ? ` Changes already made: ${tally(job.writes)}.` : ''
      if (signal.aborted) {
        if (changed) await say(sk, req, `Stopped.${changed}`).catch(() => {})
        return { error: 'Stopped by the user.' }
      }
      log(`${key}: ${e.stack || e.message}`)
      await say(sk, req, `<@${req.user}> I couldn't finish this run.${changed}${req.task ? ' The saved task has been paused.' : ' Please try again in a bit.'}`).catch(() => {})
      return { error: req.task ? e.message : 'Run failed.' }
    } finally {
      if (showingStatus) await sessionStatus(req, 'active')
    }
  }

  async function helpText(req, user) {
    const today = new Date().toISOString().slice(0, 10)
    const used = slackState.usage[req.user]?.day === today ? slackState.usage[req.user].count : 0
    const now = await prs.status()
    return [
      `I'm a coding agent. Ask me a question or give me a task and I work on it in my own isolated <https://boxlite.ai|BoxLite> microVM — a full shell and network, so I run things before I answer — then reply in the thread.`,
      '',
      `• \`@${bot.name} <question or task>\` in a channel I'm in, or message me directly`,
      `• follow up in the same thread without another mention: I remember it, and its files stay on my machine until it's been quiet for ${ttl}`,
      `• attach files — logs, screenshots, code — and I get them too (up to ${size(cfg.maxFilesBytes)} a message)`,
      `• ask me to read a conversation, post a message, add a reaction, or save a scheduled task or channel watch`,
      `• ask me to list, pause, resume or cancel your saved tasks in their original thread; Slack's Stop button stops the current run`,
      now.ok ? `• ask me to open a PR with a change: a draft PR from my own GitHub account, into ${prTargets(now.repos)}` : `• PRs: not now — ${now.why}`,
      `• \`@${bot.name} help\` — this message`,
      ...(isSlackAdmin(user) ? ['', `As an admin of this workspace, you can also run me: \`@${bot.name} /model [model] [effort]\` · \`/deploy\` (put what's merged on main live) · \`/pause\` · \`/resume\` (PR writing, everywhere).`] : []),
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
    // Commands (`@bot /model …`) are the controller's, as on GitHub: no box, no quota, never Codex.
    const cmd = parseCommand(plainText(req.text, await namesOf(mentionedIds(req.text))), bot.name)
    if (cmd?.name === 'help' || (!cmd && isHelp(req.text, bot))) {
      log(`${key}: help for ${who}`)
      return say(sk, req, await helpText(req, user))
    }
    if (cmd) {
      log(`${key}: ${cmd.unknown ? `unknown command /${cmd.unknown}` : `/${cmd.name}`} from ${who}`)
      return commands.run(cmd, {
        isAdmin: isSlackAdmin(user),
        who: `<@${req.user}>`,
        by: displayName(user),
        reply: { slack: { channel: req.channel, threadTs: req.threadTs } },
        help: () => helpText(req, user),
        post: (text) => say(sk, req, text),
      })
    }
    if (cfg.slackDailyLimit && !takeQuota(slackState, req.user, cfg.slackDailyLimit)) {
      log(`${key}: ${who} is over today's limit`)
      return whisper(sk, req, `You've reached today's limit of ${cfg.slackDailyLimit} requests — it resets at 00:00 UTC.`).catch((e) => log(`${key}: ${e.message}`))
    }
    log(`${key}: request from ${who} via ${via}`)
    // 👀 the moment we have it — not queued behind other turns; the reply waits for it (handle()).
    req.ack = react(sk, req).catch((e) => log(`${key}: 👀 reaction failed: ${e.message}`))
    slackState.threads[key] = { ...slackState.threads[key], subscribed: true, owner: req.user, lastUsed: new Date().toISOString() }
    await persist()
    track(scheduleRequest(req))
  }

  /** Requests are accepted one at a time, in the order Slack sent them. */
  let accepting = Promise.resolve()
  function enqueue(req, via = 'slack') {
    accepting = accepting.then(() => accept(req, via)).catch((e) => {
      log(`${req.id}: ${e.stack || e.message}`)
      say(sk, req, `<@${req.user}> sorry, something went wrong on my side. Please try again in a bit.`).catch(() => {})
    })
  }

  async function event(payload) {
    const e = payload?.event
    if (e?.type === 'app_context_changed') {
      const user = e.user ?? payload.authorizations?.find((a) => !a.is_bot)?.user_id
      const entity = e.context?.entities?.find((x) => x.type === 'slack#/types/channel_id' && (!x.team_id || x.team_id === bot.teamId))
      if (payload.team_id === bot.teamId && /^[UW][A-Z0-9]+$/.test(user ?? '')) {
        if (/^[CG][A-Z0-9]+$/.test(entity?.value ?? '')) contexts.set(user, { channel: entity.value, at: Date.now() })
        else contexts.delete(user)
      }
      return
    }
    if (e?.type === 'agent_session_stopped') {
      if (payload.team_id !== bot.teamId || !/^[CGD][A-Z0-9]+$/.test(e.channel ?? '') || !/^\d+\.\d+$/.test(e.thread_ts ?? '') || !/^[UW][A-Z0-9]+$/.test(e.user ?? '')) return
      const user = await person(e.user)
      if (!mayUseSlack(user, { teamId: bot.teamId, enterpriseId: bot.enterpriseId }, { extShared: payload.is_ext_shared_channel }).ok) return
      const key = `${payload.team_id}/${e.channel}/${e.thread_ts}`
      for (const entry of work.get(key) ?? []) if (entry.req.user === e.user || isSlackAdmin(user)) {
        if (entry.req.task) {
          const task = slackState.tasks[entry.req.task.id]
          task.status = 'paused'; task.reason = 'Stopped from Slack.'
        }
        entry.abort.abort()
      }
      await persist()
      return
    }
    const req = requestFromEvent(payload, bot, { threads: slackState.threads })
    if (req) return accept(req, 'slack')
    const observed = requestFromEvent(payload, bot, { allMessages: true })
    if (observed) await tasks.observe(observed)
  }
  const socket = socketMode({
    open: () => slack(tokens.app).call('apps.connections.open'),
    onEvent: (payload) => {
      accepting = accepting.then(() => event(payload)).catch((e) => log(`Slack event: ${e.message}`))
    },
    onStatus: (line) => status(line && `slack: ${line}`, 'slack-socket'),
    log,
  })

  return {
    bot,
    start() {
      socket.start()
      track(tasks.start().catch((e) => log(`Slack tasks: ${e.message}`)))
      const kept = slackState.deferred.splice(0)
      for (const req of kept) enqueue(req, 'the last controller')
      if (kept.length) persist()
    },
    /** Requests already being accepted, which may still start turns: a shutdown waits for these first. */
    settle: () => accepting,
    /** The controller's own words in a thread — how a /deploy asked here says how it went. */
    post: ({ channel, threadTs }, text) => say(sk, { channel, threadTs }, text),
    stop: () => { tasks.stop(); socket.stop() },
    get live() {
      return socket.live
    },
  }
}
