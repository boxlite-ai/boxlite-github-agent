# BoxLite GitHub Agent — `@boxliteai`

Mention **@boxliteai** in any public GitHub issue or pull request and it answers in the thread.
There's nothing to install: it's a regular GitHub account. Each request runs
[Codex CLI](https://github.com/openai/codex) in that thread's own [BoxLite](https://boxlite.ai)
microVM, with a full shell and network, so it can run the code before it answers.

```
@boxliteai why does `npm test` fail on this PR?
@boxliteai review this change
@boxliteai how would I add retries to the client in src/http.ts?
```

## How it works

![GitHub mentions reach the controller box by polling or App push. The controller holds every real credential, calls chatgpt.com with the real login, and runs one session box per issue or PR. Session boxes hold no credentials, reach the model only through the controller, and keep their context on a shared volume.](docs/architecture.svg)

- **One box and one Codex session per issue or PR.** Follow-ups resume the session. A PR's
  checkout follows its latest head.
- **Codex may do anything in its box:** no sandbox, no approval prompts, `sudo`, network, live web
  search. The microVM is the boundary, and nothing worth stealing is ever inside it.
- **Only the controller holds credentials.** Codex runs on a stand-in login whose token works only
  on the controller's proxy, and only until the turn ends.

### One mention, start to finish

![The controller picks up the mention and reacts 👀, starts the thread's box and execs the runner. The box restores its context, runs Codex with model calls through the controller, seals its context and returns the answer. The controller stops the box, then replies.](docs/mention.svg)

The controller stays attached to the exec for the whole turn, because BoxLite reaps an exec nobody
is attached to. It stops the box as soon as the turn ends, then posts the reply.

### Memory that outlives the box

![Turn 1 runs in box A and seals its context onto the volume. Box A is deleted. Turn 2 runs in a new box B, restores the context and resumes the same Codex session.](docs/memory.svg)

Live state (the checkout and `CODEX_HOME`) stays on the box's own disk, since the S3-backed volume
has no rename or append. After every turn it's sealed with AES-256-GCM under a key derived for that
thread and written to `sessions/<owner>/<repo>/<n>/` on the volume. Every box mounts the whole
volume, but only that thread's box gets the key. Stopped boxes are deleted after `BOX_TTL_DAYS`; the
next mention restores into a new one.

## Who holds what

| Credential | Controller | Session box | Volume |
|---|---|---|---|
| Bot's GitHub token | holds: polls, reacts, replies | never (clones anonymously) | never |
| BoxLite API key | placeholder (a BoxLite secret) | never | never |
| ChatGPT login | holds and refreshes | never (a stand-in login) | never |
| Job token | issues, revokes | its own turn only | never |
| Thread context key | derives | its own thread only | never (sealed bytes only) |
| Webhook secret | holds | never | never |

The proxy forwards only Codex's two model endpoints, 404s everything else, and caps requests per
turn. Text from GitHub goes into the prompt fenced as untrusted context, never as instructions.

## Code map

| File | Runs in | Does |
|---|---|---|
| `src/main.mjs` | controller | wiring: credentials, poll loop, quotas, replies, drain on restart |
| `src/mentions.mjs` · `webhook.mjs` | controller | mentions from polled notifications or App pushes |
| `src/jobs.mjs` · `state.mjs` | controller | one turn per thread, a few at once; seen comments, sessions, quotas |
| `src/session.mjs` | controller | one turn: start or create the box, exec the runner attached, stop it |
| `src/proxy.mjs` · `chatgpt.mjs` | controller | the public port: model endpoints only, job token → real login |
| `src/codex.mjs` | controller | `codex exec` / `resume` arguments, prompts, event parsing |
| `src/boxlite.mjs` | controller | BoxLite REST, exec attach over WebSocket |
| `src/github.mjs` · `reply.mjs` | controller | GitHub REST as the bot: 👀 and replies |
| `box/session.mjs` | session box | restore → stand-in login → checkout → Codex → seal |
| `deploy/deploy.sh` · `ctl.mjs` | your terminal | create the controller; operate it |

## Run your own

```bash
export BOXLITE_API_KEY=blk_live_…
bash deploy/deploy.sh                                 # creates the public botlite-controller box
GITHUB_TOKEN=ghp_… node deploy/ctl.mjs github-token   # the bot account's classic PAT
node deploy/ctl.mjs status                            # what it's waiting for, e.g. the ChatGPT login
```

- **BoxLite key:** it must be able to create boxes. If it can't create volumes, create
  `botlite-context` in the dashboard first.
- **GitHub token:** a *classic* PAT on the bot's own account with `notifications` + `public_repo`
  (the notifications API rejects fine-grained tokens). The bot is whoever the token belongs to.
- **ChatGPT login:** the controller runs `codex login --device-auth` in its box, and `status` shows
  the link and code to approve with the bot's ChatGPT account. Use an account only the bot uses.
- **`CONTEXT_SECRET`** seals contexts and signs job tokens. It's generated on first start. Pass the
  same value to a redeploy (`CONTEXT_SECRET=… bash deploy/deploy.sh`) to keep every thread's context.

Day to day: `node deploy/ctl.mjs status | logs [n] | webhook | restart`. `restart` pulls the
tracked branch and lets running turns finish first.

<details>
<summary>Settings</summary>

The controller reads these from its environment; `deploy.sh` passes `VOLUME`, `CODEX_MODEL` and
`BOTLITE_REF` through.

| Env | Default | |
|---|---|---|
| `VOLUME` | `botlite-context` | the shared context volume |
| `CODEX_MODEL` | Codex's default | model for every turn (also pinned by the proxy) |
| `BOTLITE_REF` | `main` | the branch the controller runs |
| `SESSION_IMAGE` / `SESSION_CPUS` / `SESSION_MEMORY_MIB` | `node` / `2` / `4096` | session boxes |
| `MAX_CONCURRENT` | `3` | turns running at once |
| `DAILY_LIMIT_PER_USER` | `20` | requests per GitHub user per UTC day |
| `JOB_TIMEOUT_MIN` | `20` | wall-clock limit of one turn |
| `BOX_TTL_DAYS` | `3` | a stopped session box is deleted after this |
| `PORT` / `PUBLIC_URL` | `8788` / looked up | the proxy's port and public origin |
| `BOXLITE_URL` | `https://api.boxlite.ai` | BoxLite API |

</details>

### Instant pickup (optional)

Polling takes about 30–85 s from mention to pickup. Repos that install the **BoxLite Agent** GitHub
App get each mention pushed to the controller's `POST /webhook` instead. `node deploy/ctl.mjs
webhook` prints the URL and secret for the App. Subscribe it to *Issues*, *Issue comment*, *Pull
request* and *Pull request review comment*, with read-only *Issues* and *Pull requests*
permissions. A mention that arrives both ways is handled once.

## Develop

```bash
npm test                 # offline: no network, BoxLite or model
BOTLITE_E2E=1 npm test   # + a real Codex turn through the proxy (needs codex 0.150.0)
```

## Limits

- **Public repos, answers only.** It replies and proposes diffs; it doesn't push commits or open
  PRs.
- **A personal ChatGPT plan serves everyone.** OpenAI's terms may not allow a consumer login to be
  used this way; an API key is the sanctioned route for a public service.
- **Codex's private backend.** The model path depends on ChatGPT's Codex backend and Codex's login
  format as of 0.150.0, which is pinned. `BOTLITE_E2E=1 npm test` checks it on upgrade.
- **Region.** The controller must reach `chatgpt.com` and `auth.openai.com` from a country OpenAI
  supports.
