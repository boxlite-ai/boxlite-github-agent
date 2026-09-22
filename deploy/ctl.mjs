#!/usr/bin/env node
// The running @botlite controller, from your terminal (needs BOXLITE_API_KEY in the environment):
//
//   node deploy/ctl.mjs status        box state + what the controller is doing or waiting for —
//                                     e.g. the ChatGPT device-login link and one-time code
//   node deploy/ctl.mjs logs [lines]  the end of the controller log (default 80)
//   node deploy/ctl.mjs webhook       the GitHub App webhook URL + secret (instant pickup where installed)
//   node deploy/ctl.mjs restart       restart the controller process; it pulls its branch first,
//                                     and keeps its login and state (the box isn't recreated)
//   GITHUB_TOKEN=… node deploy/ctl.mjs github-token
//                                     hand over the bot's classic PAT: streamed on the exec
//                                     connection's stdin into the controller's disk (0600) —
//                                     never in any argv, box env or exec record
//   GITHUB_APP_ID=… GITHUB_APP_KEY=app.pem node deploy/ctl.mjs github-app
//                                     hand over the push App (App ID + private key file) the
//                                     same way; PR writing starts with the next write turn
//   node deploy/ctl.mjs admins you,… set the bot's admins (replaces BOT_ADMINS) and restart
//   node deploy/ctl.mjs hook          install the pull gate (deploy/post-merge.sh) in the
//                                     controller's checkout; a pull never replaces it
//   node deploy/ctl.mjs rollback <sha> run an earlier build of the tracked branch until the next
//                                     restart or /deploy — works when the controller itself doesn't
//   SLACK_BOT_TOKEN=xoxb-… SLACK_APP_TOKEN=xapp-… [SLACK_CONTEXT_SECRET=…] node deploy/ctl.mjs slack-tokens
//                                     hand over the Slack app's tokens (and, taking threads over
//                                     from another controller, its context secret) the same way
//   LINEAR_API_KEY=lin_api_… node deploy/ctl.mjs linear-key     the bot's Linear key, likewise
//   node deploy/ctl.mjs notion-login | google-login  link the bot's Notion / Google account in a
//                                     browser here (deploy/login.mjs); the tokens go straight over
//
// restart, admins and rollback take --wait: wait (up to 25 min, since running turns finish first)
// for the next start to go live, and fail if it isn't the build asked for: with --includes <sha>,
// one that includes that commit; for rollback, that commit.
import { readFileSync } from 'node:fs'
import { boxlite } from '../src/boxlite.mjs'
import { googleScopes } from '../src/tools.mjs'
import { TOOLS } from '../src/policy.mjs'
import { notionLogin, googleLogin } from './login.mjs'

const NAME = 'botlite-controller'
if (!process.env.BOXLITE_API_KEY) {
  console.error('set BOXLITE_API_KEY')
  process.exit(2)
}
const bl = boxlite(process.env.BOXLITE_API_KEY, { base: process.env.BOXLITE_URL })
const box = await bl.getBox(NAME)
if (!box) {
  console.log(`${NAME}: not deployed (bash deploy/deploy.sh)`)
  process.exit(1)
}
const id = box.id || box.name

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
async function sh(script, stdin, lost) {
  const { execution_id: execId } = await bl.startExec(id, { command: 'bash', args: ['-c', script], timeout_seconds: 60 })
  let out = ''
  try {
    const code = await bl.attach(id, execId, { stdin, onStdout: (b) => (out += b), onStderr: (b) => (out += b), timeoutMs: 90_000 })
    return { code, out: out.trimEnd() }
  } catch (e) {
    if (!lost) throw e
    return lost(e) // it started; only its result is gone
  }
}
// An attach sometimes drops after it opened, while the command runs on (seen live). A read is
// retried, since reading twice is harmless; a command that changes something runs once.
async function read(script) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await sh(script)
    } catch (e) {
      if (attempt >= 3) throw e
      await sleep(2000 * attempt)
    }
  }
}
// ...and when the result of one that started is lost, --wait lets the next start settle it; without
// --wait, it fails. One that never started fails either way.
const act = (script, stdin) => sh(script, stdin, wait && ((e) => (console.log(`couldn't read the result (${e.message}); waiting for the next start anyway`), null)))
// A hand-over that failed exits non-zero, so the workflow step that ran it fails too.
function report(r, ok) {
  console.log(r.code === 0 ? ok : `failed: ${r.out}`)
  if (r.code !== 0) process.exit(1)
}

// The log lines the boot loop and the controller write about starting are told by how they begin —
// a timestamp, then the words — never by words anywhere in a line, which a line quoting a turn's
// output could hold too.
const TS = '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9:.]+Z '
// How many times the boot loop has started the controller, read just before a restart: --wait
// looks for the start after those.
const countStarts = async () => Number((await read(`grep -cE '${TS}starting controller \\(' ~/.botlite/controller.log 2>/dev/null || true`)).out) || 0
// The first of those starts to go live settles it: one that fails before going live (the launcher
// counts those) is waited out, and a rollback, the gate's or the launcher's, fails at once.
async function waitLive({ starts, want, exact }) {
  const latest = `awk '$2 == "starting" && $3 == "controller" && $4 ~ /^\\(/ { n++; s = substr($4, 2); sub(/\\).*/, "", s); up = 0 } $2 == "live" && $3 == "as" && $4 ~ /^@/ { up = 1 } END { print n + 0, (s == "" ? "-" : s), (up ? "live" : "starting") }' ~/.botlite/controller.log`
  let seen = ''
  for (let i = 0; i < 100; i++) {
    if (i) await sleep(15_000)
    const line = await read(latest).then((r) => r.out, (e) => console.log(`couldn't check (${e.message}); trying again`))
    if (!line) continue
    const [n, s, state] = line.split(' ')
    if (Number(n) <= starts || `${n} ${state}` === seen) continue
    seen = `${n} ${state}`
    if (state !== 'live') {
      console.log(`starting ${s}…`)
      continue
    }
    const same = !want || want.startsWith(s) || s.startsWith(want)
    if (same || (!exact && (await read(`git -C ~/botlite merge-base --is-ancestor ${want} ${s}`)).code === 0)) {
      console.log(`live on ${s}${same ? '' : `, which includes ${want.slice(0, 7)}`}`)
      return
    }
    console.log(`live on ${s}, which ${exact ? 'is not' : "doesn't include"} ${want.slice(0, 7)}. How the start went:`)
    return story()
  }
  console.log('nothing went live in 25 minutes. How the start went:')
  return story()
}
// Only the boot story, URLs taken out: this runs in a public Actions log, and the log also holds
// things like a device-login code, which anyone could approve with their own ChatGPT account — and
// the team's Slack conversations. So: the boot loop's, the gate's, the launcher's and the
// controller's own lines about starting, and of a crash where it was and what it was, with
// whatever its message quotes taken out.
async function story() {
  const lines = `${TS}(starting controller \\(|controller exited \\(|gate: |launcher: |build [0-9a-f]+ .*: rolled back to |rolled back from |live as @)|^git pull failed|^[A-Za-z]*Error( \\[[A-Z_]+\\])?: |^file://`
  const unquote = `/^[A-Za-z]*Error/ s#[\\"'].*[\\"']#\\"...\\"#`
  console.log((await read(`tail -n 400 ~/.botlite/controller.log | grep -E '${lines}' | sed -E -e 's#https?://[^ ,]+#<url>#g' -e "${unquote}" | tail -n 30`)).out)
  process.exit(1)
}

// Options first, so what's left is the command and its arguments.
const argv = process.argv.slice(2)
function option(name, { value = false } = {}) {
  const i = argv.indexOf(name)
  if (i < 0) return value ? undefined : false
  const [, v] = argv.splice(i, value ? 2 : 1)
  if (value && (v === undefined || v.startsWith('--'))) {
    console.error(`${name} takes a value`)
    process.exit(2)
  }
  return value ? v : true
}
const includes = option('--includes', { value: true })
const wait = option('--wait') || includes !== undefined
if (includes !== undefined && !/^[0-9a-f]{7,40}$/.test(includes)) {
  console.error('--includes takes a commit sha')
  process.exit(2)
}
const [cmd = 'status', arg] = argv
if (cmd === 'status') {
  console.log(`${NAME}: ${box.status ?? box.state ?? '?'} (${id})`)
  console.log((await read('cat ~/.botlite/status.txt 2>/dev/null || echo "(starting — no status yet)"')).out)
} else if (cmd === 'logs') {
  console.log((await read(`tail -n ${Number(arg) || 80} ~/.botlite/controller.log 2>/dev/null || echo "(no log yet)"`)).out)
} else if (cmd === 'restart') {
  // A rollback (src/main.mjs) leaves the checkout detached: re-attach the branch it was last on
  // (recorded by the controller) — never a stale BOTLITE_REF over a branch someone checked out.
  const starts = await countStarts()
  const r = await act("cd ~/botlite && { git symbolic-ref -q HEAD >/dev/null || git checkout --quiet \"$(cat ~/.botlite/branch 2>/dev/null || echo \"${BOTLITE_REF:-main}\")\"; }; pkill -f 'botlite/src/mai[n].mjs' && echo restarting || echo 'controller process not found'")
  if (r) console.log(r.out)
  if (wait) await waitLive({ starts, want: includes })
} else if (cmd === 'webhook') {
  const { url } = await bl.previewUrl(id, 8788)
  const secret = (await read('cat ~/.botlite/webhook-secret 2>/dev/null')).out
  console.log(`GitHub App → Webhook URL:    ${url.replace(/\/+$/, '')}/webhook`)
  console.log(`GitHub App → Webhook secret: ${secret || '(not generated yet — restart the controller)'}`)
  console.log('Events: Issues, Issue comment, Pull request, Pull request review comment')
} else if (cmd === 'github-token') {
  if (!process.env.GITHUB_TOKEN) {
    console.error("set GITHUB_TOKEN (the bot account's classic PAT)")
    process.exit(2)
  }
  const r = await sh('umask 077 && mkdir -p ~/.botlite && cat > ~/.botlite/github-token && echo stored', `${process.env.GITHUB_TOKEN}\n`)
  report(r, 'handed to the controller — it starts polling within 30 s')
} else if (cmd === 'github-app') {
  const { GITHUB_APP_ID: appId, GITHUB_APP_KEY: keyFile } = process.env
  if (!appId || !keyFile) {
    console.error('set GITHUB_APP_ID (the push App’s ID) and GITHUB_APP_KEY (its private key .pem file)')
    process.exit(2)
  }
  const privateKey = readFileSync(keyFile, 'utf8')
  const r = await sh('umask 077 && mkdir -p ~/.botlite && cat > ~/.botlite/github-app.json && echo stored', JSON.stringify({ appId, privateKey }))
  report(r, 'handed to the controller — PR writing starts with the next write turn')
} else if (cmd === 'admins') {
  const logins = argv.slice(1).join(',').split(/[\s,]+/).map((l) => l.replace(/^@/, '')).filter(Boolean)
  if (!logins.length || !logins.every((l) => /^[a-z\d](?:[a-z\d]|-(?=[a-z\d])){0,38}$/i.test(l))) {
    console.error('usage: node deploy/ctl.mjs admins <github login>[,<login>…]')
    process.exit(2)
  }
  // Between two starts there's no process to stop, and the next start reads the file anyway.
  const starts = await countStarts()
  const r = await act("umask 077 && mkdir -p ~/.botlite && cat > ~/.botlite/bot-admins && { pkill -f 'botlite/src/mai[n].mjs' || true; } && echo restarting", `${logins.join(',')}\n`)
  if (r) report(r, `admins: ${logins.map((l) => `@${l}`).join(' ')} — the controller restarts to apply them`)
  if (wait) await waitLive({ starts, want: includes })
} else if (cmd === 'hook') {
  const script = readFileSync(new URL('./post-merge.sh', import.meta.url), 'utf8')
  const r = await sh('cat > ~/botlite/.git/hooks/post-merge && chmod +x ~/botlite/.git/hooks/post-merge && echo installed', script)
  report(r, 'pull gate installed in the controller checkout')
} else if (cmd === 'slack-tokens') {
  const { SLACK_BOT_TOKEN: botToken = '', SLACK_APP_TOKEN: appToken = '', SLACK_CONTEXT_SECRET: contextSecret = '' } = process.env
  if (!/^xoxb-\S+$/.test(botToken) || !/^xapp-\S+$/.test(appToken)) {
    console.error("set SLACK_BOT_TOKEN (the app's Bot User OAuth Token, xoxb-…) and SLACK_APP_TOKEN (an app-level token with connections:write, xapp-…); SLACK_CONTEXT_SECRET too, to carry Slack threads over from another controller")
    process.exit(2)
  }
  // `read` and `printf` are bash builtins: the tokens go from stdin to the files without an argv.
  // The context secret goes first: the controller reads it as Slack starts, once the tokens are in.
  const script = 'umask 077 && mkdir -p ~/.botlite && IFS= read -r bot && IFS= read -r app && IFS= read -r ctx; { [ -z "$ctx" ] || printf %s "$ctx" > ~/.botlite/slack-context-secret; } && printf %s "$bot" > ~/.botlite/slack-bot-token && printf %s "$app" > ~/.botlite/slack-app-token && echo stored'
  report(await sh(script, `${botToken}\n${appToken}\n${contextSecret}\n`), `handed to the controller — it connects to Slack within a minute${contextSecret ? '; if Slack was on already, the context secret applies from its next start (restart)' : ''}`)
} else if (cmd === 'linear-key') {
  const key = process.env.LINEAR_API_KEY ?? ''
  if (!/^lin_api_\S+$/.test(key)) {
    console.error("set LINEAR_API_KEY (the bot's Linear API key, lin_api_…)")
    process.exit(2)
  }
  report(await sh('umask 077 && mkdir -p ~/.botlite && cat > ~/.botlite/linear-api-key && echo stored', `${key}\n`), 'handed to the controller — Linear is on from the next request')
} else if (cmd === 'notion-login' || cmd === 'google-login') {
  let login
  if (cmd === 'notion-login') login = await notionLogin()
  else {
    const { GOOGLE_CLIENT_ID: clientId, GOOGLE_CLIENT_SECRET: clientSecret } = process.env
    if (!clientId || !clientSecret) {
      console.error('set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET (an OAuth client of type Desktop app — see the README)')
      process.exit(2)
    }
    login = await googleLogin({ clientId, clientSecret, scopes: googleScopes(TOOLS) })
  }
  // Written aside, then moved: the controller may be reading this file. (It keeps the logins it
  // refreshes in files of its own, so it never writes this one: oauth.mjs.)
  const file = `~/.botlite/${cmd === 'notion-login' ? 'notion' : 'google'}-oauth.json`
  const r = await sh(`umask 077 && mkdir -p ~/.botlite && cat > ${file}.new && mv ${file}.new ${file} && echo stored`, JSON.stringify(login))
  report(r, `linked${login.account ? ` as ${login.account}` : ''} and handed to the controller — on from the next request`)
} else if (cmd === 'rollback') {
  if (!/^[0-9a-f]{7,40}$/.test(arg || '')) {
    console.error('usage: node deploy/ctl.mjs rollback <commit sha on the tracked branch>')
    process.exit(2)
  }
  // Only a commit the tracked branch already has: this runs what was merged, never anything else.
  const starts = await countStarts()
  const r = await act(`cd ~/botlite && git fetch --quiet origin && b="$(cat ~/.botlite/branch 2>/dev/null || echo "\${BOTLITE_REF:-main}")" && git merge-base --is-ancestor ${arg} "origin/$b" && git checkout --quiet --detach ${arg} && echo "running $(git rev-parse --short HEAD), from $b — restart or /deploy to go back to its tip" && { pkill -f 'botlite/src/mai[n].mjs' || true; }`)
  if (r) console.log(r.code === 0 ? r.out : `failed (is ${arg} on the tracked branch?): ${r.out}`)
  if (r && r.code !== 0) process.exit(1)
  if (wait) await waitLive({ starts, want: arg, exact: true })
} else {
  console.error('usage: node deploy/ctl.mjs status | logs [lines] | webhook | restart | github-token | github-app | admins | hook | rollback <sha> | slack-tokens | linear-key | notion-login | google-login  (restart, admins, rollback: [--wait] [--includes <sha>])')
  process.exit(2)
}
