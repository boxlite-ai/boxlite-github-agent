import assert from 'node:assert/strict'
import { test } from 'node:test'
import { spawnSync, execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createDecipheriv, randomBytes } from 'node:crypto'
import { CODEX_VERSION } from '../src/codex.mjs'

// The real in-box runner (box/session.mjs) as a process: a fake `codex` on PATH, a pre-made
// checkout (so no network), a "volume" directory — then a second, fresh box restores from it.
const RUNNER = path.resolve('box/session.mjs')
const root = mkdtempSync(path.join(tmpdir(), 'runner-'))
const bin = path.join(root, 'bin')
mkdirSync(bin)
writeFileSync(
  path.join(bin, 'codex'),
  `#!/bin/sh
if [ "$1" = "--version" ]; then echo "codex-cli ${CODEX_VERSION}"; exit 0; fi
out=""; prev=""
for a in "$@"; do [ "$prev" = "-o" ] && out="$a"; prev="$a"; done
prompt=$(cat)
mkdir -p "$CODEX_HOME/sessions"
echo "turn: $prompt" >> "$CODEX_HOME/sessions/rollout.jsonl"
grep -o '"access_token":"[^"]*"' "$CODEX_HOME/auth.json" >> "$CODEX_HOME/sessions/rollout.jsonl"
echo "api-key-env: \${OPENAI_API_KEY:-none}" >> "$CODEX_HOME/sessions/rollout.jsonl"
echo '{"type":"thread.started","thread_id":"th-1"}'
echo '{"type":"item.completed","item":{"type":"agent_message","text":"hi"}}'
echo '{"type":"turn.completed","usage":{"input_tokens":1,"output_tokens":1}}'
printf 'Answer to: %s' "$prompt" > "$out"
`,
)
chmodSync(path.join(bin, 'codex'), 0o755)

const KEY = randomBytes(32).toString('base64')
const SNAPSHOT = path.join(root, 'vol', 'sessions', 'acme', 'app', '7', 'context.sealed')

function box(ctx, prompt, extraEnv = {}) {
  mkdirSync(path.join(ctx, 'repo'), { recursive: true })
  if (!existsSync(path.join(ctx, 'repo', '.git'))) execFileSync('git', ['init', '-q', path.join(ctx, 'repo')])
  const r = spawnSync(process.execPath, [RUNNER], {
    input: prompt,
    encoding: 'utf8',
    env: {
      PATH: `${bin}:${process.env.PATH}`,
      CTX: ctx,
      SNAPSHOT,
      CONTEXT_KEY: KEY,
      REPO: 'acme/app',
      NUMBER: '7',
      IS_PR: '0',
      CODEX_VERSION,
      BOTLITE_ARGS: JSON.stringify(['exec', '--json', '-o', path.join(ctx, 'last-message.md'), '-']),
      BOTLITE_JOB_TOKEN: 'job.token.sig',
      ...extraEnv,
    },
  })
  const lines = r.stdout.split('\n').filter(Boolean)
  return { r, lines, result: JSON.parse(lines.at(-1)) }
}

function snapshotEntries(key = KEY) {
  const sealed = readFileSync(SNAPSHOT)
  const d = createDecipheriv('aes-256-gcm', Buffer.from(key, 'base64'), sealed.subarray(0, 12))
  d.setAuthTag(sealed.subarray(12, 28))
  const tgz = Buffer.concat([d.update(sealed.subarray(28)), d.final()])
  return execFileSync('tar', ['tzf', '-'], { input: tgz, encoding: 'utf8' }).split('\n').filter(Boolean)
}

test('runner: streams Codex events, reports the answer, seals the context onto the volume', () => {
  const ctx = path.join(root, 'box-a')
  const { r, lines, result } = box(ctx, 'first question')
  assert.equal(r.status, 0, r.stderr)
  assert.deepEqual(JSON.parse(lines[0]), { type: 'thread.started', thread_id: 'th-1' })
  assert.deepEqual(result, { type: 'botlite.result', code: 0, lastMessage: 'Answer to: first question' })
  assert.ok(!readFileSync(SNAPSHOT).includes('first question')) // sealed, not plain tar
})

test('runner: Codex runs on the stand-in login — the job token, no API key — which is never saved', () => {
  const ctx = path.join(root, 'box-a')
  const rollout = readFileSync(path.join(ctx, 'codex', 'sessions', 'rollout.jsonl'), 'utf8')
  assert.match(rollout, /"access_token":"job\.token\.sig"/)
  assert.match(rollout, /api-key-env: none/)
  const auth = JSON.parse(readFileSync(path.join(ctx, 'codex', 'auth.json'), 'utf8'))
  assert.equal(auth.tokens.refresh_token, 'held-by-the-controller')
  assert.equal(statSync(path.join(ctx, 'codex', 'auth.json')).mode & 0o777, 0o600)
  const entries = snapshotEntries()
  assert.ok(entries.some((e) => e.includes('codex/sessions/rollout.jsonl')))
  assert.ok(!entries.some((e) => e.includes('auth.json')), entries.join(', '))
})

test('runner: a fresh box restores the thread context from the volume and carries on', () => {
  const ctx = path.join(root, 'box-b') // a brand-new box: nothing on its disk yet
  const { result } = box(ctx, 'follow-up')
  assert.equal(result.code, 0)
  assert.equal(readFileSync(path.join(ctx, 'codex', 'sessions', 'rollout.jsonl'), 'utf8').match(/^turn: /gm).length, 2)
})

test('runner: a snapshot sealed with another key is refused and the turn starts fresh', () => {
  const ctx = path.join(root, 'box-c')
  const { r, result } = box(ctx, 'q', { CONTEXT_KEY: randomBytes(32).toString('base64') })
  assert.equal(result.code, 0)
  assert.match(r.stderr, /context snapshot unusable, starting fresh/)
  assert.equal(readFileSync(path.join(ctx, 'codex', 'sessions', 'rollout.jsonl'), 'utf8').match(/^turn: /gm).length, 1)
  rmSync(root, { recursive: true, force: true })
})
