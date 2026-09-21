// @botlite — the controller: one long-running BoxLite box. It polls the bot account's GitHub
// notifications; each request that mentions @botlite becomes one Codex turn in that thread's own
// box (its context kept in the thread's subdirectory of the shared volume), and the answer is
// posted back as @botlite. It also holds the bot's ChatGPT login (Codex device auth) and serves
// it to session boxes only through its proxy, one job token per turn.
//
// Env — required: GITHUB_TOKEN (the bot's classic PAT: notifications + public_repo),
//   BOXLITE_API_KEY, CHATGPT_ACCESS_TOKEN + CHATGPT_REFRESH_TOKEN + CHATGPT_ACCOUNT_ID (from
//   `codex login --device-auth`), CONTEXT_SECRET. Credentials may instead arrive as BoxLite secret
//   placeholders: BOXLITE_SECRET_GITHUB / _BOXLITE / _CHATGPT_ACCESS / _CHATGPT_REFRESH.
// Optional: BOT_LOGIN (botlite), BOXLITE_URL (https://api.boxlite.ai), PORT (8788), PUBLIC_URL
//   (else looked up for this box, BOXLITE_BOX_ID), VOLUME (botlite-context), SESSION_IMAGE (node),
//   SESSION_CPUS (2), SESSION_MEMORY_MIB (4096), CODEX_MODEL, MAX_CONCURRENT (3),
//   DAILY_LIMIT_PER_USER (20), JOB_TIMEOUT_MIN (20), BOX_TTL_DAYS (3),
//   STATE_FILE (/var/lib/botlite/state.json; the refreshed ChatGPT login is kept beside it).
import { createHmac } from 'node:crypto'
import path from 'node:path'
import { github } from './github.mjs'
import { poll, requestsFrom, markRead } from './mentions.mjs'
import { loadState, saveState, takeQuota } from './state.mjs'
import { scheduler } from './jobs.mjs'
import { boxlite } from './boxlite.mjs'
import { runTurn } from './session.mjs'
import { newSessionPrompt, followUpPrompt } from './codex.mjs'
import { chatgptLogin, jobTokens } from './chatgpt.mjs'
import { createProxy } from './proxy.mjs'
import { react, reply } from './reply.mjs'

if (typeof WebSocket !== 'function') throw new Error('Node 22+ required (exec attach uses the global WebSocket)')
if (Object.keys(process.env).some((k) => k.startsWith('BOXLITE_SECRET_')) && !process.env.NODE_EXTRA_CA_CERTS) {
  console.warn('BoxLite secrets in use but NODE_EXTRA_CA_CERTS is unset: HTTPS to secret hosts will fail (SELF_SIGNED_CERT_IN_CHAIN)')
}

const env = process.env
const need = (...names) => {
  for (const n of names) if (env[n]) return env[n]
  throw new Error(`missing env ${names.join(' or ')}`)
}
const cfg = {
  login: env.BOT_LOGIN || 'botlite',
  githubToken: need('GITHUB_TOKEN', 'BOXLITE_SECRET_GITHUB'),
  boxliteKey: need('BOXLITE_API_KEY', 'BOXLITE_SECRET_BOXLITE'),
  contextSecret: need('CONTEXT_SECRET'),
  chatgpt: {
    access_token: need('CHATGPT_ACCESS_TOKEN', 'BOXLITE_SECRET_CHATGPT_ACCESS'),
    refresh_token: need('CHATGPT_REFRESH_TOKEN', 'BOXLITE_SECRET_CHATGPT_REFRESH'),
    account_id: need('CHATGPT_ACCOUNT_ID'),
    last_refresh: env.CHATGPT_LAST_REFRESH, // from the device login's auth.json; unset → refresh early
  },
  port: Number(env.PORT || 8788),
  volume: env.VOLUME || 'botlite-context',
  image: env.SESSION_IMAGE || 'node',
  cpus: Number(env.SESSION_CPUS || 2),
  memoryMib: Number(env.SESSION_MEMORY_MIB || 4096),
  model: env.CODEX_MODEL || undefined,
  maxConcurrent: Number(env.MAX_CONCURRENT || 3),
  dailyLimit: Number(env.DAILY_LIMIT_PER_USER || 20),
  jobTimeoutMs: Number(env.JOB_TIMEOUT_MIN || 20) * 60_000,
  boxTtlSec: Number(env.BOX_TTL_DAYS || 3) * 86_400,
  stateFile: env.STATE_FILE || '/var/lib/botlite/state.json',
}

const log = (...a) => console.log(new Date().toISOString(), ...a)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const gh = github(cfg.githubToken)
const bl = boxlite(cfg.boxliteKey, { base: env.BOXLITE_URL })
const state = await loadState(cfg.stateFile)
const schedule = scheduler(cfg.maxConcurrent)
let saving = Promise.resolve()
const persist = () => (saving = saving.then(() => saveState(cfg.stateFile, state)).catch((e) => log(`state not saved: ${e.message}`)))

// The ChatGPT login and the proxy that is the only way to it.
const chatgpt = chatgptLogin({ file: path.join(path.dirname(cfg.stateFile), 'chatgpt.json'), initial: cfg.chatgpt })
await chatgpt.load()
const jobSecret = createHmac('sha256', cfg.contextSecret).update('botlite:job-tokens').digest()
const jobs = jobTokens(jobSecret)
const proxy = createProxy({ login: chatgpt, secret: jobSecret, jobs, model: cfg.model, log })
await new Promise((resolve) => proxy.listen(cfg.port, '0.0.0.0', resolve))
const proxyUrl = (env.PUBLIC_URL || (await bl.previewUrl(need('BOXLITE_BOX_ID'), cfg.port)).url).replace(/\/+$/, '')
setInterval(() => {
  if (chatgpt.stale()) chatgpt.refresh().then(() => log('ChatGPT login refreshed'), (e) => log(e.message))
}, 3_600_000).unref()

async function prInfo(req) {
  const pr = await gh.json('GET', `/repos/${req.repo}/pulls/${req.number}`)
  return { headSha: pr.head.sha, baseRef: pr.base.ref }
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
 * the proxy honouring only live tokens, and the revoke below.
 */
async function turn(key, req, pr, prompt, sessionId) {
  const jobToken = jobs.issue(12 * 3_600_000, key)
  try {
    return await runTurn({ bl, cfg, key, req, pr, prompt, sessionId, jobToken, proxyUrl, log })
  } finally {
    jobs.revoke(jobToken)
  }
}

async function handle(req) {
  const key = `${req.repo}#${req.number}`
  try {
    const pr = req.isPR ? await prInfo(req) : null
    const known = state.threads[key]
    const fresh = async () => newSessionPrompt({ login: cfg.login, req, pr, comments: await recentComments(req) })
    const prompt = known?.sessionId
      ? followUpPrompt({ login: cfg.login, req, pr, headMoved: Boolean(pr && known.headSha && known.headSha !== pr.headSha) })
      : await fresh()
    let out = await turn(key, req, pr, prompt, known?.sessionId)
    if (out.sessionLost) {
      log(`${key}: session ${known.sessionId} is gone; starting over with the full thread`)
      out = await turn(key, req, pr, await fresh(), null)
    }
    state.threads[key] = { sessionId: out.sessionId ?? null, headSha: pr?.headSha ?? known?.headSha ?? null, lastUsed: new Date().toISOString() }
    persist()
    if (out.message) {
      await reply(gh, req, out.message)
      log(`${key}: answered @${req.author}`)
    } else {
      log(`${key}: no answer — ${out.error}`)
      await reply(gh, req, `@${req.author} sorry, I couldn't finish this one — the run failed on my side. Please try again in a bit.`)
    }
  } catch (e) {
    log(`${key}: ${e.stack || e.message}`)
    await reply(gh, req, `@${req.author} sorry, something went wrong on my side. Please try again in a bit.`).catch(() => {})
  }
}

function accept(req) {
  state.seen.add(req.id) // at most once: a crash mid-run must not produce a second reply later
  if (!takeQuota(state, req.author, cfg.dailyLimit)) {
    const usage = state.usage[req.author]
    log(`@${req.author} is over today's limit`)
    if (!usage.notified) {
      usage.notified = true
      reply(gh, req, `@${req.author} you've reached today's limit of ${cfg.dailyLimit} requests — it resets at 00:00 UTC.`).catch(() => {})
    }
    return
  }
  log(`${req.repo}#${req.number}: request from @${req.author} (${req.url})`)
  react(gh, req).catch(() => {})
  schedule(`${req.repo}#${req.number}`, () => handle(req))
}

async function tick() {
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

process.on('SIGTERM', async () => {
  await persist()
  process.exit(0)
})

await ensureVolume().catch((e) => log(`volume check: ${e.message} — create "${cfg.volume}" in the dashboard if this key lacks volume permissions`))
log(`@${cfg.login} up: proxy ${proxyUrl}, ${cfg.maxConcurrent} concurrent turns, ${cfg.dailyLimit}/user/day, volume ${cfg.volume}`)
for (;;) {
  let interval = 60
  try {
    interval = await tick()
  } catch (e) {
    log(`poll: ${e.message}`)
  }
  await sleep(Math.max(interval, 30) * 1000)
}
