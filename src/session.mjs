// One Codex turn for a thread, in the thread's own BoxLite box. The box is disposable: its live
// state is on its own disk, and the thread's context is kept as a sealed snapshot in the
// thread's subdirectory of the shared volume (box/session.mjs), so a box that auto-deleted is
// simply recreated and carries on. Between turns the box is stopped — that ends anything a turn
// left running and stops the meter; the next exec starts it again.
//
// A GitHub thread (owner/repo#n) and a Slack thread (team/channel/ts) never share anything: their
// boxes are named apart, and each kind has its own volume and its own secret for context keys — so
// a box running a public GitHub thread's code, at anyone's request, doesn't even mount where the
// team's Slack conversations are kept (sideOf). Nor the other way round: BoxLite has no read-only
// mounts yet, and a Slack box that mounted the GitHub volume could leave something there for every
// GitHub box to read.
import { createHash, createHmac } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { codexArgs, codexConfig, applyEvent, newRun, CODEX_VERSION } from './codex.mjs'

const RUNNER = readFileSync(new URL('../box/session.mjs', import.meta.url), 'utf8')
const VOLUME_PATH = '/vol'
const CTX = '/ctx'
const SLACK_KEY = /^[A-Z0-9]+\/[A-Z0-9]+\/\d+\.\d+$/
const GITHUB_KEY = /^[\w.-]+\/[\w.-]+#\d+$/

/** Why this config would let Slack and GitHub threads share a volume or context keys — or null. */
export function mixedSides(cfg) {
  if (cfg.volume && cfg.volume === cfg.slackVolume) return `GitHub and Slack threads can't share a volume (both are ${cfg.volume})`
  if (cfg.contextSecret && cfg.contextSecret === cfg.slackContextSecret) return "GitHub and Slack threads can't share a context secret"
  return null
}

/**
 * A thread's side — its volume and the secret its context key comes from — checked: the key must
 * be of the kind the turn says it is, and the config must keep the two kinds apart.
 */
export function sideOf(key, cfg, { slack = false } = {}) {
  if (!(slack ? SLACK_KEY : GITHUB_KEY).test(key)) throw new Error(`not a ${slack ? 'Slack' : 'GitHub'} thread: ${key}`) // it becomes a box name and a volume path
  const mixed = mixedSides(cfg)
  if (mixed) throw new Error(mixed)
  const side = slack ? { volume: cfg.slackVolume, secret: cfg.slackContextSecret } : { volume: cfg.volume, secret: cfg.contextSecret }
  if (!side.volume || !side.secret) throw new Error(`${slack ? 'Slack' : 'GitHub'} threads have no volume or context secret set`)
  return side
}

/** A Slack thread: workspace / channel / parent message ts, e.g. T01ABC/C02DEF/1712345678.000100. */
export function slackThreadKey(req) {
  const key = `${req.team}/${req.channel}/${req.threadTs}`
  if (!SLACK_KEY.test(key)) throw new Error(`not a Slack thread: ${key}`) // it becomes a box name and a volume path
  return key
}
/**
 * A thread's box, by a name that says which thread it runs — botlite-gh-acme-app-7-3fa9c1e2d4b6a8c0,
 * botlite-slack-dm-alice-0922-… — for anyone looking at BoxLite. The words are only for reading;
 * what makes the name the thread's alone is the hash of its whole key, long enough that nobody can
 * pick a key (a repo name, say) to land in another thread's box, where that thread's context lies
 * unsealed while the box lives. A GitHub thread's words are its key; a Slack thread's (`label`)
 * are kept with the thread, since they come from names that can change.
 */
export function boxName(key, { slack = false, label } = {}) {
  // A GitHub thread's words end in its number, kept whole: it's what tells one repo's threads apart.
  const words = slack ? slug(String(label ?? ''), 32) : ((repo, n) => [slug(repo, 31 - n.length), n].filter(Boolean).join('-'))(...key.split('#'))
  return `botlite-${slack ? 'slack' : 'gh'}-${words ? `${words}-` : ''}${createHash('sha256').update(key).digest('hex').slice(0, 16)}`
}
/** Lower-case letters, digits and single hyphens, at most `max` long — accents dropped, not the letters. */
const slug = (s, max) => s.normalize('NFKD').replace(/\p{M}+/gu, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+/, '').slice(0, max).replace(/-+$/, '')
/** The thread's subdirectory of its volume, e.g. /vol/sessions/acme/app/7 or /vol/sessions/T01/C02/1712345678.000100. */
export const snapshotPath = (key) => `${VOLUME_PATH}/sessions/${key.replace('#', '/')}/context.sealed`
/** Per-thread snapshot key: only this thread's box is ever handed it. */
export const contextKey = (secret, key) => createHmac('sha256', secret).update(`context:${key}`).digest('base64')

export function boxSpec(name, cfg) {
  return {
    name,
    image: cfg.image,
    cpus: cfg.cpus,
    memory_mib: cfg.memoryMib,
    network: { mode: 'enabled' }, // outbound only: the box is never reachable from outside
    volumes: [{ managed_volume: cfg.volume, guest_path: VOLUME_PATH }],
    // No secrets at all: the model is reached through the controller with a per-job token.
    // BoxLite's lifecycle is in seconds, 0 = off. The controller stops the box after every turn,
    // and a turn can outlast any idle window, so no auto-stop; a stopped box is deleted once the
    // thread has been quiet a while (BOX_TTL_MIN), since its context is sealed on the volume and
    // restores into a new one.
    auto_stop: 0,
    auto_delete: cfg.boxDeleteSec,
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** The thread's box — found by name, else created. A 408 means "still starting", a 409 a race. */
export async function ensureBox(bl, name, cfg) {
  const found = await bl.getBox(name)
  if (found) return found
  try {
    return await bl.createBox(boxSpec(name, cfg))
  } catch (e) {
    if (e.status !== 408 && e.status !== 409) throw e
    for (let i = 0; i < 30; i++) {
      await sleep(5000)
      const box = await bl.getBox(name)
      if (box && box.status !== 'creating' && box.state !== 'creating') return box
    }
    throw new Error(`box ${name} did not come up`)
  }
}

/**
 * Run one turn. `jobToken` is the box's stand-in ChatGPT login for this turn, `proxyUrl` the
 * controller's public origin. On a write turn `write` ({ base, baseUrl, staging }, publish.mjs)
 * puts the checkout on its base commit and has the runner push what Codex commits to the staging
 * branch, through the controller. A Slack turn (`slack`) has a working directory instead of a
 * checkout, and its request's `files` ([{ path, data (base64) }]) travel with the prompt on the
 * exec's stdin, so no other box — and nothing on the volume — ever holds them. `tools` are the
 * team's tool services the turn may use (tools.mjs enabledServices); `label` a Slack thread's words
 * for its box name (boxName); `prs` lets a Slack turn ask for a PR's push once its work is done
 * (box/session.mjs, prgrant.mjs).
 * @returns {{ sessionId, message, error, sessionLost, push }}.
 */
export async function runTurn({ bl, cfg, key, label, req, pr, prompt, files = [], tools = [], sessionId, jobToken, proxyUrl, write, slack = false, prs = false, log = () => {} }) {
  const side = sideOf(key, cfg, { slack })
  const name = boxName(key, { slack, label })
  const boxCfg = { ...cfg, volume: side.volume } // its own side's volume, and only that one
  const args = codexArgs({ sessionId, cwd: `${CTX}/${slack ? 'work' : 'repo'}`, outFile: `${CTX}/last-message.md`, proxyUrl, model: cfg.model, effort: cfg.effort, tools })
  const exec = {
    command: 'node',
    args: ['--input-type=module', '-e', RUNNER],
    env: {
      CTX,
      SNAPSHOT: snapshotPath(key),
      CONTEXT_KEY: contextKey(side.secret, key),
      ...(slack ? {} : { REPO: req.repo, NUMBER: String(req.number), IS_PR: req.isPR ? '1' : '0', HEAD_SHA: pr?.headSha ?? '', BASE_REF: pr?.baseRef ?? '' }),
      CODEX_VERSION,
      BOTLITE_ARGS: JSON.stringify(args),
      CODEX_CONFIG: JSON.stringify(codexConfig(proxyUrl)),
      BOTLITE_JOB_TOKEN: jobToken,
      ...(write ? { BASE_SHA: write.base, BASE_URL: write.baseUrl, PUSH_URL: `${proxyUrl}/git`, PUSH_REF: `refs/heads/${write.staging}` } : {}),
      ...(slack && prs ? { PR_URL: `${proxyUrl}/pr`, PUSH_URL: `${proxyUrl}/git` } : {}),
    },
    timeout_seconds: Math.ceil(cfg.jobTimeoutMs / 1000),
  }
  const start = async () => {
    const box = await ensureBox(bl, name, boxCfg)
    const boxId = box.id || box.name
    // A stopped (or stopping) box: start it now rather than leaning on exec auto-resume, which can
    // race the attach handshake (seen live).
    if (!/running/i.test(String(box.status ?? box.state ?? ''))) await bl.startBox(boxId).catch((e) => log(`start ${boxId}: ${e.message}`))
    return { boxId, ...(await bl.startExec(boxId, exec)) }
  }
  // A stopped box is deleted once its thread has been quiet a while (auto_delete): one found just
  // before it went is gone by the exec, a 404 — then the thread gets a new box, once.
  const { boxId, execution_id: execId } = await start().catch((e) => {
    if (e.status !== 404) throw e
    log(`${name} went as it was reused: a new one`)
    return start()
  })

  const run = newRun()
  let result = null
  let pending = ''
  let stderr = ''
  try {
    await bl.attach(boxId, execId, {
      stdin: JSON.stringify({ prompt, files: files.map(({ path, data }) => ({ path, data })) }),
      timeoutMs: cfg.jobTimeoutMs + 120_000,
      onStdout: (chunk) => {
        pending += chunk
        let i
        while ((i = pending.indexOf('\n')) >= 0) {
          const line = pending.slice(0, i)
          pending = pending.slice(i + 1)
          if (line.startsWith('{"type":"botlite.result"')) result = JSON.parse(line)
          else applyEvent(run, line)
        }
      },
      onStderr: (chunk) => {
        stderr = (stderr + chunk).slice(-4000)
      },
    })
  } finally {
    await bl.stopBox(boxId).catch((e) => log(`stop ${boxId}: ${e.message}`))
  }

  if (result?.snapshotError) log(`${key}: context snapshot not saved: ${result.snapshotError}`)
  const message = result?.lastMessage?.trim() || run.message
  const error = message
    ? null
    : result?.setupError || run.error || result?.spawnError || `no answer (exit ${result?.code ?? '?'}): ${stderr.slice(-400)}`
  // Codex's exact words when the session to resume is gone (its snapshot was lost/rejected).
  const sessionLost = Boolean(sessionId) && !message && /no rollout found for thread id/.test(stderr)
  if (result?.tooling?.error) log(`${key}: agent-tooling not installed: ${result.tooling.error}`)
  return { sessionId: run.sessionId ?? sessionId, message, error, sessionLost, push: result?.push ?? null, tooling: result?.tooling ?? null }
}
