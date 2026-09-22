// Durable task instructions and wakeups live on the controller, not in a disposable VM.
// A running task interrupted by a controller crash is paused: external effects may have happened,
// so recovery never blindly repeats that run. Pending work can safely be admitted after restart.
import { randomUUID } from 'node:crypto'
import { defineTool } from './slack-tools.mjs'

export function slackTasks({ state, persist, run, track = () => {}, draining = () => false, stopRun = () => {}, now = Date.now, log = () => {} }) {
  state.tasks ??= {}
  const active = new Set()
  let timer
  let ticking = false
  let stopped = true
  const save = async () => { if (await persist() === false) throw new Error('Task state could not be saved.') }
  const visible = (task, req) => task.user === req.user && task.team === req.team &&
    (req.task ? task.id === req.task.id : (task.channel === req.channel && task.threadTs === req.threadTs))
  const view = ({ pending, seen, ...task }) => ({ ...task, pending: pending.length })
  const controls = (req) => [
    defineTool('list_tasks', 'List saved tasks owned by this requester in this thread, including status, schedule and last result.', {}, [], async (_, check) => { check(); return Object.values(state.tasks).filter((t) => visible(t, req)).map(view) }),
    defineTool('control_task', 'Pause, resume or cancel a task in this thread. Pausing/cancelling also stops its active run. Resume interrupted tasks only after checking earlier effects.', { id: { type: 'string', maxLength: 50 }, action: { type: 'string', enum: ['pause', 'resume', 'cancel'] } }, ['id', 'action'], async ({ id, action }, check) => {
      check()
      const task = state.tasks[id]
      if (!task || !visible(task, req)) throw new Error('No such task in this thread for this requester.')
      if (task.status === 'cancelled') throw new Error('Task is already cancelled.')
      if (action === 'resume' && active.has(id)) throw new Error('Wait for the stopped run to finish before resuming.')
      const before = { status: task.status, reason: task.reason, nextAt: task.nextAt }
      task.status = action === 'resume' ? 'enabled' : action === 'cancel' ? 'cancelled' : 'paused'
      if (action === 'cancel') task.pending = []
      task.reason = null
      if (action === 'resume') task.nextAt = task.trigger === 'channel_message' ? null : now() + (task.everyMinutes ?? 0) * 60_000
      else stopRun(task)
      try { await save() } catch (e) {
        if (action === 'resume') Object.assign(task, before)
        throw e
      }
      return view(task)
    }, true),
  ]
  function tools(req) {
    const result = controls(req)
    if (req.task) return result // background work cannot create an unbounded tree of tasks
    result.push(defineTool('create_task', 'Save an explicitly requested standing instruction in this thread. Trigger on an interval, once at an absolute UTC time, or on new human messages in this channel. Does not run immediately. Use full instructions, including permitted actions and when to stay silent.', {
      instructions: { type: 'string', minLength: 1, maxLength: 6000 },
      trigger: { type: 'string', enum: ['interval', 'once', 'channel_message'] },
      every_minutes: { type: 'integer', minimum: 5, maximum: 525600 },
      at: { type: 'string', maxLength: 40 },
    }, ['instructions', 'trigger'], async (args, check) => {
      check()
      if (args.trigger === 'channel_message' && req.isDM) throw new Error('Create channel watches in the channel to watch.')
      if (args.trigger === 'interval' && !args.every_minutes) throw new Error('Set every_minutes for an interval.')
      if (args.trigger !== 'interval' && args.every_minutes !== undefined) throw new Error('every_minutes is only for interval tasks.')
      if (args.trigger !== 'once' && args.at !== undefined) throw new Error('at is only for one-time tasks.')
      const at = Date.parse(args.at)
      if (args.trigger === 'once' && (!/^\d{4}-\d\d-\d\dT.*Z$/.test(args.at ?? '') || !Number.isFinite(at) || at <= now())) throw new Error('Set at to a future ISO UTC timestamp ending in Z.')
      const all = Object.values(state.tasks)
      if (all.filter((t) => !['cancelled', 'done'].includes(t.status)).length >= 100 || all.filter((t) => t.user === req.user && !['cancelled', 'done'].includes(t.status)).length >= 10) throw new Error('Task limit reached (10 per user, 100 total).')
      // Bound retained terminal records too; keep the most recently used records.
      for (const t of all.filter((t) => ['cancelled', 'done'].includes(t.status)).sort((a, b) => b.createdAt - a.createdAt).slice(100)) delete state.tasks[t.id]
      const task = {
        id: randomUUID(), team: req.team, channel: req.channel, threadTs: req.threadTs, user: req.user, isDM: req.isDM,
        instructions: args.instructions, trigger: args.trigger, everyMinutes: args.every_minutes ?? null,
        nextAt: args.trigger === 'once' ? at : args.trigger === 'interval' ? now() + args.every_minutes * 60_000 : null,
        createdAt: now(), status: 'enabled', pending: [], seen: [], lastRun: null,
      }
      state.tasks[task.id] = task
      try { await save() } catch (e) { delete state.tasks[task.id]; throw e }
      return view(task)
    }, true))
    return result
  }
  async function observe(req) {
    if (req.isDM || req.extShared) return
    let changed = false
    for (const task of Object.values(state.tasks)) {
      if (task.status !== 'enabled' || task.trigger !== 'channel_message' || task.team !== req.team || task.channel !== req.channel || task.seen.includes(req.id)) continue
      task.seen = [...task.seen, req.id].slice(-100)
      // Persist a bounded queue. Overflow is visible and pauses the watch; never silently lose work.
      if (task.pending.length >= 20) { task.status = 'paused'; task.reason = 'Watch queue full. Review pending events before resuming.' }
      else task.pending.push({ id: req.id, at: now(), event: { user: req.user, text: req.text.slice(0, 8000), channel: req.channel, ts: req.ts, threadTs: req.threadTs } })
      changed = true
    }
    if (changed) await save()
  }
  async function tick() {
    if (stopped || ticking || draining()) return
    ticking = true
    try {
      for (const task of Object.values(state.tasks)) {
        if (stopped || draining() || task.status !== 'enabled' || active.has(task.id)) continue
        if (!task.pending.length && task.nextAt !== null && task.nextAt <= now()) {
          task.pending.push({ id: `${task.id}:${task.nextAt}`, at: now() })
          // Coalesce missed intervals into one run instead of flooding after downtime.
          task.nextAt = task.trigger === 'interval' ? now() + task.everyMinutes * 60_000 : null
        }
        if (!task.pending.length) continue
        const trigger = task.pending.shift()
        task.lastRun = { id: trigger.id, startedAt: now(), status: 'running', writes: [] }
        try { await save() } catch (e) {
          task.status = 'paused'; task.reason = e.message; task.lastRun.status = 'failed'
          throw e
        } // don't start effects until their run identity is on durable storage
        active.add(task.id)
        const req = {
          id: `task:${trigger.id}`, team: task.team, channel: task.channel, threadTs: task.threadTs,
          ts: task.threadTs, user: task.user, isDM: task.isDM, extShared: false, files: [],
          text: task.instructions, task: { id: task.id, event: trigger.event ?? null },
        }
        // The controller tracks and schedules this promise alongside ordinary Slack turns.
        track(Promise.resolve().then(() => run(req, task)).then(async (out) => {
          task.lastRun = { ...task.lastRun, status: out?.error ? 'failed' : 'completed', finishedAt: now(), result: out?.message?.slice(0, 2000) ?? null }
          if (out?.error && task.status === 'enabled') { task.status = 'paused'; task.reason = out.error }
          if (task.trigger === 'once' && task.status === 'enabled') task.status = 'done'
          await save()
        }).catch(async (e) => {
          task.status = 'paused'; task.reason = e.message
          task.lastRun = { ...task.lastRun, status: 'failed', finishedAt: now() }
          await save().catch((err) => log(err.message))
        }).finally(() => active.delete(task.id)))
      }
    } catch (e) { log(`Slack task scheduling: ${e.message}`) }
    finally { ticking = false }
  }
  return {
    tools, observe, tick,
    async start() {
      if (!stopped) return
      for (const task of Object.values(state.tasks)) if (task.lastRun?.status === 'running') {
        task.status = 'paused'; task.reason = 'Controller stopped during a run. Check its changes before resuming.'
        task.lastRun.status = 'interrupted'
      }
      await save()
      stopped = false
      timer = setInterval(() => { void tick() }, 15_000); timer.unref()
      await tick()
    },
    stop() { stopped = true; clearInterval(timer) },
    async record(req, writes) {
      const task = state.tasks[req.task?.id]
      if (task?.lastRun && req.id === `task:${task.lastRun.id}`) { task.lastRun.writes = [...writes]; await save() }
    },
  }
}
