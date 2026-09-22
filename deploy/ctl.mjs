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
//
// restart, admins and rollback take --wait: wait (up to 25 min, since running turns finish first)
// for the next start to go live, and fail if it isn't the build asked for: with --includes <sha>,
// one that includes that commit; for rollback, that commit.
import { readFileSync } from 'node:fs'
import { boxlite } from '../src/boxlite.mjs'

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

async function sh(script, stdin) {
  const { execution_id: execId } = await bl.startExec(id, { command: 'bash', args: ['-c', script], timeout_seconds: 60 })
  let out = ''
  const code = await bl.attach(id, execId, { stdin, onStdout: (b) => (out += b), onStderr: (b) => (out += b), timeoutMs: 90_000 })
  return { code, out: out.trimEnd() }
}
// A hand-over that failed exits non-zero, so the workflow step that ran it fails too.
function report(r, ok) {
  console.log(r.code === 0 ? ok : `failed: ${r.out}`)
  if (r.code !== 0) process.exit(1)
}

// How many times the boot loop has started the controller, counted in the same exec as the restart
// that follows it: --wait looks for the start after those.
const COUNT = `echo "starts $(grep -c 'starting controller (' ~/.botlite/controller.log 2>/dev/null)"; `
function counted(r) {
  const m = /^starts (\d*)\n?/.exec(r.out)
  return { ...r, out: r.out.slice(m?.[0].length ?? 0), starts: Number(m?.[1] || 0) }
}
// The first of those starts to go live settles it: one that fails before going live (the launcher
// counts those) is waited out, and a rollback, the gate's or the launcher's, fails at once.
async function waitLive({ starts, want, exact }) {
  const latest = `awk 'index($0, "starting controller (") { n++; s = substr($0, index($0, "starting controller (") + 21); sub(/\\).*/, "", s); up = 0 } index($0, "live as @") { up = 1 } END { print n + 0, (s == "" ? "-" : s), (up ? "live" : "starting") }' ~/.botlite/controller.log`
  let seen = ''
  for (let i = 0; i < 100; i++) {
    const [n, s, state] = (await sh(latest)).out.split(' ')
    if (Number(n) > starts && `${n} ${state}` !== seen) {
      seen = `${n} ${state}`
      if (state !== 'live') console.log(`starting ${s}…`)
      else {
        const same = !want || want.startsWith(s) || s.startsWith(want)
        if (same || (!exact && (await sh(`git -C ~/botlite merge-base --is-ancestor ${want} ${s}`)).code === 0)) {
          console.log(`live on ${s}${same ? '' : `, which includes ${want.slice(0, 7)}`}`)
          return
        }
        console.log(`live on ${s}, which ${exact ? 'is not' : "doesn't include"} ${want.slice(0, 7)}. How the start went:`)
        return story()
      }
    }
    await new Promise((r) => setTimeout(r, 15_000))
  }
  console.log('nothing went live in 25 minutes. How the start went:')
  return story()
}
// Only the boot story: this runs in a public Actions log, and the log also holds things like a
// device-login code, which anyone could approve with their own ChatGPT account.
async function story() {
  const lines = "starting controller \\(|controller exited \\(|gate: |launcher: |failed to go live|rolled back|git pull failed|live as @|^[A-Za-z]*Error( \\[[A-Z_]+\\])?: |^file://"
  console.log((await sh(`tail -n 400 ~/.botlite/controller.log | grep -E '${lines}' | tail -n 30`)).out)
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
  console.log((await sh('cat ~/.botlite/status.txt 2>/dev/null || echo "(starting — no status yet)"')).out)
} else if (cmd === 'logs') {
  console.log((await sh(`tail -n ${Number(arg) || 80} ~/.botlite/controller.log 2>/dev/null || echo "(no log yet)"`)).out)
} else if (cmd === 'restart') {
  // A rollback (src/main.mjs) leaves the checkout detached: re-attach the branch it was last on
  // (recorded by the controller) — never a stale BOTLITE_REF over a branch someone checked out.
  const r = counted(await sh(COUNT + "cd ~/botlite && { git symbolic-ref -q HEAD >/dev/null || git checkout --quiet \"$(cat ~/.botlite/branch 2>/dev/null || echo \"${BOTLITE_REF:-main}\")\"; }; pkill -f 'botlite/src/mai[n].mjs' && echo restarting || echo 'controller process not found'"))
  console.log(r.out)
  if (wait) await waitLive({ starts: r.starts, want: includes })
} else if (cmd === 'webhook') {
  const { url } = await bl.previewUrl(id, 8788)
  const secret = (await sh('cat ~/.botlite/webhook-secret 2>/dev/null')).out
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
  const r = counted(await sh(COUNT + "umask 077 && mkdir -p ~/.botlite && cat > ~/.botlite/bot-admins && { pkill -f 'botlite/src/mai[n].mjs' || true; } && echo restarting", `${logins.join(',')}\n`))
  report(r, `admins: ${logins.map((l) => `@${l}`).join(' ')} — the controller restarts to apply them`)
  if (wait) await waitLive({ starts: r.starts, want: includes })
} else if (cmd === 'hook') {
  const script = readFileSync(new URL('./post-merge.sh', import.meta.url), 'utf8')
  const r = await sh('cat > ~/botlite/.git/hooks/post-merge && chmod +x ~/botlite/.git/hooks/post-merge && echo installed', script)
  report(r, 'pull gate installed in the controller checkout')
} else if (cmd === 'rollback') {
  if (!/^[0-9a-f]{7,40}$/.test(arg || '')) {
    console.error('usage: node deploy/ctl.mjs rollback <commit sha on the tracked branch>')
    process.exit(2)
  }
  // Only a commit the tracked branch already has: this runs what was merged, never anything else.
  const r = counted(await sh(COUNT + `cd ~/botlite && git fetch --quiet origin && b="$(cat ~/.botlite/branch 2>/dev/null || echo "\${BOTLITE_REF:-main}")" && git merge-base --is-ancestor ${arg} "origin/$b" && git checkout --quiet --detach ${arg} && echo "running $(git rev-parse --short HEAD), from $b — restart or /deploy to go back to its tip" && { pkill -f 'botlite/src/mai[n].mjs' || true; }`))
  console.log(r.code === 0 ? r.out : `failed (is ${arg} on the tracked branch?): ${r.out}`)
  if (r.code !== 0) process.exit(1)
  if (wait) await waitLive({ starts: r.starts, want: arg, exact: true })
} else {
  console.error('usage: node deploy/ctl.mjs status | logs [lines] | webhook | restart | github-token | github-app | admins | hook | rollback <sha>  (restart, admins, rollback: [--wait] [--includes <sha>])')
  process.exit(2)
}
