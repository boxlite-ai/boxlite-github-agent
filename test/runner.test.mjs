import assert from 'node:assert/strict'
import { test, after } from 'node:test'
import http from 'node:http'
import { spawn, spawnSync, execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createDecipheriv, randomBytes } from 'node:crypto'
import { CODEX_VERSION, codexConfig } from '../src/codex.mjs'
import { jobTokens } from '../src/chatgpt.mjs'
import { gitPushHandler } from '../src/gitpush.mjs'
import { gitServer } from './gitserver.mjs'

// The real in-box runner (box/session.mjs) as a process: a fake `codex` on PATH, a pre-made
// checkout (so no network), a "volume" directory — then a second, fresh box restores from it.
// A prompt that says COMMIT makes the fake Codex commit a change, as a write turn would.
const RUNNER = path.resolve('box/session.mjs')
const root = mkdtempSync(path.join(tmpdir(), 'runner-'))
after(() => rmSync(root, { recursive: true, force: true }))
const bin = path.join(root, 'bin')
mkdirSync(bin)
writeFileSync(
  path.join(bin, 'codex'),
  `#!/bin/sh
if [ "$1" = "--version" ]; then echo "codex-cli ${CODEX_VERSION}"; exit 0; fi
if [ "$1" = "plugin" ]; then
  echo "$*" >> "$CODEX_HOME/plugin-calls.log"
  case "$*" in
    *"marketplace add"*) if [ -f "$CODEX_HOME/.marketplace" ]; then echo '{"alreadyAdded":true}'; else touch "$CODEX_HOME/.marketplace"; echo '{"alreadyAdded":false}'; fi ;;
    *"marketplace upgrade"*) echo '{"errors":[]}' ;;
    *) echo '{"version":"0.1.18"}' ;;
  esac
  exit 0
fi
out=""; prev=""
for a in "$@"; do [ "$prev" = "-o" ] && out="$a"; prev="$a"; done
prompt=$(cat)
mkdir -p "$CODEX_HOME/sessions"
echo "turn: $prompt" >> "$CODEX_HOME/sessions/rollout.jsonl"
grep -o '"access_token":"[^"]*"' "$CODEX_HOME/auth.json" >> "$CODEX_HOME/sessions/rollout.jsonl"
echo "api-key-env: \${OPENAI_API_KEY:-none}" >> "$CODEX_HOME/sessions/rollout.jsonl"
case "$prompt" in *COMMIT*) printf 'fixed\\n' > fix.txt && git add fix.txt && git commit -qm "Fix the thing" ;; esac
case "$prompt" in *FAIL*) echo '{"type":"turn.failed","error":{"message":"boom"}}'; exit 1 ;; esac
echo '{"type":"thread.started","thread_id":"th-1"}'
echo '{"type":"item.completed","item":{"type":"agent_message","text":"hi"}}'
echo '{"type":"turn.completed","usage":{"input_tokens":1,"output_tokens":1}}'
printf 'Answer to: %s' "$prompt" > "$out"
`,
)
chmodSync(path.join(bin, 'codex'), 0o755)

const KEY = randomBytes(32).toString('base64')
const SNAPSHOT = path.join(root, 'vol', 'sessions', 'acme', 'app', '7', 'context.sealed')

function box(ctx, prompt, extraEnv = {}, files = []) {
  mkdirSync(path.join(ctx, 'repo'), { recursive: true })
  if (!existsSync(path.join(ctx, 'repo', '.git'))) execFileSync('git', ['init', '-q', path.join(ctx, 'repo')])
  const r = spawnSync(process.execPath, [RUNNER], {
    input: JSON.stringify({ prompt, files }),
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
  assert.deepEqual(result, { type: 'botlite.result', code: 0, lastMessage: 'Answer to: first question', tooling: { version: '0.1.18' } })
  assert.ok(!readFileSync(SNAPSHOT).includes('first question')) // sealed, not plain tar
})

test('runner: agent-tooling goes into every box — added once, refreshed when its last check is over 10 minutes old', () => {
  const ctx = path.join(root, 'box-tooling')
  const own = { SNAPSHOT: path.join(root, 'vol-tooling', 'context.sealed') } // its own thread: the others' turn counts stay put
  box(ctx, 'first', own)
  const calls = () => readFileSync(path.join(ctx, 'codex', 'plugin-calls.log'), 'utf8').trim().split('\n')
  assert.deepEqual(calls(), [
    'plugin marketplace add https://github.com/boxlite-ai/agent-tooling.git --ref main --json',
    'plugin add boxlite-agent-tooling@boxlite-agent-tooling --json', // a fresh marketplace needs no upgrade
  ])
  box(ctx, 'again, right away', own)
  assert.equal(calls().filter((c) => c.includes('upgrade')).length, 0) // checked minutes ago
  writeFileSync(path.join(ctx, 'codex', '.agent-tooling-checked'), String(Date.now() - 11 * 60_000))
  const { result } = box(ctx, 'later', own)
  assert.deepEqual(calls().slice(-3), [
    'plugin marketplace add https://github.com/boxlite-ai/agent-tooling.git --ref main --json',
    'plugin marketplace upgrade boxlite-agent-tooling --json', // the tip of main
    'plugin add boxlite-agent-tooling@boxlite-agent-tooling --json',
  ])
  assert.deepEqual(result.tooling, { version: '0.1.18' })
  // Its hooks' state lives in the checkout; git never picks it up (so a PR can't carry it).
  assert.equal(readFileSync(path.join(ctx, 'repo', '.git', 'info', 'exclude'), 'utf8').split('\n').filter((l) => l === '.agents/state/').length, 1)
  assert.equal(box(path.join(root, 'box-off'), 'no tooling', { ...own, AGENT_TOOLING: 'off' }).result.tooling, null)
})

test('runner: every codex in the box goes through the controller — the routing is in config.toml, around agent-tooling’s settings', () => {
  const ctx = path.join(root, 'box-config')
  const own = { SNAPSHOT: path.join(root, 'vol-config', 'context.sealed') }
  mkdirSync(path.join(ctx, 'codex'), { recursive: true })
  // What agent-tooling's install leaves (seen with Codex 0.155.1), after an earlier turn's routing.
  const agentTooling = '[marketplaces.boxlite-agent-tooling]\nsource_type = "git"\nsource = "https://github.com/boxlite-ai/agent-tooling.git"\nref = "main"\n\n[plugins."boxlite-agent-tooling@boxlite-agent-tooling"]\nenabled = true'
  writeFileSync(path.join(ctx, 'codex', 'config.toml'), `model_provider = "botlite"\nchatgpt_base_url = "https://old.example/backend-api/"\n\n${agentTooling}\n\n[model_providers.botlite]\nname = "botlite"\nbase_url = "https://old.example/backend-api/codex"\n`)
  const config = () => readFileSync(path.join(ctx, 'codex', 'config.toml'), 'utf8')
  const count = (re) => (config().match(re) ?? []).length
  for (const proxy of ['https://proxy.example', 'https://moved.example']) {
    const { result } = box(ctx, 'q', { ...own, CODEX_CONFIG: JSON.stringify(codexConfig(proxy)) })
    assert.equal(result.code, 0)
    assert.equal(count(/^model_provider = "botlite"$/gm), 1)
    assert.equal(count(/^\[model_providers\.botlite\]$/gm), 1)
    assert.equal(count(/old\.example/g), 0)
    assert.equal(config().split(`"${proxy}/backend-api/codex"`).length - 1, 1)
    assert.ok(config().includes(agentTooling), config()) // agent-tooling's own settings, untouched
    assert.ok(config().indexOf('chatgpt_base_url') < config().indexOf('['), 'top-level keys come before any table')
  }
})

test('runner: a Slack thread works in its own directory; its files land where the prompt says — and nowhere outside slack-files/', () => {
  const ctx = path.join(root, 'box-slack')
  const slack = { REPO: '', SNAPSHOT: path.join(root, 'vol-slack', 'T01', 'C01', '1712345678.000100', 'context.sealed') }
  const files = [
    { path: 'slack-files/1712345699.000200/ci.log', data: Buffer.from('npm ERR! boom\n').toString('base64') },
    { path: 'slack-files/../../escape.txt', data: Buffer.from('no').toString('base64') },
    { path: '/etc/passwd', data: Buffer.from('no').toString('base64') },
  ]
  const { result } = box(ctx, 'what failed?', slack, files)
  assert.equal(result.code, 0)
  assert.equal(readFileSync(path.join(ctx, 'work', 'slack-files', '1712345699.000200', 'ci.log'), 'utf8'), 'npm ERR! boom\n')
  assert.equal(existsSync(path.join(ctx, 'escape.txt')), false)
  assert.equal(existsSync(path.join(ctx, 'work', 'escape.txt')), false)
  assert.equal(existsSync(path.join(ctx, 'repo', 'fix.txt')), false) // no checkout involved
})

test('runner: a failed turn never reports the previous turn’s answer', () => {
  const ctx = path.join(root, 'box-stale')
  const own = { SNAPSHOT: path.join(root, 'vol-stale', 'context.sealed') }
  assert.match(box(ctx, 'first', own).result.lastMessage, /first$/)
  const { result } = box(ctx, 'FAIL please', own) // the same box: last turn's answer file is still on its disk
  assert.equal(result.code, 1)
  assert.equal(result.lastMessage, undefined)
})

test('runner: a thread resumed on a fresh box is told its files are gone; on the same box it isn’t', () => {
  const own = { SNAPSHOT: path.join(root, 'vol-moved', 'context.sealed') }
  box(path.join(root, 'box-moved-a'), 'start', own)
  const resume = (ctx) => ({ ...own, BOTLITE_ARGS: JSON.stringify(['exec', 'resume', '--json', '-o', path.join(ctx, 'last-message.md'), 'th-1', '-']) })
  const ctx = path.join(root, 'box-moved-b') // a brand-new box: nothing on its disk yet
  box(ctx, 'follow-up', resume(ctx))
  const turns = () => readFileSync(path.join(ctx, 'codex', 'sessions', 'rollout.jsonl'), 'utf8').match(/^turn: .*$/gm)
  assert.match(turns().at(-1), /^turn: \(From the controller, not a user: this thread has moved to a fresh machine/)
  box(ctx, 'again', resume(ctx))
  assert.equal(turns().at(-1), 'turn: again') // same box: nothing was lost
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
})

// A write turn end to end: the runner checks out the controller's base commit, the fake Codex
// commits, the runner pushes with its job token to the controller's git route, which lets only
// the granted staging ref through to a fake github.com (`git http-backend`) holding the fork.
const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim()
const UPSTREAM = path.join(root, 'upstream.git')
const FORK = path.join(root, 'github', 'botlite', 'app.git')
const STAGING = 'refs/heads/botlite-staging/acme/app/7'

async function writeTurn(ctx, prompt, token) {
  mkdirSync(path.join(ctx, 'repo'), { recursive: true })
  execFileSync('git', ['init', '-q', path.join(ctx, 'repo')])
  const child = spawn(process.execPath, [RUNNER], {
    env: {
      PATH: `${bin}:${process.env.PATH}`, CTX: ctx, CONTEXT_KEY: KEY, REPO: 'acme/app', NUMBER: '7', IS_PR: '0', CODEX_VERSION,
      BOTLITE_ARGS: JSON.stringify(['exec', '--json', '-o', path.join(ctx, 'last-message.md'), '-']),
      BOTLITE_JOB_TOKEN: token, BASE_SHA: writeTurn.base, BASE_URL: UPSTREAM, PUSH_URL: writeTurn.pushUrl, PUSH_REF: STAGING,
    },
  })
  let stdout = ''
  child.stdout.on('data', (d) => (stdout += d))
  child.stdin.end(JSON.stringify({ prompt, files: [] }))
  await new Promise((r) => child.on('close', r))
  return JSON.parse(stdout.trim().split('\n').at(-1))
}

test('runner: a write turn starts on the base commit and pushes what Codex committed — through the controller only', async () => {
  const seed = path.join(root, 'seed')
  git('init', '-q', '-b', 'main', seed)
  writeFileSync(path.join(seed, 'README'), 'app\n')
  git('-C', seed, 'add', 'README')
  git('-C', seed, '-c', 'user.name=u', '-c', 'user.email=u@u', 'commit', '-qm', 'init')
  git('clone', '-q', '--bare', seed, UPSTREAM)
  writeTurn.base = git('-C', seed, 'rev-parse', 'HEAD')
  mkdirSync(path.dirname(FORK), { recursive: true })
  git('init', '-q', '--bare', FORK)

  const SECRET = Buffer.from('job-secret')
  const jobs = jobTokens(SECRET)
  const github = await gitServer(path.join(root, 'github'))
  const proxy = http.createServer(gitPushHandler({ secret: SECRET, jobs, upstream: github.url }))
  await new Promise((r) => proxy.listen(0, '127.0.0.1', r))
  writeTurn.pushUrl = `http://127.0.0.1:${proxy.address().port}/git`
  const grant = { ref: STAGING, open: async () => ({ repo: 'botlite/app', token: 'ghs_turn' }) }
  try {
    const token = jobs.issue(60_000, 'acme/app#7', { push: grant })
    const result = await writeTurn(path.join(root, 'box-w'), 'COMMIT a fix', token)
    assert.equal(result.code, 0)
    assert.match(result.push.pushed, /^[0-9a-f]{40}$/)
    assert.equal(git('--git-dir', FORK, 'rev-parse', STAGING), result.push.pushed) // landed on the one staging ref
    assert.equal(git('--git-dir', FORK, 'rev-parse', `${STAGING}^`), writeTurn.base) // on top of the base
    assert.equal(git('--git-dir', FORK, 'show', `${STAGING}:fix.txt`), 'fixed')
    assert.equal(git('-C', path.join(root, 'box-w', 'repo'), 'rev-parse', '--abbrev-ref', 'HEAD'), 'botlite')
    jobs.revoke(token)

    const quiet = jobs.issue(60_000, 'acme/app#7', { push: grant })
    assert.deepEqual((await writeTurn(path.join(root, 'box-q'), 'just a question', quiet)).push, { pushed: null, uncommitted: false })
    jobs.revoke(quiet)

    const readOnly = jobs.issue(60_000, 'acme/app#7') // a job without a push grant
    const refused = await writeTurn(path.join(root, 'box-r'), 'COMMIT anyway', readOnly)
    assert.equal(refused.push.pushed, null)
    assert.match(refused.push.error, /403/)
    jobs.revoke(readOnly)
  } finally {
    proxy.close()
    github.close()
  }
})
