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
//   node deploy/ctl.mjs hook          install the post-merge gate (deploy/post-merge.sh) in the
//                                     controller's checkout; a pull never replaces it
//   node deploy/ctl.mjs rollback <sha> run an earlier build of the tracked branch until the next
//                                     restart or /deploy — works when the controller itself doesn't
//   node deploy/ctl.mjs wait-live <sha> wait (25 min at most: running turns finish first) for
//                                     build <sha> to start and go live
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

const [cmd = 'status', arg] = process.argv.slice(2)
if (cmd === 'status') {
  console.log(`${NAME}: ${box.status ?? box.state ?? '?'} (${id})`)
  console.log((await sh('cat ~/.botlite/status.txt 2>/dev/null || echo "(starting — no status yet)"')).out)
} else if (cmd === 'logs') {
  console.log((await sh(`tail -n ${Number(arg) || 80} ~/.botlite/controller.log 2>/dev/null || echo "(no log yet)"`)).out)
} else if (cmd === 'restart') {
  // A rollback (src/main.mjs) leaves the checkout detached: re-attach the branch it was last on
  // (recorded by the controller) — never a stale BOTLITE_REF over a branch someone checked out.
  const r = await sh("cd ~/botlite && { git symbolic-ref -q HEAD >/dev/null || git checkout --quiet \"$(cat ~/.botlite/branch 2>/dev/null || echo \"${BOTLITE_REF:-main}\")\"; }; pkill -f 'botlite/src/mai[n].mjs' && echo restarting || echo 'controller process not found'")
  console.log(r.out)
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
  console.log(r.code === 0 ? 'handed to the controller — it starts polling within 30 s' : `failed: ${r.out}`)
} else if (cmd === 'github-app') {
  const { GITHUB_APP_ID: appId, GITHUB_APP_KEY: keyFile } = process.env
  if (!appId || !keyFile) {
    console.error('set GITHUB_APP_ID (the push App’s ID) and GITHUB_APP_KEY (its private key .pem file)')
    process.exit(2)
  }
  const privateKey = readFileSync(keyFile, 'utf8')
  const r = await sh('umask 077 && mkdir -p ~/.botlite && cat > ~/.botlite/github-app.json && echo stored', JSON.stringify({ appId, privateKey }))
  console.log(r.code === 0 ? 'handed to the controller — PR writing starts with the next write turn' : `failed: ${r.out}`)
} else if (cmd === 'admins') {
  const logins = process.argv.slice(3).join(',').split(/[\s,]+/).map((l) => l.replace(/^@/, '')).filter(Boolean)
  if (!logins.length || !logins.every((l) => /^[a-z\d](?:[a-z\d]|-(?=[a-z\d])){0,38}$/i.test(l))) {
    console.error('usage: node deploy/ctl.mjs admins <github login>[,<login>…]')
    process.exit(2)
  }
  const r = await sh("umask 077 && mkdir -p ~/.botlite && cat > ~/.botlite/bot-admins && pkill -f 'botlite/src/mai[n].mjs' && echo restarting", `${logins.join(',')}\n`)
  console.log(r.code === 0 ? `admins: ${logins.map((l) => `@${l}`).join(' ')} — the controller restarts to apply them` : `failed: ${r.out}`)
} else if (cmd === 'hook') {
  const script = readFileSync(new URL('./post-merge.sh', import.meta.url), 'utf8')
  const r = await sh('cat > ~/botlite/.git/hooks/post-merge && chmod +x ~/botlite/.git/hooks/post-merge && echo installed', script)
  console.log(r.code === 0 ? 'post-merge gate installed in the controller checkout' : `failed: ${r.out}`)
} else if (cmd === 'rollback') {
  if (!/^[0-9a-f]{7,40}$/.test(arg || '')) {
    console.error('usage: node deploy/ctl.mjs rollback <commit sha on the tracked branch>')
    process.exit(2)
  }
  // Only a commit the tracked branch already has: this runs what was merged, never anything else.
  const r = await sh(`cd ~/botlite && git fetch --quiet origin && b="$(cat ~/.botlite/branch 2>/dev/null || echo "\${BOTLITE_REF:-main}")" && git merge-base --is-ancestor ${arg} "origin/$b" && git checkout --quiet --detach ${arg} && echo "running $(git rev-parse --short HEAD), from $b — restart or /deploy to go back to its tip" && { pkill -f 'botlite/src/mai[n].mjs' || true; }`)
  console.log(r.code === 0 ? r.out : `failed (is ${arg} on the tracked branch?): ${r.out}`)
  if (r.code !== 0) process.exit(1)
} else if (cmd === 'wait-live') {
  const sha = (arg || '').slice(0, 7)
  if (!/^[0-9a-f]{7}$/.test(sha)) {
    console.error('usage: node deploy/ctl.mjs wait-live <commit sha>')
    process.exit(2)
  }
  // Live: the boot loop's latest start is that build, and it has said "live as" since. Not just any
  // start of it in the log, which an earlier run of the same commit would fake. A restart lets
  // running turns finish first (JOB_TIMEOUT_MIN, 20, at most), so this waits up to 25 minutes.
  const live = `awk -v want='starting controller (${sha}' 'index($0, "starting controller (") { on = (index($0, want) > 0); up = 0 } on && index($0, "live as @") { up = 1 } END { exit !(on && up) }' ~/.botlite/controller.log`
  for (let i = 0; i < 100; i++) {
    if ((await sh(live)).code === 0) {
      console.log(`live on ${sha}`)
      process.exit(0)
    }
    await new Promise((r) => setTimeout(r, 15_000))
  }
  // Only the boot story: this runs in a public Actions log, and the log also holds things like a
  // device-login code, which anyone could approve with their own ChatGPT account.
  const story = "starting controller \\(|controller exited \\(|gate: |launcher: |failed to go live|rolled back|git pull failed|live as @|^[A-Za-z]*Error( \\[[A-Z_]+\\])?: |^file://"
  console.log((await sh(`tail -n 400 ~/.botlite/controller.log | grep -E '${story}' | tail -n 30`)).out)
  console.error(`not live on ${sha} after 25 minutes`)
  process.exit(1)
} else {
  console.error('usage: node deploy/ctl.mjs status | logs [lines] | webhook | restart | github-token | github-app | admins | hook | rollback <sha> | wait-live <sha>')
  process.exit(2)
}
