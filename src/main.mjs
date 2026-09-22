// @botlite — the controller: one long-running BoxLite box. It polls the bot account's GitHub
// notifications; each request that mentions @botlite becomes one Codex turn in that thread's own
// box (its context kept in the thread's subdirectory of the shared volume), and the answer is
// posted back as @botlite. It also holds the bot's ChatGPT login (Codex device auth) and serves
// it to session boxes only through its proxy, one job token per turn.
//
// Credentials can arrive after the box is up — the controller waits for what's missing and says
// so in <state dir>/status.txt (`node deploy/ctl.mjs status`):
//   GitHub  GITHUB_TOKEN / BOXLITE_SECRET_GITHUB, or <state dir>/github-token (ctl github-token)
//   ChatGPT CHATGPT_ACCESS_TOKEN + CHATGPT_REFRESH_TOKEN + CHATGPT_ACCOUNT_ID (or their
//           BOXLITE_SECRET_CHATGPT_* placeholders), else a device login run in this box
//   BoxLite BOXLITE_API_KEY / BOXLITE_SECRET_BOXLITE (required)
//   CONTEXT_SECRET — else generated once into <state dir>/context-secret
//   PRs     the push App (githubapp.mjs): GITHUB_APP_ID + GITHUB_APP_PRIVATE_KEY, or
//           <state dir>/github-app.json (ctl github-app) — without it, PR writing is off;
//           BOT_ADMINS, or <state dir>/bot-admins (ctl admins): GitHub logins (comma-separated)
//           who may ask for PRs anywhere and run the admin commands (access.mjs)
// Optional: BOT_LOGIN (botlite), BOXLITE_URL (https://api.boxlite.ai), PORT (8788), PUBLIC_URL
//   (else looked up for this box, BOXLITE_BOX_ID), VOLUME (botlite-context), SESSION_IMAGE (node),
//   SESSION_CPUS (2), SESSION_MEMORY_MIB (4096), CODEX_MODEL, CODEX_EFFORT (both until an admin's
//   /model), MAX_CONCURRENT (3),
//   DAILY_LIMIT_PER_USER (20), JOB_TIMEOUT_MIN (20), BOX_TTL_DAYS (3),
//   STATE_FILE (/var/lib/botlite/state.json; its directory is the state dir).
import { createHmac, randomBytes } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { github } from './github.mjs'
import { poll, requestsFrom, markRead, standing } from './mentions.mjs'
import { loadState, saveState, takeQuota, quotaLeft } from './state.mjs'
import { scheduler } from './jobs.mjs'
import { boxlite } from './boxlite.mjs'
import { runTurn } from './session.mjs'
import { newSessionPrompt, followUpPrompt, CODEX_VERSION } from './codex.mjs'
import { chatgptLogin, jobTokens, deviceLogin, codexModels } from './chatgpt.mjs'
import { createProxy } from './proxy.mjs'
import { gitPushHandler } from './gitpush.mjs'
import { githubApp, appJwt } from './githubapp.mjs'
import { parseCommand, runCommand, writeAccess, modelOf } from './access.mjs'
import { planWrite, publishWrite } from './publish.mjs'
import { webhookHandler, requestsFromWebhook } from './webhook.mjs'
import { react, reply } from './reply.mjs'

if (typeof WebSocket !== 'function') throw new Error('Node 22+ required (exec attach uses the global WebSocket)')
if (Object.keys(process.env).some((k) => k.startsWith('BOXLITE_SECRET_')) && !process.env.NODE_EXTRA_CA_CERTS) {
  console.warn('BoxLite secrets in use but NODE_EXTRA_CA_CERTS is unset: HTTPS to secret hosts will fail (SELF_SIGNED_CERT_IN_CHAIN)')
}

const env = process.env
const first = (...names) => names.map((n) => env[n]).find(Boolean)
const cfg = {
  login: env.BOT_LOGIN || 'boxliteai', // replaced by the GitHub token's own login once it's known
  boxliteKey: first('BOXLITE_API_KEY', 'BOXLITE_SECRET_BOXLITE'),
  chatgpt: {
    access_token: first('CHATGPT_ACCESS_TOKEN', 'BOXLITE_SECRET_CHATGPT_ACCESS'),
    refresh_token: first('CHATGPT_REFRESH_TOKEN', 'BOXLITE_SECRET_CHATGPT_REFRESH'),
    account_id: env.CHATGPT_ACCOUNT_ID,
    last_refresh: env.CHATGPT_LAST_REFRESH, // from the device login's auth.json; unset → refresh early
  },
  port: Number(env.PORT || 8788),
  volume: env.VOLUME || 'botlite-context',
  image: env.SESSION_IMAGE || 'node',
  cpus: Number(env.SESSION_CPUS || 2),
  memoryMib: Number(env.SESSION_MEMORY_MIB || 4096),
  model: env.CODEX_MODEL || undefined, // defaults; an admin's /model (state.codex) wins
  effort: env.CODEX_EFFORT || undefined,
  maxConcurrent: Number(env.MAX_CONCURRENT || 3),
  dailyLimit: Number(env.DAILY_LIMIT_PER_USER || 20),
  jobTimeoutMs: Number(env.JOB_TIMEOUT_MIN || 20) * 60_000,
  boxTtlSec: Number(env.BOX_TTL_DAYS || 3) * 86_400,
  stateFile: env.STATE_FILE || '/var/lib/botlite/state.json',
}
if (!cfg.boxliteKey) throw new Error('missing env BOXLITE_API_KEY or BOXLITE_SECRET_BOXLITE')
const stateDir = path.dirname(cfg.stateFile)
await mkdir(stateDir, { recursive: true, mode: 0o700 })

const log = (...a) => console.log(new Date().toISOString(), ...a)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
/** What the controller is doing or waiting for — read by `node deploy/ctl.mjs status`. */
const pending = new Map()
const status = (line, key = 'main') => {
  if (line) {
    log(line)
    pending.set(key, `${new Date().toISOString()} ${line}`)
  } else pending.delete(key)
  return writeFile(path.join(stateDir, 'status.txt'), [...pending.values()].join('\n') + '\n').catch(() => {})
}
const readSecretFile = async (name) => (await readFile(path.join(stateDir, name), 'utf8').catch(() => '')).trim()
cfg.contextSecret = env.CONTEXT_SECRET || (await readSecretFile('context-secret'))
if (!cfg.contextSecret) {
  cfg.contextSecret = randomBytes(32).toString('base64')
  await writeFile(path.join(stateDir, 'context-secret'), cfg.contextSecret, { mode: 0o600 })
}
// Signs GitHub App webhook deliveries; `node deploy/ctl.mjs webhook` shows it for the App settings.
cfg.webhookSecret = env.WEBHOOK_SECRET || (await readSecretFile('webhook-secret'))
if (!cfg.webhookSecret) {
  cfg.webhookSecret = randomBytes(32).toString('hex')
  await writeFile(path.join(stateDir, 'webhook-secret'), cfg.webhookSecret, { mode: 0o600 })
}

const bl = boxlite(cfg.boxliteKey, { base: env.BOXLITE_URL })
const state = await loadState(cfg.stateFile)
const schedule = scheduler(cfg.maxConcurrent)
let inflight = 0 // turns accepted and not yet answered
let draining = false // SIGTERM: take no new work, let running turns finish
let saving = Promise.resolve()
const persist = () => (saving = saving.then(() => saveState(cfg.stateFile, state)).catch((e) => log(`state not saved: ${e.message}`)))

// The proxy comes up first — it's what the deploy health check looks for — and only ever serves
// live job tokens, so it's safe before the ChatGPT login exists.
const chatgpt = chatgptLogin({ file: path.join(stateDir, 'chatgpt.json'), initial: cfg.chatgpt, codexAuthFile: path.join(stateDir, 'codex-login', 'auth.json') })
const jobSecret = createHmac('sha256', cfg.contextSecret).update('botlite:job-tokens').digest()
const jobs = jobTokens(jobSecret)
let onRequest = null // accept(), once the bot is live
const webhook = webhookHandler({
  secret: cfg.webhookSecret,
  onEvent: async (event, payload) => {
    if (!onRequest) return false
    for (const req of requestsFromWebhook(event, payload, { login: cfg.login, seen: state.seen })) {
      const real = await confirmed(req)
      if (real && !state.seen.has(real.id)) onRequest(real, 'webhook')
    }
    await persist()
    return true
  },
})
const git = gitPushHandler({ secret: jobSecret, jobs, log })
/** The model and reasoning effort turns run on right now (access.mjs: /model, else the deploy's). */
const running = () => modelOf(state, { model: cfg.model, effort: cfg.effort })
const proxy = createProxy({ login: chatgpt, secret: jobSecret, jobs, model: () => running().model, log, webhook, git })
await new Promise((resolve) => proxy.listen(cfg.port, '0.0.0.0', resolve))
const proxyUrl = (env.PUBLIC_URL || (await bl.previewUrl(env.BOXLITE_BOX_ID, cfg.port)).url).replace(/\/+$/, '')

// Late-bound credentials: wait — for both at once — for whatever the deploy didn't hand over.
async function waitForGithubToken() {
  let token = first('GITHUB_TOKEN', 'BOXLITE_SECRET_GITHUB') || (await readSecretFile('github-token'))
  while (!token) {
    await status("waiting for the bot's GitHub token — run: GITHUB_TOKEN=… node deploy/ctl.mjs github-token", 'github')
    await sleep(30_000)
    token = await readSecretFile('github-token')
  }
  await status(null, 'github')
  return token
}
async function waitForChatgptLogin() {
  const home = path.join(stateDir, 'codex-login')
  while (!(await chatgpt.load())) {
    await mkdir(home, { recursive: true, mode: 0o700 })
    await status('waiting for the ChatGPT device login — starting one', 'chatgpt')
    const exit = await deviceLogin({ codexHome: home, onPrompt: ({ url, code }) => status(`waiting for the ChatGPT device login — open ${url} and enter ${code} (expires in 15 min)`, 'chatgpt') })
    if (exit !== 0) await sleep(10_000) // expired or failed: a fresh code next round
  }
  await status(null, 'chatgpt')
}
const [githubToken] = await Promise.all([waitForGithubToken(), waitForChatgptLogin()])
setInterval(() => {
  if (chatgpt.stale()) chatgpt.refresh().then(() => log('ChatGPT login refreshed'), (e) => log(e.message))
}, 3_600_000).unref()
const gh = github(githubToken)
// Who we are is whoever the token belongs to — mentions of that account are the only ones that
// reach us. BOT_LOGIN can't override it (a mismatch would drop every mention unanswered).
const me = await gh.json('GET', '/user')
if (env.BOT_LOGIN && env.BOT_LOGIN.toLowerCase() !== me.login.toLowerCase()) log(`BOT_LOGIN=${env.BOT_LOGIN} ignored: the GitHub token is @${me.login}'s`)
cfg.login = me.login

/** A GitHub user's id and login, or null if there's no such user. */
const lookup = (login) => gh.json('GET', `/users/${encodeURIComponent(login)}`).then((u) => ({ id: u.id, login: u.login }), (e) => (e.status === 404 ? null : Promise.reject(e)))
// Admins by numeric id: a renamed login can be re-registered by someone else. `ctl admins`
// (<state dir>/bot-admins) replaces BOT_ADMINS, so they can change without a redeploy.
const adminLogins = ((await readSecretFile('bot-admins')) || env.BOT_ADMINS || '').split(/[\s,]+/).map((l) => l.replace(/^@/, '')).filter(Boolean)
const admins = new Map()
for (const login of adminLogins) {
  const u = await lookup(login).catch((e) => (log(`BOT_ADMINS: @${login}: ${e.message}`), undefined))
  if (u) admins.set(u.id, u.login)
  else if (u === null) log(`BOT_ADMINS: no GitHub user @${login}`)
}

/**
 * The push App (githubapp.mjs), from the environment or `ctl github-app` — looked for on each
 * write-eligible request until found, so it can be handed over without a restart. A missing or
 * broken one only turns PR writing off (and says so in status), never the answers.
 */
let pushApp = null
let pushAppProblem
async function loadPushApp() {
  if (pushApp) return pushApp
  let problem = null
  try {
    const conf = env.GITHUB_APP_ID && env.GITHUB_APP_PRIVATE_KEY
      ? { appId: env.GITHUB_APP_ID, privateKey: env.GITHUB_APP_PRIVATE_KEY.replace(/\\n/g, '\n') }
      : JSON.parse(await readFile(path.join(stateDir, 'github-app.json'), 'utf8').catch((e) => (e.code === 'ENOENT' ? 'null' : Promise.reject(e))))
    if (conf?.appId && conf?.privateKey) {
      appJwt(conf.appId, conf.privateKey) // a key that can't sign is no App
      pushApp = githubApp({ appId: conf.appId, privateKey: conf.privateKey, account: cfg.login })
    } else problem = 'PR writing is off until the push App is set up — GITHUB_APP_ID=… GITHUB_APP_KEY=app.pem node deploy/ctl.mjs github-app'
  } catch (e) {
    problem = `PR writing is off: the push App's config doesn't work (${e.message.slice(0, 120)})`
  }
  if (problem !== pushAppProblem) await status((pushAppProblem = problem), 'push-app')
  return pushApp
}
await loadPushApp()

/**
 * A webhook mention, re-read from GitHub with the bot's own token: accepted only if that comment /
 * issue really exists with that author and text. The signature proves who sent the delivery; this
 * proves what it says — so even a leaked webhook secret can't make the bot post where no one asked.
 * Who the author is to the repo (and whether they may publish) comes from this read too.
 */
async function confirmed(req) {
  const path =
    req.kind === 'comment' ? `/repos/${req.repo}/issues/comments/${req.commentId}`
      : req.kind === 'review_comment' ? `/repos/${req.repo}/pulls/comments/${req.commentId}`
        : `/repos/${req.repo}/issues/${req.number}`
  const live = await gh.json('GET', path).catch(() => null)
  return live && live.user?.login === req.author && live.body === req.body ? { ...req, userId: live.user.id, ...standing(live) } : null
}

async function prInfo(req) {
  const pr = await gh.json('GET', `/repos/${req.repo}/pulls/${req.number}`)
  return { headSha: pr.head.sha, baseRef: pr.base.ref, headRef: pr.head.ref, headRepo: pr.head.repo?.full_name ?? null }
}

/** The thread's most recent comments (GitHub lists them oldest first, so read the last page). */
async function recentComments(req) {
  const page = Math.max(1, Math.ceil((req.thread.comments || 0) / 100))
  return gh.json('GET', `/repos/${req.repo}/issues/${req.number}/comments?per_page=100&page=${page}`)
}

/**
 * One turn with its own job token, revoked the moment the turn ends. Its `exp` is deliberately
 * far off: Codex refreshes a ChatGPT token on its own when it nears expiry — impossible in a box,
 * and it stalls the turn (seen end-to-end with a short-lived token). What bounds a token's use is
 * the proxy honouring only live tokens, and the revoke below. A write turn's token may also push
 * one staging branch (gitpush.mjs) — the revoke ends that too, before anything is published.
 */
async function turn(key, req, pr, prompt, sessionId, plan) {
  const push = plan ? { ref: `refs/heads/${plan.staging}`, open: () => plan.open() } : null
  const jobToken = jobs.issue(12 * 3_600_000, key, { push })
  try {
    const { model, effort } = running()
    log(`${key}: turn on ${model ?? "Codex's default model"}${effort ? `, ${effort} effort` : ''}`)
    return await runTurn({ bl, cfg: { ...cfg, model: model ?? undefined, effort: effort ?? undefined }, key, req, pr, prompt, sessionId, jobToken, proxyUrl, write: plan, log })
  } finally {
    jobs.revoke(jobToken)
  }
}

/** May this request publish — and if so, the plan for it (publish.mjs). */
async function writeTurn(req, pr, key) {
  const access = writeAccess({ state, admins, req, ready: Boolean(await loadPushApp()) })
  if (!access.ok) return { write: { allowed: false, why: access.why }, plan: null }
  try {
    const plan = await planWrite({ gh, app: pushApp, me, req, pr, key, knownFork: state.forks[req.repo.toLowerCase()], log })
    return { write: { allowed: true, describe: plan.describe, base: plan.base }, plan }
  } catch (e) {
    log(`${key}: no write turn: ${e.message}`)
    return { write: { allowed: false, why: `setting up the PR branch failed (${e.message.slice(0, 200)})` }, plan: null }
  }
}

async function handle(req) {
  const key = `${req.repo}#${req.number}`
  let plan = null
  try {
    const pr = req.isPR ? await prInfo(req) : null
    const known = state.threads[key]
    const { write, plan: planned } = await writeTurn(req, pr, key)
    plan = planned
    const fresh = async () => newSessionPrompt({ login: cfg.login, req, pr, comments: await recentComments(req), write })
    const prompt = known?.sessionId
      ? followUpPrompt({ login: cfg.login, req, pr, headMoved: Boolean(pr && known.headSha && known.headSha !== pr.headSha), write })
      : await fresh()
    let out = await turn(key, req, pr, prompt, known?.sessionId, plan)
    if (out.sessionLost) {
      log(`${key}: session ${known.sessionId} is gone; starting over with the full thread`)
      out = await turn(key, req, pr, await fresh(), null, plan)
    }
    state.threads[key] = { sessionId: out.sessionId ?? null, headSha: pr?.headSha ?? known?.headSha ?? null, lastUsed: new Date().toISOString() }
    let note = null
    if (plan) {
      const refuse = state.paused ? 'an admin paused PR writing while I worked' : null
      note = await publishWrite({ gh, app: pushApp, me, plan, req, result: out.push, refuse, log }).catch((e) => (log(`${key}: publish: ${e.stack || e.message}`), `⚠️ Couldn't publish the change: ${e.message.slice(0, 200)}`))
      if (plan.fork) state.forks[req.repo.toLowerCase()] = plan.fork
      if (note) log(`${key}: ${note}`)
    }
    persist()
    await req.ack // the 👀 always lands before the answer
    if (out.message) {
      await reply(gh, req, note ? `${out.message}\n\n${note}` : out.message)
      log(`${key}: answered @${req.author}`)
    } else {
      log(`${key}: no answer — ${out.error}`)
      await reply(gh, req, `@${req.author} sorry, I couldn't finish this one — the run failed on my side. Please try again in a bit.${note ? `\n\n${note}` : ''}`)
    }
  } catch (e) {
    log(`${key}: ${e.stack || e.message}`)
    if (plan?.token) pushApp.revoke(plan.token).catch(() => {})
    await reply(gh, req, `@${req.author} sorry, something went wrong on my side. Please try again in a bit.`).catch(() => {})
  }
}

/** A command (access.mjs): answered by the controller itself — no box, no model. */
async function command(req, cmd) {
  const access = writeAccess({ state, admins, req, ready: Boolean(await loadPushApp()) })
  const left = admins.has(req.userId) ? null : quotaLeft(state, req.author, cfg.dailyLimit)
  const models = () => codexModels({ login: chatgpt, clientVersion: CODEX_VERSION })
  const text = await runCommand(cmd, { state, admins, req, login: cfg.login, lookup, models, defaults: { model: cfg.model, effort: cfg.effort }, access, left, limit: cfg.dailyLimit })
  await persist()
  await reply(gh, req, text, { footer: false })
}

function accept(req, via = 'poll') {
  if (draining) return // not marked seen: the next controller picks it up
  state.seen.add(req.id) // at most once: a crash mid-run must not produce a second reply later
  const cmd = parseCommand(req.body, cfg.login)
  // Admins run the bot: no daily limit for them, for requests or commands.
  if (!admins.has(req.userId) && !takeQuota(state, req.author, cfg.dailyLimit)) {
    const usage = state.usage[req.author]
    log(`@${req.author} is over today's limit`)
    if (!usage.notified) {
      usage.notified = true
      reply(gh, req, `@${req.author} you've reached today's limit of ${cfg.dailyLimit} requests — it resets at 00:00 UTC.`).catch(() => {})
    }
    return
  }
  if (cmd) {
    log(`${req.repo}#${req.number}: ${cmd.unknown ? `unknown command /${cmd.unknown}` : `/${cmd.name}`} from @${req.author} via ${via}`)
    command(req, cmd).catch((e) => log(`${req.repo}#${req.number}: command failed: ${e.stack || e.message}`))
    return
  }
  log(`${req.repo}#${req.number}: request from @${req.author} via ${via} (${req.url})`)
  // 👀 the moment we have it — not queued behind other turns; the reply waits for it (handle()).
  req.ack = react(gh, req).catch((e) => log(`${req.repo}#${req.number}: 👀 reaction failed: ${e.message}`))
  inflight++
  schedule(`${req.repo}#${req.number}`, () => handle(req)).finally(() => inflight--)
}

async function tick() {
  if (draining) return 5 // don't read (and mark read) notifications we won't handle
  const { notifications, lastModified, interval } = await poll(gh, state.lastModified)
  let clean = true
  for (const n of notifications) {
    try {
      for (const req of await requestsFrom(gh, n, { login: cfg.login, seen: state.seen })) accept(req)
      await markRead(gh, n.id)
    } catch (e) {
      clean = false // leave the cursor, so the next poll sees this notification again
      log(`notification ${n.id} (${n.repository?.full_name}): ${e.message}`)
    }
  }
  if (clean) state.lastModified = lastModified
  await persist()
  return interval
}

async function ensureVolume() {
  const list = await bl.listVolumes()
  const volumes = Array.isArray(list) ? list : (list.volumes ?? list.items ?? list.data ?? [])
  if (volumes.some((v) => v.name === cfg.volume || v.id === cfg.volume)) return
  await bl.createVolume(cfg.volume)
  log(`created volume ${cfg.volume}`)
}

// A restart (`ctl restart`, a redeploy) must not cut off answers: accepted requests are marked
// seen, so a turn killed mid-way would never be retried. Take no new work, finish what's running.
process.on('SIGTERM', async () => {
  if (draining) return
  draining = true
  log(`SIGTERM: finishing ${inflight} running turn(s) before exiting`)
  for (let waited = 0; inflight > 0 && waited < cfg.jobTimeoutMs + 120_000; waited += 1000) await sleep(1000)
  await persist()
  process.exit(0)
})

await ensureVolume().catch((e) => log(`volume check: ${e.message} — create "${cfg.volume}" in the dashboard if this key lacks volume permissions`))
onRequest = accept
await status(`live as @${cfg.login}: proxy ${proxyUrl}, webhook ${proxyUrl}/webhook, ${cfg.maxConcurrent} concurrent turns, ${cfg.dailyLimit}/user/day, volume ${cfg.volume}, admins ${[...admins.values()].map((l) => `@${l}`).join(' ') || 'none'}, codex ${CODEX_VERSION}`)
for (;;) {
  let interval = 60
  try {
    interval = await tick()
  } catch (e) {
    log(`poll: ${e.message}`)
  }
  await sleep(Math.max(interval, 30) * 1000)
}
