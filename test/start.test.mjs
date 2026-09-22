import assert from 'node:assert/strict'
import { test } from 'node:test'
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

// The controller as the boot loop starts it, with its network answered by offline.mjs. No unit
// test imports controller.mjs, so this is what proves a build loads at all (every module parses
// and links) and goes live — before it's merged, not after it's deployed.
test('the controller starts, goes live on trial, answers /healthz, and a SIGTERM drains it cleanly', { timeout: 60_000 }, async (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'start-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const port = 20000 + Math.floor(Math.random() * 20000)
  const env = {
    PATH: process.env.PATH, PORT: String(port), PUBLIC_URL: `http://127.0.0.1:${port}`, STATE_FILE: path.join(dir, 'state.json'),
    BOXLITE_API_KEY: 'blk_test', GITHUB_TOKEN: 'ghp_test', BOT_ADMINS: 'root',
    CHATGPT_ACCESS_TOKEN: 'at', CHATGPT_REFRESH_TOKEN: 'rt', CHATGPT_ACCOUNT_ID: 'acct', CHATGPT_LAST_REFRESH: new Date().toISOString(),
  }
  const child = spawn(process.execPath, ['--import', path.resolve('test/offline.mjs'), path.resolve('src/main.mjs')], { env, stdio: ['ignore', 'pipe', 'pipe'] })
  t.after(() => child.kill())
  let out = ''
  child.stdout.on('data', (d) => (out += d))
  child.stderr.on('data', (d) => (out += d))
  const exited = new Promise((r) => child.on('exit', r))
  const status = () => (existsSync(path.join(dir, 'status.txt')) ? readFileSync(path.join(dir, 'status.txt'), 'utf8') : '')
  for (let i = 0; i < 150 && !status().includes('live as') && child.exitCode === null; i++) await new Promise((r) => setTimeout(r, 100))
  assert.match(status(), /live as @botlite: .*admins @root/, out)

  const boot = () => JSON.parse(readFileSync(path.join(dir, 'boot.json'), 'utf8'))
  assert.equal(boot().tries, 1) // on trial: this start counts toward a rollback,
  assert.equal(existsSync(path.join(dir, 'good-build.json')), false) // and the build isn't good yet
  assert.equal((await fetch(`http://127.0.0.1:${port}/healthz`)).status, 200)

  child.kill('SIGTERM')
  assert.equal(await exited, 0, out)
  assert.equal(boot().tries, 0) // a restart isn't a crash
})
