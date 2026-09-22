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
} else {
  console.error('usage: node deploy/ctl.mjs status | logs [lines] | webhook | restart | github-token | github-app | admins')
  process.exit(2)
}
