// Runs INSIDE a session box — one box per issue/PR — as the program of each exec. The controller
// stays attached: it streams the prompt in on stdin and reads Codex's JSONL events from stdout.
//
// Live state is on the box's own disk (git and Codex need rename/append, which the S3-backed
// volume lacks):  /ctx/repo checkout · /ctx/codex CODEX_HOME (sessions) · /ctx/home HOME.
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
// through. Nothing here is a check — Codex could rewrite this runner — the controller checks.
import { spawn, execFileSync } from 'node:child_process'
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

process.on('SIGHUP', () => {}) // a dropped attach gets a reconnect grace; don't die in it

const E = process.env
// An exec given its own env gets no PATH (seen live): without this, tar/git/npm/codex are ENOENT.
E.PATH ||= '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin'
const CTX = E.CTX || '/ctx'
const REPO_DIR = path.join(CTX, 'repo')
const KEY = Buffer.from(E.CONTEXT_KEY || '', 'base64')

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

/** Fresh box + a snapshot on the volume → bring the thread's Codex home back. */
function restore() {
  if (existsSync(path.join(CTX, 'codex')) || !E.SNAPSHOT || !existsSync(E.SNAPSHOT)) return
  try {
    sh('tar', ['xzf', '-', '-C', CTX], { input: unseal(readFileSync(E.SNAPSHOT)) })
  } catch (e) {
    console.error(`context snapshot unusable, starting fresh: ${e.message}`)
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

/** Clone once; a PR's checkout follows its head (fresh commits → fresh tree), an issue's stays put. */
function checkout() {
  if (!existsSync(path.join(REPO_DIR, '.git'))) sh('git', ['clone', '--quiet', '--filter=blob:none', `https://github.com/${E.REPO}.git`, REPO_DIR])
  if (E.IS_PR !== '1' || sh('git', ['rev-parse', 'HEAD'], { cwd: REPO_DIR }).toString().trim() === E.HEAD_SHA) return
  sh('git', ['fetch', '--quiet', 'origin', `+pull/${E.NUMBER}/head:refs/botlite/pr`, `+refs/heads/${E.BASE_REF}:refs/remotes/origin/${E.BASE_REF}`], { cwd: REPO_DIR })
  sh('git', ['checkout', '--quiet', '--force', '--detach', 'refs/botlite/pr'], { cwd: REPO_DIR })
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
    return { pushed: null, error: String(e.stderr || e.message).trim().slice(-300) }
  }
}

function codex(args, prompt) {
  return new Promise((resolve) => {
    const child = spawn('codex', args, {
      cwd: REPO_DIR,
      stdio: ['pipe', 'pipe', 'inherit'],
      env: {
        PATH: E.PATH,
        LANG: 'C.UTF-8',
        HOME: path.join(CTX, 'home'),
        CODEX_HOME: path.join(CTX, 'codex'),
        CI: '1',
        NO_COLOR: '1',
        GIT_TERMINAL_PROMPT: '0',
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
  const prompt = await readStdin()
  const result = { type: 'botlite.result' }
  try {
    try {
      mkdirSync(CTX, { recursive: true })
    } catch (e) {
      if (e.code !== 'EACCES') throw e
      // The box's user isn't root (the node image runs as `boxlite`, with passwordless sudo).
      sh('sudo', ['mkdir', '-p', CTX], { cwd: '/' })
      sh('sudo', ['chown', `${process.getuid()}:${process.getgid()}`, CTX], { cwd: '/' })
    }
    restore() // before creating codex/, whose presence means "this box already has the context"
    for (const d of ['home', 'codex']) mkdirSync(path.join(CTX, d), { recursive: true })
    writeAuth()
    ensureCodex(E.CODEX_VERSION)
    checkout()
    if (E.PUSH_REF) startFromBase()
    Object.assign(result, await codex(JSON.parse(E.BOTLITE_ARGS), prompt))
    try {
      result.lastMessage = readFileSync(path.join(CTX, 'last-message.md'), 'utf8')
    } catch {
      /* the turn produced no final message */
    }
    if (E.PUSH_REF) result.push = pushCommits()
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
