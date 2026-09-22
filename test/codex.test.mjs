import assert from 'node:assert/strict'
import { test } from 'node:test'
import { codexArgs, codexConfig, applyEvent, newRun, newSessionPrompt, followUpPrompt, slackSessionPrompt, slackFollowUpPrompt } from '../src/codex.mjs'
import { SLACK_SERVICE } from '../src/slack-tools.mjs'

const base = { cwd: '/ctx/repo', outFile: '/ctx/last.md', proxyUrl: 'https://8788-d-abc.proxy.boxlite.ai/' }

test('codexArgs: a new session runs in the checkout; a resume names the session; prompt on stdin', () => {
  const fresh = codexArgs(base)
  assert.deepEqual(fresh.slice(0, 5), ['exec', '--json', '-o', '/ctx/last.md', '--skip-git-repo-check'])
  assert.deepEqual(fresh.slice(-3), ['-C', '/ctx/repo', '-'])
  assert.ok(fresh.includes('--dangerously-bypass-approvals-and-sandbox'))
  assert.ok(fresh.includes('--dangerously-bypass-hook-trust')) // agent-tooling's hooks run in a turn no one can approve
  for (const c of ['approval_policy="never"', 'sandbox_mode="danger-full-access"', 'web_search="live"']) assert.ok(fresh.includes(c), c)
  // ChatGPT-mode auth, but every backend call goes to the controller, never to chatgpt.com
  assert.ok(fresh.includes('model_providers.botlite={ name = "botlite", base_url = "https://8788-d-abc.proxy.boxlite.ai/backend-api/codex", wire_api = "responses", requires_openai_auth = true }'))
  assert.ok(fresh.includes('chatgpt_base_url="https://8788-d-abc.proxy.boxlite.ai/backend-api/"'))
  assert.ok(fresh.includes('cli_auth_credentials_store="file"'))

  const resumed = codexArgs({ ...base, sessionId: '01a0c45b-edb0', model: 'gpt-5.6-sol' })
  assert.deepEqual(resumed.slice(0, 2), ['exec', 'resume'])
  assert.deepEqual(resumed.slice(-4), ['-m', 'gpt-5.6-sol', '01a0c45b-edb0', '-'])
  assert.equal(resumed.includes('-C'), false) // `exec resume` has no --cd; the box runs it in the checkout
})

test('codexArgs: needs a proxy url, and refuses one that could break out of the TOML string', () => {
  assert.throws(() => codexArgs({ ...base, proxyUrl: 'http://x" , base_url = "http://evil' }), /bad proxy url/)
  assert.throws(() => codexArgs({ ...base, proxyUrl: undefined }), /bad proxy url/)
})

test('codexConfig: the same routing as the flags, for config.toml — top-level keys, then the provider table', () => {
  const { top, table } = codexConfig('https://proxy.example/')
  assert.equal(top, 'model_provider = "botlite"\nchatgpt_base_url = "https://proxy.example/backend-api/"\ncli_auth_credentials_store = "file"')
  assert.equal(table, '[model_providers.botlite]\nname = "botlite"\nbase_url = "https://proxy.example/backend-api/codex"\nwire_api = "responses"\nrequires_openai_auth = true')
  assert.ok(!top.includes('[')) // no table in the part that goes before agent-tooling's
  assert.throws(() => codexConfig('https://x.example/"\n[evil]'), /bad proxy url/)
  // The job token rides every request: plain http only to this machine.
  assert.throws(() => codexConfig('http://proxy.example'), /bad proxy url/)
  assert.throws(() => codexConfig('http://127.0.0.1.evil.example'), /bad proxy url/)
  assert.doesNotThrow(() => codexConfig('http://127.0.0.1:8788'))
})

test('codexArgs: a reasoning effort becomes model_reasoning_effort; neither it nor the model can inject config', () => {
  const args = codexArgs({ ...base, model: 'gpt-6-astra', effort: 'xhigh' })
  assert.ok(args.includes('model_reasoning_effort="xhigh"'))
  assert.deepEqual(args.slice(args.indexOf('-m'), args.indexOf('-m') + 2), ['-m', 'gpt-6-astra'])
  assert.equal(codexArgs(base).some((a) => a.startsWith('model_reasoning_effort')), false) // unset: the model's default
  assert.throws(() => codexArgs({ ...base, effort: 'high" , model_provider = "evil' }), /bad reasoning effort/)
  assert.throws(() => codexArgs({ ...base, model: 'x -c evil' }), /bad model/)
})

const run = (lines) => lines.map((l) => JSON.stringify(l)).reduce(applyEvent, newRun())

test('applyEvent: the failed probe run — session id kept, turn failure reported', () => {
  const r = run([
    { type: 'thread.started', thread_id: '01a0c45b-edb0' },
    { type: 'item.completed', item: { id: 'item_0', type: 'error', message: 'Skill descriptions were shortened' } },
    { type: 'turn.started' },
    { type: 'error', message: 'probe: stop here' },
    { type: 'turn.failed', error: { message: 'probe: stop here' } },
  ])
  assert.equal(r.sessionId, '01a0c45b-edb0')
  assert.equal(r.completed, false)
  assert.equal(r.error, 'probe: stop here')
})

test('applyEvent: a completed turn succeeds despite earlier non-fatal errors; last message wins', () => {
  const r = run([
    { type: 'thread.started', thread_id: 's1' },
    { type: 'error', message: 'stream disconnected, retrying 1/5' },
    { type: 'item.completed', item: { type: 'agent_message', text: 'draft' } },
    { type: 'item.completed', item: { type: 'agent_message', text: 'final answer' } },
    { type: 'turn.completed', usage: { input_tokens: 10, output_tokens: 2 } },
  ])
  assert.equal(r.completed, true)
  assert.equal(r.error, null)
  assert.equal(r.message, 'final answer')
  assert.deepEqual(r.usage, { input_tokens: 10, output_tokens: 2 })
  assert.deepEqual(['not json', ''].reduce(applyEvent, newRun()), newRun())
})

const req = {
  id: 'rc:20', kind: 'review_comment', commentId: 20, path: 'src/a.js', line: 42, author: 'dave', repo: 'acme/app', number: 7, isPR: true,
  url: 'https://github.com/acme/app/pull/7#r20', body: '@botlite is this line safe?',
  thread: { title: 'Fix it', body: 'Fixes the crash', url: 'https://github.com/acme/app/pull/7', author: 'alice', state: 'open' },
}
const pr = { headSha: 'abcdef1234567', baseRef: 'main' }

test('newSessionPrompt: identity, sandbox, fenced thread, request, reply contract', () => {
  const p = newSessionPrompt({
    login: 'botlite',
    req,
    pr,
    comments: [{ id: 20, body: 'the request itself', user: { login: 'dave' } }, { id: 9, body: 'x'.repeat(5000), user: { login: 'carol' } }],
  })
  assert.match(p, /You are @botlite/)
  assert.match(p, /git diff origin\/main\.\.\.HEAD/)
  assert.match(p, /<github>\nPull request acme\/app#7 "Fix it" by @alice \(open\)/)
  assert.match(p, /Request from @dave on `src\/a\.js` line 42 — https:\/\/github\.com\/acme\/app\/pull\/7#r20:\n\n@botlite is this line safe\?\n<\/github>/)
  assert.doesNotMatch(p, /the request itself/) // not repeated as history
  assert.match(p, /@carol: x{1500}\n…\(truncated\)/)
  assert.match(p, /addressed to @dave/)
})

test('followUpPrompt: only the new request, and a note when the PR head moved', () => {
  assert.doesNotMatch(followUpPrompt({ login: 'botlite', req, headMoved: false, pr }), /new commits/)
  const moved = followUpPrompt({ login: 'botlite', req, headMoved: true, pr })
  assert.match(moved, /new commits since your last reply — the checkout now points at abcdef1/)
  assert.match(moved, /Request from @dave/)
})

test('prompts: every turn says whether it may publish — a follow-up can come from someone who may not', () => {
  const write = { allowed: true, describe: 'as a new draft PR into main', base: 'feedbead'.repeat(5) }
  for (const p of [newSessionPrompt({ login: 'botlite', req, pr, write }), followUpPrompt({ login: 'botlite', req, pr, headMoved: true, write })]) {
    assert.match(p, /This request may publish changes\. The checkout is on a local branch, `botlite`, at the commit a change builds on \(feedbea\)/)
    assert.match(p, /commit it there with `git commit`/)
    assert.match(p, /Don't push — after you finish, your commits are checked and published as a new draft PR into main, as one new commit by @botlite, so don't quote your own commits' hashes\./)
    assert.match(p, /workflows, actions, CODEOWNERS, submodules, symlinks or funding links are refused/)
    assert.doesNotMatch(p, /the checkout now points at/) // on a write turn the checkout is the base, not the PR head
  }
  const denied = { allowed: false, why: 'only maintainers of this repo and people an admin added can' }
  for (const p of [newSessionPrompt({ login: 'botlite', req, pr, write: denied }), followUpPrompt({ login: 'botlite', req, pr, write: denied })]) {
    assert.match(p, /You can't publish changes for this request \(@dave: only maintainers of this repo and people an admin added can\)\. If it asks for a PR, say so and give the change as a diff instead\./)
    assert.doesNotMatch(p, /may publish/)
  }
  assert.match(newSessionPrompt({ login: 'botlite', req, pr }), /You can't publish changes for this request/) // no write info → no publishing
})

// Slack (slack-channel.mjs): the same Codex, a Slack thread's prompts.
const talk = {
  bot: 'botlite',
  workspace: 'Acme',
  place: 'a channel',
  permalink: 'https://acme.slack.com/archives/C1/p1712345699000200?thread_ts=1712345678.000100&cid=C1',
  asker: 'dave',
  text: '@botlite why does `npm test` fail on main?',
  ttl: '15 minutes',
}

test('Slack prompts: sharing is an agent tool on new and resumed turns, with no blanket posting ban', () => {
  for (const prompt of [slackSessionPrompt, slackFollowUpPrompt]) {
    const p = prompt({ ...talk, services: [SLACK_SERVICE] })
    assert.match(p, /mcp__slack__share_channel/)
    assert.match(p, /"target_channel_id":"C1234567890"/)
    assert.match(p, /only when the user asks/)
    assert.match(p, /ask for a channel mention/)
    assert.match(p, /controller fixes the source/)
    assert.match(p, /tool result to report success or failure/)
    assert.doesNotMatch(p, /You cannot post to Slack yourself:/)
    assert.doesNotMatch(prompt(talk), /mcp__slack__/)
  }
  const args = codexArgs({ ...base, tools: [SLACK_SERVICE] })
  assert.ok(args.includes('mcp_servers.slack={ url = "https://8788-d-abc.proxy.boxlite.ai/mcp/slack", bearer_token_env_var = "BOTLITE_JOB_TOKEN", enabled_tools = ["share_channel"], startup_timeout_sec = 30, tool_timeout_sec = 120 }'))
})

test('slackSessionPrompt: identity, machine, fenced thread with its history, the request, files, reply contract', () => {
  const p = slackSessionPrompt({
    ...talk,
    history: [{ who: '@alice', text: 'CI is red since this morning' }, { who: 'CI (app)', text: 'x'.repeat(5000) }],
    files: { saved: [{ path: 'slack-files/1712345699.000200/ci.log', size: 12_345, mimetype: 'text/plain' }], skipped: [{ name: 'core.dump', why: 'larger than 5.0 MB' }] },
  })
  assert.match(p, /^You are @botlite, a coding agent that people in the Acme Slack workspace summon/)
  assert.match(p, /after 15 minutes without\none, the thread moves to a fresh machine/)
  assert.match(p, /You hold no credentials/)
  assert.match(p, /<slack>\nThread in a channel — https:\/\/acme\.slack\.com\/archives\/C1\/p1712345699000200\?thread_ts=1712345678\.000100&cid=C1\n/)
  assert.match(p, /Earlier messages in the thread, oldest first:\n\n@alice: CI is red since this morning\n\nCI \(app\): x{1500}\n…\(truncated\)/)
  assert.match(p, /Request from @dave:\n\n@botlite why does `npm test` fail on main\?\n/)
  assert.match(p, /saved in your working directory:\n- slack-files\/1712345699\.000200\/ci\.log \(12 KB, text\/plain\)/)
  assert.match(p, /that you don't have:\n- core\.dump: larger than 5\.0 MB\n<\/slack>/)
  assert.match(p, /posted verbatim\nas @botlite's reply in this thread\. Write it in standard Markdown/)
  assert.doesNotMatch(slackSessionPrompt(talk), /Earlier messages|Files attached/) // a thread that starts with the request
})

test('slackFollowUpPrompt: what was said since the last reply, then only the new request', () => {
  const p = slackFollowUpPrompt({ ...talk, since: [{ who: '@erin', text: 'I tried node 22, same error' }] })
  assert.match(p, /^New request in the same thread\.\n\nOpening pull requests isn't available right now \(PR writing is off\)[^\n]*\n\n<slack>\nMessages in the thread since your last reply, oldest first:\n\n@erin: I tried node 22, same error\n\nRequest from @dave — https:\/\/acme/)
  assert.match(p, /As before, your final message is posted verbatim as @botlite's reply in this thread\.$/)
  assert.doesNotMatch(slackFollowUpPrompt(talk), /since your last reply/)
})

test('Slack prompts: how to ask for a PR, that it is public, and where — or why not, and a patch instead', () => {
  const prs = { ok: true, repos: ['boxlite-ai/*'] }
  for (const p of [slackSessionPrompt({ ...talk, prs }), slackFollowUpPrompt({ ...talk, prs })]) {
    assert.match(p, /draft pull request, opened on GitHub from the bot's own account,\ninto a public repo in boxlite-ai\/\*\./)
    assert.match(p, /write pr\.json in your working directory:\n\{"repo": "owner\/name", "dir": "<the clone's path, relative to your working directory>"\}/)
    assert.match(p, /can't push or use gh yourself: this is the only way/)
    assert.match(p, /A PR is public[\s\S]*nothing from this thread or the team's tools that shouldn't be public\./)
  }
  const off = slackSessionPrompt({ ...talk, prs: { ok: false, why: 'an admin (@Dorian) paused PR writing' } })
  assert.match(off, /Opening pull requests isn't available right now \(an admin \(@Dorian\) paused PR writing\): if you're asked for one, say so, and put the change in your reply as a patch\./)
  assert.doesNotMatch(off, /pr\.json/)
})

test('codexArgs: each tool service is an MCP server at the controller, on the job token, showing only its listed tools', () => {
  const args = codexArgs({ ...base, tools: [{ name: 'linear', tools: ['get_issue', 'save_comment'] }, { name: 'docs', tools: ['read_doc'] }] })
  assert.ok(args.includes('mcp_servers.linear={ url = "https://8788-d-abc.proxy.boxlite.ai/mcp/linear", bearer_token_env_var = "BOTLITE_JOB_TOKEN", enabled_tools = ["get_issue", "save_comment"], startup_timeout_sec = 30, tool_timeout_sec = 120 }'))
  assert.ok(args.some((a) => a.startsWith('mcp_servers.docs={ url = "https://8788-d-abc.proxy.boxlite.ai/mcp/docs"')))
  assert.equal(codexArgs(base).some((a) => a.startsWith('mcp_servers.')), false)
  assert.throws(() => codexArgs({ ...base, tools: [{ name: 'linear', tools: ['x"], url = "https://evil'] }] }), /bad tool service/)
  assert.throws(() => codexArgs({ ...base, tools: [{ name: 'lin ear', tools: [] }] }), /bad tool service/)
})

test('prompts: the tools, their names and whose account they use; changes only when asked — or read-only', () => {
  const services = [{ name: 'linear', label: 'Linear', writes: true }, { name: 'docs', label: 'Google Docs', writes: false }]
  const p = slackSessionPrompt({ ...talk, services })
  assert.match(p, /You also have tools for the team's Linear and Google Docs \(named mcp__linear__… and mcp__docs__…\),\nsigned in as the bot's own account/)
  assert.match(p, /You can make some changes, in Linear\. They show up as the bot, so\nmake one only when the request asks for it, and say in your answer what you changed\./)
  assert.match(slackSessionPrompt({ ...talk, services: [{ name: 'notion', label: 'Notion', writes: false }] }), /tools for the team's Notion \(named mcp__notion__…\)[\s\S]*They only read\./)
  assert.doesNotMatch(slackSessionPrompt(talk), /You also have tools/)
  assert.doesNotMatch(p, /This thread is public/) // a workspace's members only
  assert.match(slackFollowUpPrompt({ ...talk, services }), /^New request in the same thread\.\n\nTools this turn: Linear and Google Docs — as before, change things only when asked, and say what you changed\.\n\nOpening pull requests isn't available[^\n]*\n\n<slack>/)
  assert.match(slackFollowUpPrompt({ ...talk, services: [{ name: 'notion', label: 'Notion', writes: false }] }), /Tools this turn: Notion \(they only read\)\./)
})

test('prompts: on GitHub the tools come only to an admin’s turn, which is told the thread is public', () => {
  const services = [{ name: 'linear', label: 'Linear', writes: false }]
  const p = newSessionPrompt({ login: 'botlite', req, pr, write: { allowed: false, why: 'x' }, services })
  assert.match(p, /You also have tools for the team's Linear \(named mcp__linear__…\)/)
  assert.match(p, /This thread is public, and so is your answer: use what the tools show you to do the work, but put\nin your answer only what the request needs, and nothing that shouldn't be public\./)
  assert.doesNotMatch(newSessionPrompt({ login: 'botlite', req, pr }), /You also have tools|This thread is public/) // everyone else's turn
  assert.match(followUpPrompt({ login: 'botlite', req, pr, services }), /^New request in the same thread\.\nTools this turn: Linear \(they only read\)\./)
})
