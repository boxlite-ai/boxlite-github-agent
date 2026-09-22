// Runs INSIDE a session box — one box per thread: a GitHub issue or PR, or a Slack thread — as the
// program of each exec. The controller stays attached: it streams the request in on stdin
// ({ prompt, files } as JSON) and reads Codex's JSONL events from stdout.
//
// Live state is on the box's own disk (git and Codex need rename/append, which the S3-backed
// volume lacks): /ctx/repo, a GitHub thread's checkout, or /ctx/work, a Slack thread's working
// directory (its request's files under slack-files/) · /ctx/codex CODEX_HOME · /ctx/home HOME.
// After every turn the thread's context (CODEX_HOME) is snapshotted into the thread's
// subdirectory of the shared volume, sealed with the thread's own key — every box mounts the
// whole volume, so another thread's box can delete a snapshot but never read or forge one — and
// a fresh box picking the thread up restores it, so `codex exec resume` carries on.
//
// Codex runs logged in to ChatGPT with a stand-in login: auth.json holds this job's token (from
// the controller, useless once the job ends), never the bot's real ChatGPT login — the controller
// proxy swaps that in. It is rewritten every turn and never snapshotted.
//
// A write turn (PUSH_REF set) starts from the commit the controller chose (BASE_SHA, fetched
// anonymously from BASE_URL) on a local `botlite` branch; whatever Codex commits is pushed after
// it exits, with the same job token, to the controller (PUSH_URL), which lets exactly PUSH_REF
// through. A Slack turn has no repo to start from: Codex clones what it needs, and to propose a
// change leaves pr.json ({ repo, dir }) in the working directory; after it exits, this asks the
// controller for the push (PR_URL) and pushes that clone's commits to the ref it's given.
// Nothing here is a check — Codex could rewrite this runner — the controller checks.
import { spawn, execFileSync } from 'node:child_process'
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'

process.on('SIGHUP', () => {}) // a dropped attach gets a reconnect grace; don't die in it

const E = process.env
// An exec given its own env gets no PATH (seen live): without this, tar/git/npm/codex are ENOENT.
E.PATH ||= '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin'
const CTX = E.CTX || '/ctx'
const REPO_DIR = path.join(CTX, 'repo')
const WORK = E.REPO ? REPO_DIR : path.join(CTX, 'work') // a GitHub thread's checkout, or a Slack thread's directory
const KEY = Buffer.from(E.CONTEXT_KEY || '', 'base64')
const RECYCLED = `(From the controller, not a user: this thread has moved to a fresh machine since your last reply. The conversation carried over, but files from earlier turns — clones, builds, installed tools — are gone; recreate what you need.)`

const sh = (cmd, args, { cwd = CTX, input, env } = {}) =>
  execFileSync(cmd, args, { cwd, input, maxBuffer: 512 * 1024 * 1024, stdio: [input ? 'pipe' : 'ignore', 'pipe', 'pipe'], env: { ...E, GIT_TERMINAL_PROMPT: '0', ...env } })
const git = (...args) => sh('git', args, { cwd: REPO_DIR }).toString().trim()

const seal = (plain) => {
  const iv = randomBytes(12)
  const c = createCipheriv('aes-256-gcm', KEY, iv)
  const body = Buffer.concat([c.update(plain), c.final()])
  return Buffer.concat([iv, c.getAuthTag(), body])
}
const unseal = (sealed) => {
  const d = createDecipheriv('aes-256-gcm', KEY, sealed.subarray(0, 12))
  d.setAuthTag(sealed.subarray(12, 28))
  return Buffer.concat([d.update(sealed.subarray(28)), d.final()])
}

/** Fresh box + a snapshot on the volume → bring the thread's Codex home back. True if it did. */
function restore() {
  if (existsSync(path.join(CTX, 'codex')) || !E.SNAPSHOT || !existsSync(E.SNAPSHOT)) return false
  try {
    sh('tar', ['xzf', '-', '-C', CTX], { input: unseal(readFileSync(E.SNAPSHOT)) })
    return true
  } catch (e) {
    console.error(`context snapshot unusable, starting fresh: ${e.message}`)
    return false
  }
}

/** A Slack request's attachments, where the prompt says they are — and never outside slack-files/. */
function saveFiles(files = []) {
  const root = path.join(WORK, 'slack-files')
  for (const f of files) {
    const dest = path.resolve(WORK, String(f.path))
    if (!dest.startsWith(root + path.sep)) continue
    mkdirSync(path.dirname(dest), { recursive: true })
    writeFileSync(dest, Buffer.from(String(f.data), 'base64'))
  }
}

/** One sequential write of the whole snapshot — all an S3-backed mount supports. */
function save() {
  if (!E.SNAPSHOT) return
  mkdirSync(path.dirname(E.SNAPSHOT), { recursive: true })
  writeFileSync(E.SNAPSHOT, seal(sh('tar', ['czf', '-', '-C', CTX, '--exclude=codex/auth.json', 'codex'])))
}

/** The stand-in ChatGPT login: the job token as access token, unsigned look-alikes for the rest. */
function writeAuth() {
  const b64u = (v) => Buffer.from(JSON.stringify(v)).toString('base64url')
  const claims = { 'https://api.openai.com/auth': { chatgpt_plan_type: 'pro', chatgpt_account_id: 'botlite' } }
  const idToken = `${b64u({ alg: 'none', typ: 'JWT' })}.${b64u({ email: 'botlite@users.noreply.github.com', exp: Math.floor(Date.now() / 1000) + 86_400, ...claims })}.c2ln`
  const auth = {
    OPENAI_API_KEY: null,
    tokens: { id_token: idToken, access_token: E.BOTLITE_JOB_TOKEN, refresh_token: 'held-by-the-controller', account_id: 'botlite' },
    last_refresh: new Date().toISOString(), // fresh, so Codex never tries a refresh of its own
  }
  writeFileSync(path.join(CTX, 'codex', 'auth.json'), JSON.stringify(auth), { mode: 0o600 })
}

function ensureCodex(version) {
  try {
    if (sh('codex', ['--version']).toString().includes(version)) return
  } catch {
    /* not installed yet */
  }
  const args = ['install', '-g', '--no-audit', '--no-fund', `@openai/codex@${version}`]
  try {
    sh('npm', args)
  } catch {
    sh('sudo', ['npm', ...args]) // images whose default user isn't root
  }
}

// boxlite-ai/agent-tooling: BoxLite's shared Codex plugin (skills, auditors, hooks), in every box.
const TOOLING = { url: 'https://github.com/boxlite-ai/agent-tooling.git', ref: 'main', marketplace: 'boxlite-agent-tooling', plugin: 'boxlite-agent-tooling@boxlite-agent-tooling' }
const TOOLING_FRESH_MS = 10 * 60_000

/**
 * Install agent-tooling into this thread's CODEX_HOME (it travels with the sealed context), and
 * bring it to the tip of its branch when the last check is over 10 minutes old — Codex loads
 * plugins when a task starts, so the turn gets the newest. Best effort: a slow GitHub never fails
 * a turn. Its hooks run too: Codex runs with --dangerously-bypass-hook-trust (src/codex.mjs).
 */
function ensureAgentTooling() {
  if (E.AGENT_TOOLING === 'off') return null
  const home = path.join(CTX, 'codex')
  const env = { PATH: E.PATH, HOME: path.join(CTX, 'home'), CODEX_HOME: home, GIT_TERMINAL_PROMPT: '0' }
  const plugin = (...args) => JSON.parse(execFileSync('codex', ['plugin', ...args, '--json'], { env, cwd: CTX, stdio: ['ignore', 'pipe', 'pipe'], timeout: 120_000 }).toString())
  const stamp = path.join(home, '.agent-tooling-checked')
  try {
    const added = plugin('marketplace', 'add', TOOLING.url, '--ref', TOOLING.ref)
    let checked = 0
    try {
      checked = Number(readFileSync(stamp, 'utf8'))
    } catch {
      /* never checked in this context */
    }
    if (added.alreadyAdded && Date.now() - checked > TOOLING_FRESH_MS) plugin('marketplace', 'upgrade', TOOLING.marketplace)
    const { version } = plugin('add', TOOLING.plugin)
    writeFileSync(stamp, String(Date.now()))
    return { version }
  } catch (e) {
    return { error: String(e.stderr || e.message).trim().slice(-300) }
  }
}

/**
 * The controller's model routing (CODEX_CONFIG, from src/codex.mjs) in CODEX_HOME's config.toml,
 * so every codex this turn starts goes through the controller — agent-tooling's hooks start their
 * own, which the flags on ours never reach. agent-tooling keeps its settings in the same file, so
 * ours goes around them: our keys first, our table last (TOML wants top-level keys before any
 * table). Last turn's are found by what they are, not by comments a rewrite could drop.
 */
function writeCodexConfig() {
  if (!E.CODEX_CONFIG) return
  const { top, table } = JSON.parse(E.CODEX_CONFIG)
  const file = path.join(CTX, 'codex', 'config.toml')
  let text = ''
  try {
    text = readFileSync(file, 'utf8')
  } catch {
    /* no config yet */
  }
  const ours = new Set(top.split('\n').map((l) => l.split('=')[0].trim()))
  let section = null // the table a line is in; null before the first one
  const theirs = text.split('\n').filter((line) => {
    const header = /^\s*\[+\s*([^\]]+?)\s*\]+/.exec(line)
    if (header) section = header[1]
    if (section === 'model_providers.botlite' || /^# botlite\b/.test(line)) return false
    return !(section === null && ours.has(line.split('=')[0].trim()))
  })
  const body = theirs.join('\n').trim()
  writeFileSync(file, `# botlite: the controller's routing (box/session.mjs), rewritten every turn\n${top}\n\n${body ? `${body}\n\n` : ''}${table}\n`)
}

/** Clone once; a PR's checkout follows its head (fresh commits → fresh tree), an issue's stays put. */
function checkout() {
  if (!existsSync(path.join(REPO_DIR, '.git'))) sh('git', ['clone', '--quiet', '--filter=blob:none', `https://github.com/${E.REPO}.git`, REPO_DIR])
  if (E.IS_PR !== '1' || sh('git', ['rev-parse', 'HEAD'], { cwd: REPO_DIR }).toString().trim() === E.HEAD_SHA) return
  sh('git', ['fetch', '--quiet', 'origin', `+pull/${E.NUMBER}/head:refs/botlite/pr`, `+refs/heads/${E.BASE_REF}:refs/remotes/origin/${E.BASE_REF}`], { cwd: REPO_DIR })
  sh('git', ['checkout', '--quiet', '--force', '--detach', 'refs/botlite/pr'], { cwd: REPO_DIR })
}

/** agent-tooling's hooks keep their state in the checkout (.agents/state/): never part of a change. */
function excludeToolingState() {
  const file = path.join(REPO_DIR, '.git', 'info', 'exclude')
  let text = ''
  try {
    text = readFileSync(file, 'utf8')
  } catch {
    mkdirSync(path.dirname(file), { recursive: true })
  }
  if (!text.split('\n').includes('.agents/state/')) writeFileSync(file, `${text}${text && !text.endsWith('\n') ? '\n' : ''}.agents/state/\n`)
}

/** A write turn starts clean from the controller's base commit (a follow-up's is the bot's own branch). */
function startFromBase() {
  git('fetch', '--quiet', E.BASE_URL, E.BASE_SHA)
  git('checkout', '--quiet', '--force', '-B', 'botlite', E.BASE_SHA)
  git('clean', '-fdq')
}

/** What Codex committed on top of the base goes to the controller; it decides what happens next. */
function pushCommits() {
  try {
    const head = git('rev-parse', 'HEAD')
    const uncommitted = git('status', '--porcelain', '--untracked-files=no') !== ''
    if (head === E.BASE_SHA) return { pushed: null, uncommitted }
    sh('git', ['push', '--quiet', '--force', '--no-verify', E.PUSH_URL, `HEAD:${E.PUSH_REF}`], {
      cwd: REPO_DIR,
      env: { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'http.extraHeader', GIT_CONFIG_VALUE_0: `Authorization: Bearer ${E.BOTLITE_JOB_TOKEN}` },
    })
    return { pushed: head, uncommitted }
  } catch (e) {
    return { pushed: null, error: String(e.stderr || e.message).trim().slice(-2000) } // the controller picks the reason out
  }
}

/**
 * A Slack turn's PR, if Codex asked for one (pr.json in the working directory): the clone's commits
 * on top of its default branch go to the ref the controller grants, or the report says why not.
 */
async function slackPr() {
  const file = path.join(WORK, 'pr.json')
  if (!existsSync(file)) return null
  const want = (() => {
    try {
      return JSON.parse(readFileSync(file, 'utf8'))
    } catch {
      return null
    }
  })()
  rmSync(file, { force: true }) // one ask, one PR: a later turn doesn't ask again
  try {
    if (!want?.repo) throw new Error('pr.json needs "repo" (owner/name) and "dir" (the clone)')
    const dir = path.resolve(WORK, String(want.dir ?? '.'))
    if (dir !== WORK && !dir.startsWith(WORK + path.sep)) throw new Error('pr.json: "dir" must be inside the working directory')
    const g = (...args) => sh('git', args, { cwd: dir }).toString().trim()
    g('fetch', '--quiet', 'origin')
    const upstream = (() => {
      try {
        return g('symbolic-ref', '--short', 'refs/remotes/origin/HEAD')
      } catch {
        return 'origin/main'
      }
    })()
    const base = g('merge-base', 'HEAD', upstream)
    const head = g('rev-parse', 'HEAD')
    const uncommitted = g('status', '--porcelain', '--untracked-files=no') !== ''
    if (head === base) return { pushed: null, uncommitted, error: `no commits on top of ${upstream}` }
    const res = await fetch(E.PR_URL, { method: 'POST', headers: { authorization: `Bearer ${E.BOTLITE_JOB_TOKEN}`, 'content-type': 'application/json' }, body: JSON.stringify({ repo: String(want.repo), base }) })
    const answer = await res.json().catch(() => ({}))
    if (!res.ok) return { pushed: null, uncommitted, refused: String(answer.error ?? `the controller said ${res.status}`).slice(0, 300) }
    sh('git', ['push', '--quiet', '--force', '--no-verify', E.PUSH_URL, `HEAD:${answer.ref}`], {
      cwd: dir,
      env: { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'http.extraHeader', GIT_CONFIG_VALUE_0: `Authorization: Bearer ${E.BOTLITE_JOB_TOKEN}` },
    })
    return { pushed: head, uncommitted }
  } catch (e) {
    return { pushed: null, error: String(e.stderr || e.message).trim().slice(-2000) } // the controller picks the reason out
  }
}

function codex(args, prompt) {
  return new Promise((resolve) => {
    const child = spawn('codex', args, {
      cwd: WORK,
      stdio: ['pipe', 'pipe', 'inherit'],
      env: {
        PATH: E.PATH,
        LANG: 'C.UTF-8',
        HOME: path.join(CTX, 'home'),
        CODEX_HOME: path.join(CTX, 'codex'),
        CI: '1',
        NO_COLOR: '1',
        GIT_TERMINAL_PROMPT: '0',
        // The team's tools are MCP servers on the controller, called with this turn's job token
        // (bearer_token_env_var) — the same token auth.json already holds, useful nowhere else.
        BOTLITE_JOB_TOKEN: E.BOTLITE_JOB_TOKEN,
        // Commits need an author; the controller replaces them with one commit by the bot anyway.
        ...Object.fromEntries(['AUTHOR', 'COMMITTER'].flatMap((w) => [[`GIT_${w}_NAME`, 'botlite'], [`GIT_${w}_EMAIL`, 'botlite@users.noreply.github.com']])),
      },
    })
    child.stdout.pipe(process.stdout, { end: false }) // JSONL straight to the controller
    child.on('error', (e) => resolve({ code: 127, spawnError: e.message }))
    child.on('close', (code) => resolve({ code }))
    child.stdin.end(prompt)
  })
}

const readStdin = () =>
  new Promise((resolve) => {
    const chunks = []
    process.stdin.on('data', (c) => chunks.push(c))
    process.stdin.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
  })

async function main() {
  const input = await readStdin()
  const result = { type: 'botlite.result' }
  try {
    const { prompt, files } = JSON.parse(input)
    try {
      mkdirSync(CTX, { recursive: true })
    } catch (e) {
      if (e.code !== 'EACCES') throw e
      // The box's user isn't root (the node image runs as `boxlite`, with passwordless sudo).
      sh('sudo', ['mkdir', '-p', CTX], { cwd: '/' })
      sh('sudo', ['chown', `${process.getuid()}:${process.getgid()}`, CTX], { cwd: '/' })
    }
    const restored = restore() // before creating codex/, whose presence means "this box already has the context"
    for (const d of ['home', 'codex']) mkdirSync(path.join(CTX, d), { recursive: true })
    writeAuth()
    ensureCodex(E.CODEX_VERSION)
    result.tooling = ensureAgentTooling()
    writeCodexConfig() // after agent-tooling: its commands may rewrite the file
    if (E.REPO) {
      checkout()
      excludeToolingState()
      if (E.PUSH_REF) startFromBase()
    } else {
      mkdirSync(WORK, { recursive: true })
      saveFiles(files)
    }
    rmSync(path.join(CTX, 'last-message.md'), { force: true }) // a failed turn must not post the last turn's answer
    const args = JSON.parse(E.BOTLITE_ARGS)
    // Resuming on a machine that just restored the context: Codex remembers files that are gone.
    Object.assign(result, await codex(args, restored && args[1] === 'resume' ? `${RECYCLED}\n\n${prompt}` : prompt))
    try {
      result.lastMessage = readFileSync(path.join(CTX, 'last-message.md'), 'utf8')
    } catch {
      /* the turn produced no final message */
    }
    if (E.PUSH_REF) result.push = pushCommits()
    else if (E.PR_URL) result.push = await slackPr()
  } catch (e) {
    Object.assign(result, { code: 1, setupError: String(e.stderr || e.message || e).slice(-800) })
  }
  try {
    save()
  } catch (e) {
    result.snapshotError = String(e.message).slice(0, 300)
  }
  process.stdout.write(`\n${JSON.stringify(result)}\n`)
}

main()
