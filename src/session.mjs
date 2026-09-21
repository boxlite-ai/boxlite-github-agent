// One Codex turn for a thread, in the thread's own BoxLite box. The box is disposable: its live
// state is on its own disk, and the thread's context is kept as a sealed snapshot in the
// thread's subdirectory of the shared volume (box/session.mjs), so a box that auto-deleted is
// simply recreated and carries on. Between turns the box is stopped — that ends anything a turn
// left running and stops the meter; the next exec starts it again.
import { createHash, createHmac } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { codexArgs, applyEvent, newRun, CODEX_VERSION } from './codex.mjs'

const RUNNER = readFileSync(new URL('../box/session.mjs', import.meta.url), 'utf8')
const VOLUME_PATH = '/vol'
const CTX = '/ctx'

/** Box names are unique per org: a stable hash of the thread, so a thread always finds its box. */
export const boxName = (key) => `botlite-${createHash('sha256').update(key).digest('hex').slice(0, 20)}`
/** The thread's subdirectory of the shared volume, e.g. /vol/sessions/acme/app/7. */
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
    auto_stop: 900, // safety net; the controller stops the box after every turn
    auto_delete: cfg.boxTtlSec, // a quiet thread's box goes; its context stays on the volume
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
 * controller's public origin. @returns {{ sessionId, message, error, sessionLost }}.
 */
export async function runTurn({ bl, cfg, key, req, pr, prompt, sessionId, jobToken, proxyUrl, log = () => {} }) {
  const box = await ensureBox(bl, boxName(key), cfg)
  const boxId = box.id || box.name
  // A stopped (or stopping) box: start it now rather than leaning on exec auto-resume, which can
  // race the attach handshake (seen live).
  if (!/running/i.test(String(box.status ?? box.state ?? ''))) await bl.startBox(boxId).catch((e) => log(`start ${boxId}: ${e.message}`))
  const args = codexArgs({ sessionId, cwd: `${CTX}/repo`, outFile: `${CTX}/last-message.md`, proxyUrl, model: cfg.model })
  const { execution_id: execId } = await bl.startExec(boxId, {
    command: 'node',
    args: ['--input-type=module', '-e', RUNNER],
    env: {
      CTX,
      SNAPSHOT: snapshotPath(key),
      CONTEXT_KEY: contextKey(cfg.contextSecret, key),
      REPO: req.repo,
      NUMBER: String(req.number),
      IS_PR: req.isPR ? '1' : '0',
      HEAD_SHA: pr?.headSha ?? '',
      BASE_REF: pr?.baseRef ?? '',
      CODEX_VERSION,
      BOTLITE_ARGS: JSON.stringify(args),
      BOTLITE_JOB_TOKEN: jobToken,
    },
    timeout_seconds: Math.ceil(cfg.jobTimeoutMs / 1000),
  })

  const run = newRun()
  let result = null
  let pending = ''
  let stderr = ''
  try {
    await bl.attach(boxId, execId, {
      stdin: prompt,
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
  return { sessionId: run.sessionId ?? sessionId, message, error, sessionLost }
}
