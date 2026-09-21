import assert from 'node:assert/strict'
import { test } from 'node:test'
import { spawnSync, execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { randomBytes } from 'node:crypto'
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
echo "key-seen: $OPENAI_API_KEY" >> "$CODEX_HOME/sessions/rollout.jsonl"
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
      BOXLITE_SECRET_OPENAI: '<BOXLITE_SECRET:openai>',
      ...extraEnv,
    },
  })
  const lines = r.stdout.split('\n').filter(Boolean)
  return { r, lines, result: JSON.parse(lines.at(-1)) }
}

test('runner: streams Codex events, reports the answer, seals the context onto the volume', () => {
  const ctx = path.join(root, 'box-a')
  const { r, lines, result } = box(ctx, 'first question')
  assert.equal(r.status, 0, r.stderr)
  assert.deepEqual(JSON.parse(lines[0]), { type: 'thread.started', thread_id: 'th-1' })
  assert.deepEqual({ ...result, lastMessage: result.lastMessage }, { type: 'botlite.result', code: 0, lastMessage: 'Answer to: first question' })
  const sealed = readFileSync(SNAPSHOT)
  assert.ok(!sealed.includes('first question')) // sealed, not plain tar
  assert.match(readFileSync(path.join(ctx, 'codex', 'sessions', 'rollout.jsonl'), 'utf8'), /key-seen: <BOXLITE_SECRET:openai>/)
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
