// @botlite — the controller: one long-running BoxLite box, started by the launcher (main.mjs). It
// polls the bot account's GitHub notifications, and — once the Slack app's tokens are in — holds a
// Socket Mode connection to Slack (slack-channel.mjs). Each request becomes one Codex turn in that
// thread's own box (its context kept in the thread's subdirectory of a shared volume), and the
// answer is posted back where it was asked. GitHub's threads and Slack's never share a box, a
// volume or a context secret (session.mjs). It also holds the bot's ChatGPT login (Codex device
// auth) and serves it to session boxes only through its proxy, one job token per turn — as it
// does the team's Linear, Notion and Google Workspace (tools.mjs), for the turns that may use them.
//
// Credentials can arrive after the box is up — the controller waits for what's missing and says
// so in <state dir>/status.txt (`node deploy/ctl.mjs status`):
//   GitHub  GITHUB_TOKEN / BOXLITE_SECRET_GITHUB, or <state dir>/github-token (ctl github-token)
//   ChatGPT CHATGPT_ACCESS_TOKEN + CHATGPT_REFRESH_TOKEN + CHATGPT_ACCOUNT_ID (or their
//           BOXLITE_SECRET_CHATGPT_* placeholders), else a device login run in this box
//   BoxLite BOXLITE_API_KEY / BOXLITE_SECRET_BOXLITE (required)
//   CONTEXT_SECRET — else generated once into <state dir>/context-secret; Slack threads' own is
//           SLACK_CONTEXT_SECRET or <state dir>/slack-context-secret (likewise)
//   PRs     the push App (githubapp.mjs): GITHUB_APP_ID + GITHUB_APP_PRIVATE_KEY, or
//           <state dir>/github-app.json (ctl github-app) — without it, PR writing is off;
//           BOT_ADMINS, or <state dir>/bot-admins (ctl admins): GitHub logins (comma-separated)
//           who may ask for PRs anywhere and run the admin commands (access.mjs)
//   Slack   optional: SLACK_BOT_TOKEN (xoxb-…) + SLACK_APP_TOKEN (xapp-…, Socket Mode), or their
//           BOXLITE_SECRET_SLACK_BOT / _SLACK_APP placeholders, or <state dir>/slack-bot-token +
//           slack-app-token (ctl slack-tokens) — no restart needed
//   Tools   optional and per person: each Slack user binds their OWN Linear / Notion / Google
//           login from Slack (/link linear, /link notion) or ctl, kept under <state dir>/user-logins/
//           (src/userlogins.mjs). No shared bot login; none on GitHub.
// Optional: BOT_LOGIN (botlite), BOXLITE_URL (https://api.boxlite.ai), PORT (8788), PUBLIC_URL
//   (else looked up for this box, BOXLITE_BOX_ID), VOLUME (botlite-context), SLACK_VOLUME
//   (botlite-slack-context), SESSION_IMAGE (node), SESSION_CPUS (2), SESSION_MEMORY_MIB (4096),
//   CODEX_MODEL, CODEX_EFFORT (both until an admin's /model), MAX_CONCURRENT (3),
//   DAILY_LIMIT_PER_USER (20), SLACK_DAILY_LIMIT (0: no limit), JOB_TIMEOUT_MIN (20),
//   BOX_TTL_MIN (15), MAX_FILE_MB (5), MAX_FILES_MB (8),
//   STATE_FILE (/var/lib/botlite/state.json; its directory is the state dir).
import { execFileSync } from 'node:child_process'
import { createHmac, randomBytes } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { github } from './github.mjs'
import { poll, readThreads, sweep, standing } from './mentions.mjs'
import { loadState, saveState, takeQuota, quotaLeft, importSlackState } from './state.mjs'
import { scheduler } from './jobs.mjs'
import { boxlite } from './boxlite.mjs'
import { runTurn, mixedSides, boxName } from './session.mjs'
import { newSessionPrompt, followUpPrompt, CODEX_VERSION } from './codex.mjs'
import { chatgptLogin, jobTokens, deviceLogin, codexModels } from './chatgpt.mjs'
import { createProxy } from './proxy.mjs'
import { gitPushHandler } from './gitpush.mjs'
import { prGrantHandler } from './prgrant.mjs'
import { githubApp, appJwt } from './githubapp.mjs'
import { parseCommand, runCommand, runSlackCommand, writeAccess, modelOf } from './access.mjs'
import { planWrite, planSlackWrite, publishWrite } from './publish.mjs'
import { selfBuild, deployPlan, markGood, goodBuild, cleanExit, failTrial, takeRollback, deployOutcome, pendingAfter, recordedBranch, recordBranch, TRIAL_MS, TRIAL_TURN, trialTurnFailure } from './deploy.mjs'
import { webhookHandler, requestsFromWebhook } from './webhook.mjs'
import { react, reply } from './reply.mjs'
import { toolBroker, SERVICES } from './tools.mjs'
import { userLogins } from './userlogins.mjs'
import { accountLinks } from './account-links.mjs'
import { TOOLS, SLACK_PR_REPOS } from './policy.mjs'
import { tally } from './slack-reply.mjs'
import { slackChannel } from './slack-channel.mjs'

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
  boxDeleteSec: Number(env.BOX_TTL_MIN || 15) * 60, // a thread's box is deleted after this long without a turn
  // Slack (slack-channel.mjs): its threads' own volume and context secret, what a message's files may weigh.
  slackVolume: env.SLACK_VOLUME || 'botlite-slack-context',
  slackDailyLimit: Number(env.SLACK_DAILY_LIMIT || 0), // requests per Slack user per UTC day; 0: no limit
  maxFileBytes: Number(env.MAX_FILE_MB || 5) * 1024 * 1024,
  maxFilesBytes: Number(env.MAX_FILES_MB || 8) * 1024 * 1024,
  stateFile: env.STATE_FILE || '/var/lib/botlite/state.json',
}
if (!cfg.boxliteKey) throw new Error('missing env BOXLITE_API_KEY or BOXLITE_SECRET_BOXLITE')
const stateDir = path.dirname(cfg.stateFile)
/** The build we run — commit, repo and tracked branch of this checkout — for /deploy (deploy.mjs). */
const build = selfBuild(path.dirname(path.dirname(fileURLToPath(import.meta.url))), { recorded: recordedBranch(stateDir), fallback: env.BOTLITE_REF || 'main' })
if (build.branch) recordBranch(stateDir, build.branch) // where a rollback's detached checkout goes back to
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
// Slack threads' contexts are sealed under a secret of their own (session.mjs sideOf): the Slack
// agent's, handed over, so its threads carry on here. It's read when Slack starts, so one handed
// over with the tokens (ctl slack-tokens writes it first) is the one the first Slack turn uses.
async function slackContextSecret() {
  const known = env.SLACK_CONTEXT_SECRET || (await readSecretFile('slack-context-secret'))
  if (known) return known
  const made = randomBytes(32).toString('base64')
  await writeFile(path.join(stateDir, 'slack-context-secret'), made, { mode: 0o600 })
  return made
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
const prGrant = prGrantHandler({ secret: jobSecret, jobs, log }) // a Slack turn asking for its PR's push
// The team's tools. Each person uses their OWN login, linked from Slack or ctl and kept per user
// (userlogins.mjs), and only in a Slack DM — so the bot only ever reads what the asker can, and
// there is no shared bot login for anyone to borrow. Each distinct login and how it's stored per
// user: OAuth, with legacy Linear API keys still supported.
const loginKinds = Object.fromEntries([...new Set(Object.values(SERVICES).map((s) => s.login))].map((n) => [n, n === 'linear' ? 'key-or-oauth' : 'oauth']))
const userTools = userLogins({ dir: path.join(stateDir, 'user-logins'), kinds: loginKinds })
const links = accountLinks({ baseUrl: () => proxyUrl, userLogins: userTools, linearScope: TOOLS.linear.write.length ? 'read write' : 'read' })
const tools = toolBroker({ secret: jobSecret, jobs, policy: TOOLS, log }) // whose login a turn uses is set on its job

/** The model and reasoning effort turns run on right now (access.mjs: /model, else the deploy's). */
const running = () => modelOf(state, { model: cfg.model, effort: cfg.effort })
/** The config one turn runs on: the deploy's, with the model and effort of the moment. */
const turnCfg = () => {
  const { model, effort } = running()
  return { ...cfg, model: model ?? undefined, effort: effort ?? undefined }
}
// /healthz is healthy while polling works and, once Slack is set up, while the bot is connected to
// it (or was in the last 10 minutes: a reconnect is no outage) — a controller that's up but stuck
// or deaf is caught too (the health workflow checks it). Before the first poll it counts from the start.
let lastPoll = Date.now()
let slackBot = null // the Slack channel, once its tokens are in
let lastSlack = Date.now()
const health = () => {
  const quiet = Date.now() - lastPoll
  if (quiet >= 10 * 60_000) return { ok: false, why: `no successful poll for ${Math.floor(quiet / 60_000)} minutes` }
  if (slackBot?.live !== false) lastSlack = Date.now() // not set up yet, or connected
  const deaf = Date.now() - lastSlack
  return deaf < 10 * 60_000 ? { ok: true } : { ok: false, why: `not connected to Slack for ${Math.floor(deaf / 60_000)} minutes` }
}
const proxy = createProxy({ login: chatgpt, secret: jobSecret, jobs, model: () => running().model, log, webhook, git, pr: prGrant, tools, linking: links.handle, health })
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
// The launcher's watchdog kills a controller that stops beating (src/main.mjs). Waiting on a person
// (a token to be handed over, a device login to be approved) is progress too.
const beat = () => globalThis.botliteBeat?.()
const waitingOnPeople = setInterval(beat, 60_000)
const [githubToken] = await Promise.all([waitForGithubToken(), waitForChatgptLogin()]).finally(() => clearInterval(waitingOnPeople))
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

/**
 * The bot's comment in a thread. Commenting marks the thread read for the bot, which would hide a
 * mention that came in since the last poll — so the next poll takes a second look (mentions.mjs).
 */
async function comment(req, text, opts) {
  try {
    return await reply(gh, req, text, opts)
  } finally {
    sweep(state.sweeps, req, state.polledAt ?? null)
    persist()
  }
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
 * one staging branch (gitpush.mjs) — the revoke ends that too, before anything is published. The
 * same token opens the team's tools for a turn that has them; `job` is its record (who asked, and
 * — from tools.mjs — what it changed).
 */
async function turn(key, req, pr, prompt, sessionId, plan, job) {
  job.push = plan ? { ref: `refs/heads/${plan.staging}`, open: () => plan.open() } : null
  const jobToken = jobs.issue(12 * 3_600_000, key, job)
  try {
    const run = turnCfg()
    log(`${key}: turn in ${boxName(key)} on ${run.model ?? "Codex's default model"}${run.effort ? `, ${run.effort} effort` : ''}`)
    const out = await runTurn({ bl, cfg: run, key, req, pr, prompt, tools: [], sessionId, jobToken, proxyUrl, write: plan, log })
    if (out.tooling?.error) log(`${key}: agent-tooling not installed/updated: ${out.tooling.error}`)
    else if (out.tooling) log(`${key}: agent-tooling ${out.tooling.version}`)
    return out
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
    // No team tools on GitHub: a public thread, run at anyone's request, and there is no shared bot
    // login to lend it — the tools are each person's own, bound and used only in a Slack DM.
    const job = { who: `@${req.author}`, writes: [], tools: [] } // what its token opens
    const fresh = async () => newSessionPrompt({ login: cfg.login, req, pr, comments: await recentComments(req), write })
    const prompt = known?.sessionId
      ? followUpPrompt({ login: cfg.login, req, pr, headMoved: Boolean(pr && known.headSha && known.headSha !== pr.headSha), write })
      : await fresh()
    let out = await turn(key, req, pr, prompt, known?.sessionId, plan, job)
    if (out.sessionLost) {
      log(`${key}: session ${known.sessionId} is gone; starting over with the full thread`)
      out = await turn(key, req, pr, await fresh(), null, plan, job)
    }
    state.threads[key] = { sessionId: out.sessionId ?? null, headSha: pr?.headSha ?? known?.headSha ?? null, lastUsed: new Date().toISOString() }
    let note = null
    if (plan) {
      const refuse = state.paused ? 'an admin paused PR writing while I worked' : null
      note = await publishWrite({ gh, app: pushApp, me, plan, req, result: out.push, refuse, selfRepo: build.repo, log }).catch((e) => (log(`${key}: publish: ${e.stack || e.message}`), `⚠️ Couldn't publish the change: ${e.message.slice(0, 200)}`))
      if (plan.fork) state.forks[req.repo.toLowerCase()] = plan.fork
      if (note) log(`${key}: ${note}`)
    }
    // What the turn changed in the team's tools, as the controller recorded it: Codex's own account
    // of it is in its answer, this one it can't leave out.
    if (job.writes.length) note = [note, `✏️ Changed as the bot: ${tally(job.writes)}`].filter(Boolean).join('\n\n')
    persist()
    await req.ack // the 👀 always lands before the answer
    if (out.message) {
      await comment(req, note ? `${out.message}\n\n${note}` : out.message)
      log(`${key}: answered @${req.author}${job.writes.length ? `, changed: ${tally(job.writes)}` : ''}`)
    } else {
      log(`${key}: no answer — ${out.error}`)
      await comment(req, `@${req.author} sorry, I couldn't finish this one — the run failed on my side. Please try again in a bit.${note ? `\n\n${note}` : ''}`)
    }
  } catch (e) {
    log(`${key}: ${e.stack || e.message}`)
    if (plan?.token) pushApp.revoke(plan.token).catch(() => {})
    await comment(req, `@${req.author} sorry, something went wrong on my side. Please try again in a bit.`).catch(() => {})
  }
}

/** A command (access.mjs): answered by the controller itself — no box, no model. */
const models = () => codexModels({ login: chatgpt, clientVersion: CODEX_VERSION })
const deploy = () => (build.commit && build.repo ? deployPlan({ gh, build }) : Promise.reject(new Error("this controller doesn't run from a git checkout")))

async function command(req, cmd) {
  const access = writeAccess({ state, admins, req, ready: Boolean(await loadPushApp()) })
  const left = admins.has(req.userId) ? null : quotaLeft(state, req.author, cfg.dailyLimit)
  const before = state.deploy
  const text = await runCommand(cmd, { state, admins, req, login: cfg.login, lookup, models, deploy, defaults: { model: cfg.model, effort: cfg.effort }, access, left, limit: cfg.dailyLimit })
  await persist()
  await comment(req, text, { footer: false })
  // Only a deploy this /deploy recorded: not one it refused, nor the last one, still on its trial.
  if (state.deploy && state.deploy !== before && !restarting) restart()
}

/**
 * Slack does all GitHub does (slack-channel.mjs). Its commands run on the same state — one
 * `/pause` stops PR writing on both — and its PRs go through the same publishing: planned when
 * the box asks (prgrant.mjs), checked and opened after the turn (publish.mjs).
 */
const slackCommands = {
  async run(cmd, { isAdmin, who, by, reply, help, post }) {
    const before = state.deploy
    const text = await runSlackCommand(cmd, { state, isAdmin, who, by, reply, models, deploy, defaults: { model: cfg.model, effort: cfg.effort }, help })
    await persist()
    await post(text)
    if (state.deploy && state.deploy !== before && !restarting) restart()
  },
}
const slackPrs = {
  async status() {
    if (!(await loadPushApp())) return { ok: false, why: "PR writing isn't set up on this bot", repos: SLACK_PR_REPOS }
    if (state.paused) return { ok: false, why: `an admin (@${state.paused.by}) paused PR writing`, repos: SLACK_PR_REPOS }
    return { ok: true, repos: SLACK_PR_REPOS }
  },
  plan: ({ repo, base, id }) => planSlackWrite({ gh, app: pushApp, me, repo, base, id, knownFork: state.forks[repo.toLowerCase()], log }),
  async publish(plan, result) {
    const refuse = state.paused ? 'an admin paused PR writing while I worked' : null
    const note = await publishWrite({ gh, app: pushApp, me, plan, req: { repo: plan.target.repo, origin: 'Requested from Slack' }, result, refuse, selfRepo: build.repo, log })
    if (plan.fork) state.forks[plan.target.repo.toLowerCase()] = plan.fork
    persist()
    return note
  },
}

/**
 * `/deploy`: restart onto the tracked branch, the way `ctl restart` does — re-attach it if a
 * rollback left the checkout detached, and SIGTERM ourselves, so running turns finish first and the
 * boot loop pulls and starts the new build. Nothing here needs a credential.
 */
let restarting = false
function restart() {
  restarting = true
  if (!build.branch) {
    try {
      execFileSync('git', ['-C', build.dir, 'checkout', '--quiet', build.ref], { stdio: 'ignore' })
    } catch (e) {
      log(`deploy: couldn't check out ${build.ref}: ${e.message}`)
    }
  }
  log(`deploy: restarting onto ${build.ref} (${state.deploy.to.slice(0, 7)}), asked by @${state.deploy.by}`)
  process.kill(process.pid, 'SIGTERM')
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
      comment(req, `@${req.author} you've reached today's limit of ${cfg.dailyLimit} requests — it resets at 00:00 UTC.`).catch(() => {})
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
  const polledAt = new Date().toISOString()
  const { notifications, lastModified, interval } = await poll(gh, state.lastModified)
  if (await readThreads(gh, { notifications, sweeps: state.sweeps, login: cfg.login, seen: state.seen, accept, log })) state.lastModified = lastModified
  state.polledAt = polledAt // what came in before this, the poll saw
  await persist()
  return interval
}

/** A volume, by name or id — made if it isn't there yet. */
async function ensureVolume(name) {
  const list = await bl.listVolumes()
  const volumes = Array.isArray(list) ? list : (list.volumes ?? list.items ?? list.data ?? [])
  const found = volumes.find((v) => v.name === name || v.id === name)
  if (found) return found
  const made = await bl.createVolume(name)
  log(`created volume ${name}`)
  return made
}

// A restart (`ctl restart`, a redeploy) must not cut off answers: accepted requests are marked
// seen, so a turn killed mid-way would never be retried. Take no new work, finish what's running.
// A build that fails its trial leaves the same way, then the launcher rolls it back.
let trialFailed = null
process.on('SIGTERM', async () => {
  if (draining) return
  draining = true
  await slackBot?.settle() // Slack requests already being accepted may still start their turns
  log(`SIGTERM: finishing ${inflight} running turn(s) before exiting`)
  for (let waited = 0; inflight > 0 && waited < cfg.jobTimeoutMs + 120_000; waited += 1000) await sleep(1000)
  // Slack's socket stays up until now: what still arrives is acked and kept for the next controller.
  slackBot?.stop()
  await slackBot?.settle()
  await persist()
  if (build.commit && trialFailed) failTrial(stateDir, build.commit, trialFailed)
  else if (build.commit) cleanExit(stateDir, build.commit) // a restart, not a failure: the launcher counts crashes only
  process.exit(trialFailed ? 1 : 0)
})

await ensureVolume(cfg.volume).catch((e) => log(`volume check: ${e.message} — create "${cfg.volume}" in the dashboard if this key lacks volume permissions`))
onRequest = accept
await status(`live as @${cfg.login}: proxy ${proxyUrl}, webhook ${proxyUrl}/webhook, ${cfg.maxConcurrent} concurrent turns, ${cfg.dailyLimit}/user/day, volume ${cfg.volume}, admins ${[...admins.values()].map((l) => `@${l}`).join(' ') || 'none'}, codex ${CODEX_VERSION}, build ${build.commit?.slice(0, 7) ?? '?'}`)

/** Keep idle per-user OAuth logins alive (Notion drops one unused for 30 days), and say in the
 * status how many people have linked what — the tools are per person, with no shared login. */
async function checkTools() {
  await userTools.keepAlive(log)
  await status(`tools: per person — ${await userTools.summary()}`, 'tools')
}
await checkTools().catch((e) => log(`tools: ${e.message}`))
setInterval(() => checkTools().catch((e) => log(`tools: ${e.message}`)), 3_600_000).unref()

/**
 * Slack is optional: its channel starts once the app's tokens are in — at start, or whenever `ctl
 * slack-tokens` hands them over. The Slack agent's memory, handed over at the switch
 * (slack-state.json), is taken in first, once.
 */
const track = (work) => {
  inflight++
  return work.finally(() => inflight--)
}
// One start at a time: a slow one overlapping the next try would open a second Socket Mode
// connection for the same app, and Slack would split the events between them.
let slackStarting = null
const startSlack = () => (slackStarting ??= connectSlack().finally(() => (slackStarting = null)))
async function connectSlack() {
  if (slackBot || draining) return true
  const tokens = {
    bot: first('SLACK_BOT_TOKEN', 'BOXLITE_SECRET_SLACK_BOT') || (await readSecretFile('slack-bot-token')),
    app: first('SLACK_APP_TOKEN', 'BOXLITE_SECRET_SLACK_APP') || (await readSecretFile('slack-app-token')),
  }
  if (!tokens.bot || !tokens.app) return false
  cfg.slackContextSecret ??= await slackContextSecret()
  // Slack's threads never share a volume or a context secret with GitHub's (session.mjs sideOf): a
  // config that would — one volume under two names, too — keeps Slack off rather than mixing them.
  const volumes = await Promise.all([ensureVolume(cfg.volume), ensureVolume(cfg.slackVolume)]).catch((e) => (log(`slack volume check: ${e.message} — create "${cfg.slackVolume}" in the dashboard if this key lacks volume permissions`), []))
  const mixed = mixedSides(cfg) ?? (volumes[0]?.id && volumes[0].id === volumes[1]?.id ? `GitHub and Slack threads can't share a volume (${cfg.volume} and ${cfg.slackVolume} are one)` : null)
  if (mixed) {
    await status(`slack: off — ${mixed}`, 'slack')
    return true // nothing to wait for: it takes another config and a restart
  }
  const handed = path.join(stateDir, 'slack-state.json')
  const raw = await readFile(handed, 'utf8').catch(() => null)
  if (raw) {
    importSlackState(state, JSON.parse(raw))
    await persist()
    await rename(handed, path.join(stateDir, 'slack-state.imported.json'))
    log(`slack: took in the Slack agent's memory: ${Object.keys(state.slack.threads).length} threads, ${state.slack.deferred.length} requests kept for us`)
  }
  const channel = await slackChannel({ tokens, cfg, slackState: state.slack, persist, schedule, track, draining: () => draining, jobs, bl, proxyUrl, userLogins: userTools, links, policy: TOOLS, turnCfg, status, log, prs: slackPrs, commands: slackCommands })
  if (draining) return true // shutting down meanwhile: the next controller connects
  slackBot = channel
  lastSlack = Date.now() // the trial and /healthz count Slack from its start
  channel.start()
  // "connected as", never "live as @": that's the deploy's sign the controller is up (ctl.mjs), and
  // the deploy's public log mustn't carry the workspace's name.
  await status(`slack: connected as @${channel.bot.name} in ${channel.bot.teamName}, ${cfg.slackDailyLimit ? `${cfg.slackDailyLimit}/person/day` : 'no daily limit'}, volume ${cfg.slackVolume}`, 'slack')
  return true
}
const slackOff = "slack: off until the Slack app's tokens are handed over — SLACK_BOT_TOKEN=xoxb-… SLACK_APP_TOKEN=xapp-… node deploy/ctl.mjs slack-tokens"
if (!(await startSlack().catch((e) => (log(`slack: ${e.message}`), false)))) {
  await status(slackOff, 'slack')
  const waiting = setInterval(async () => {
    if (await startSlack().catch((e) => (log(`slack: ${e.message}`), false))) clearInterval(waiting)
  }, 60_000)
  waiting.unref()
}

// Report how the last /deploy went, in the thread that asked; a deploy stays pending through the
// new build's trial, and the build is good (the launcher won't roll back past it) once it's over.
const rollback = takeRollback(stateDir)
if (rollback) await status(`rolled back from ${rollback.from.slice(0, 7)} to ${rollback.to.slice(0, 7)} at ${rollback.at}: ${rollback.why ?? 'it kept failing in its trial'}`, 'deploy')
const deploying = state.deploy
const outcome = deployOutcome({ pending: deploying, running: build.commit, rollback })
if (outcome) {
  log(`deploy: ${outcome}`)
  // Back where it was asked: a GitHub thread, or a Slack one (slack-channel.mjs).
  const said = deploying.reply?.slack
    ? slackBot?.post(deploying.reply.slack, outcome) ?? Promise.reject(new Error('Slack is off'))
    : comment(deploying.reply, outcome, { footer: false })
  await said.catch((e) => log(`deploy: couldn't report back: ${e.message}`))
}
if (deploying) {
  state.deploy = pendingAfter({ pending: deploying, running: build.commit, rollback })
  await persist()
}
// Running isn't enough to pass: a build that isn't polling — or, once Slack is set up, connected to
// it — by the end of its trial fails it. So does a new one that can't run a turn (deploy.mjs); the
// last good build doesn't take that test, since there would be nothing to roll back to.
const failTheTrial = (why) => {
  if (trialFailed) return
  trialFailed = why
  log(`build ${build.commit?.slice(0, 7)} ${why}: stopping, for the launcher to roll it back`)
  process.kill(process.pid, 'SIGTERM')
}
async function trialTurn() {
  const key = `${build.repo}#${TRIAL_TURN.number}`
  const jobToken = jobs.issue(3_600_000, key, { who: 'the trial', writes: [], tools: [] })
  try {
    return trialTurnFailure(await runTurn({ bl, cfg: turnCfg(), key, req: { repo: build.repo, number: TRIAL_TURN.number, isPR: false }, pr: null, prompt: TRIAL_TURN.prompt, jobToken, proxyUrl, log }))
  } catch (e) {
    return `couldn't run a turn in its trial (${e.message.slice(0, 160)})`
  } finally {
    jobs.revoke(jobToken)
  }
}
const trialTurns = build.commit && build.repo && build.commit !== goodBuild(stateDir)
  ? (async () => {
      await sleep(60_000) // live first, and polling
      for (let attempt = 1; ; attempt++) {
        const why = await trialTurn()
        if (!why) return log(`build ${build.commit.slice(0, 7)} ran a turn in its trial`), null
        if (attempt === 2) return failTheTrial(why), why
        log(`build ${build.commit.slice(0, 7)} ${why}; once more in 2 minutes, in case that passes`)
        await sleep(120_000)
      }
    })()
  : Promise.resolve(null)
setTimeout(async () => {
  const { ok, why } = health()
  if (!ok) return failTheTrial(`wasn't healthy at the end of its ${TRIAL_MS / 60_000}-minute trial (${why})`)
  if (await trialTurns) return // failed already; a turn still running at the end is waited for
  if (build.commit) markGood(stateDir, build.commit)
  if (state.deploy?.live && state.deploy.to === build.commit) {
    state.deploy = null
    await persist()
  }
  log(`build ${build.commit?.slice(0, 7)} passed its trial`)
}, TRIAL_MS)
for (;;) {
  let interval = 60
  try {
    interval = await tick()
    lastPoll = Date.now()
  } catch (e) {
    log(`poll: ${e.message}`)
  }
  beat() // the loop goes round, even when GitHub doesn't answer: that's progress to the watchdog
  await sleep(Math.max(interval, 30) * 1000)
}
