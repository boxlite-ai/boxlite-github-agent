# BoxLite GitHub Agent — `@boxliteai`

Mention **@boxliteai** in any public GitHub issue or pull request and it answers in the thread.
For the repo's maintainers it can also open a draft PR. There's nothing to install: it's a
regular GitHub account. Each request runs [Codex CLI](https://github.com/openai/codex) in that
thread's own [BoxLite](https://boxlite.ai) microVM, with a full shell and network, so it can run
the code before it answers.

```
@boxliteai why does `npm test` fail on this PR?
@boxliteai review this change
@boxliteai add retries to the client in src/http.ts and open a PR
@boxliteai /help
```

## How it works

![GitHub mentions reach the controller box by polling or App push. The controller holds every real credential, calls chatgpt.com with the real login, and runs one session box per issue or PR. Session boxes hold no credentials, reach the model (and, on a write turn, one staging branch of the bot's fork) only through the controller, and keep their context on a shared volume.](docs/architecture.svg)

- **One box and one Codex session per issue or PR.** Follow-ups resume the session. A PR's
  checkout follows its latest head.
- **Codex may do anything in its box:** no sandbox, no approval prompts, no hook reviews, `sudo`,
  network, live web search. The microVM is the boundary, and nothing worth stealing is ever inside it.
- **Every box runs [agent-tooling](https://github.com/boxlite-ai/agent-tooling),** BoxLite's shared
  Codex plugin with its skills, auditors and hooks. It's refreshed to the tip of `main` when it's
  over 10 minutes old.
- **Only the controller holds credentials.** Codex runs on a stand-in login whose token works only
  on the controller's proxy, and only until the turn ends.
- **PRs only for people who may ask.** Codex commits in its box; the controller checks the change
  and opens the PR. Everyone else gets the change as a diff in the reply.

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

### Opening a PR

![Opening a PR: an admin, a maintainer or someone an admin added asks. The controller runs the turn on the commit the change builds on. Codex commits in its box; the runner pushes with its job token to the controller, which lets one staging branch through to the bot's fork with an App token the box never sees. After the turn the controller stops the box, revokes the tokens, checks that exact commit on GitHub's own diff, squashes it into one commit by the bot, and opens a draft PR.](docs/pr.svg)

- **Who may ask:** the bot's admins (`BOT_ADMINS`) anywhere; a repo's maintainers (owner, member,
  collaborator) there; and anyone an admin added to a repo with `/add`.
- **What's checked,** on GitHub's diff of the exact commit pushed: on top of the base, at most 100
  files and 5,000 lines, no file over 1 MiB, no symlinks or submodules, and nothing under
  `.github/workflows`, `.github/actions`, `CODEOWNERS`, `.gitmodules` or `FUNDING.yml`.
  Dependency and lockfile changes pass, but are called out at the top of the PR.
- **What's published:** one commit by the bot on `botlite/<owner>/<repo>/<n>` in its fork, as a
  draft PR into the default branch. For someone else's PR, the draft PR goes into that PR's branch;
  on a PR the bot opened, the commit goes straight onto its branch. A follow-up adds a commit, and a
  branch that moved meanwhile is never overwritten.

### Commands

| Command | Who | Does |
|---|---|---|
| `@boxliteai /help` (or just `@boxliteai help`) | anyone | the commands, and whether you can ask for PRs here |
| `@boxliteai /add @user` · `/remove @user` | admins | who else can ask for PRs in this repo |
| `@boxliteai /list` | admins | who has been added here |
| `@boxliteai /pause` · `/resume` | admins | stop or restart all PR writing |
| `@boxliteai /model [model] [effort]` | admins | show, or set, the model and reasoning effort every turn runs on, e.g. `/model gpt-6-astra xhigh`; `/model default` undoes it |
| `@boxliteai /deploy` | admins | put what's merged on `main` live (see below) |

`/model` takes a model only if ChatGPT's Codex backend offers it (and that effort) to the bot's
pinned Codex, since a bad one would fail every turn.

The controller answers these itself; Codex never sees them. Admin commands count only in a new,
never-edited comment, because anyone with write access to a repo can edit other people's comments
there. People are kept by GitHub id, since a login can change hands.

### Improving itself

![The bot improving itself: asked to change its own code, it opens a draft PR from its fork, and it can't merge (it has read access). A human reviews and merges into main. An admin says /deploy: the controller lists the commits since the running build, finishes running turns and exits; the boot loop pulls main and the launcher starts the new build. A pull is checked before it starts (it must parse, pass the launcher's test and start offline): if it doesn't pass, the controller runs the newest pulled commit that does, or the build it had. Live, it says so in the thread and is on trial for 10 minutes; a build that fails three times in its trial is rolled back to the last good one, and the thread is told.](docs/deploy.svg)

A bot PR that touches its own trust boundary (access, publishing, the push route, credentials, the
runner, deploy) opens with a warning.

### When a deploy goes wrong

| If the new build… | then |
|---|---|
| doesn't parse, link or start, or breaks the launcher | the pull gate, a hook no pull can change, walks back to the newest pulled commit that passes (or the build it had), which starts and says why in the thread |
| passes the gate, but crashes 3× in its first 10 minutes, or isn't polling at the end of them | the launcher rolls back to the last good build, and the thread is told |
| hangs, stuck or with its event loop blocked | a watchdog thread kills it after 10 minutes without progress and the boot loop starts it again; a build still on trial is rolled back |
| can't reach GitHub | `/healthz` answers 503; the **health** workflow opens an issue, and closes it once it's back |
| misbehaves some other way | the **deploy** workflow's `rollback` runs an earlier commit of main |

A rollback keeps what a newer build wrote to the state: fields an older build doesn't know are kept,
not dropped.

## Who holds what

| Credential | Controller | Session box | Volume |
|---|---|---|---|
| Bot's GitHub token | holds: polls, reacts, replies, forks, opens PRs | never (clones anonymously) | never |
| Push App key | holds: one token per write turn, for that fork only | never (pushes via the controller) | never |
| BoxLite API key | placeholder (a BoxLite secret) | never | never |
| ChatGPT login | holds and refreshes | never (a stand-in login) | never |
| Job token | issues, revokes | its own turn only: model calls, and a write turn's one push | never |
| Thread context key | derives | its own thread only | never (sealed bytes only) |
| Webhook secret | holds | never | never |

The proxy forwards only Codex's two model endpoints and a write turn's push to its one staging
branch, 404s everything else, and caps requests per turn. Text from GitHub goes into the prompt
fenced as untrusted context, never as instructions.

## Code map

| File | Runs in | Does |
|---|---|---|
| `src/main.mjs` | controller | the launcher: rolls back a build that won't go live, then starts the controller |
| `src/controller.mjs` | controller | wiring: credentials, poll loop, quotas, replies, drain on restart |
| `src/deploy.mjs` | controller | `/deploy`: what's merged since the running build, and how the deploy went |
| `src/mentions.mjs` · `webhook.mjs` | controller | mentions from polled notifications or App pushes |
| `src/jobs.mjs` · `state.mjs` | controller | one turn per thread, a few at once; seen comments, sessions, quotas |
| `src/session.mjs` | controller | one turn: start or create the box, exec the runner attached, stop it |
| `src/proxy.mjs` · `chatgpt.mjs` | controller | the public port: model endpoints only, job token → real login |
| `src/codex.mjs` | controller | `codex exec` / `resume` arguments, prompts, event parsing |
| `src/access.mjs` | controller | who may publish; `/help` and the admin commands |
| `src/gitpush.mjs` · `githubapp.mjs` | controller | a write turn's one push: job token in, App token out, one ref |
| `src/publish.mjs` | controller | plan a write turn; check the pushed commit, squash it, draft PR |
| `src/boxlite.mjs` | controller | BoxLite REST, exec attach over WebSocket |
| `src/github.mjs` · `reply.mjs` | controller | GitHub REST as the bot: 👀 and replies |
| `box/session.mjs` | session box | restore → stand-in login → checkout → Codex → push commits → seal |
| `deploy/deploy.sh` · `ctl.mjs` | your terminal | create the controller; operate it |
| `deploy/post-merge.sh` | controller | the pull gate: a pull runs only up to its newest commit that passes |
| `.github/workflows/` | GitHub Actions | `test` every PR; `deploy` from the `production` environment; `health` |

## Run your own

```bash
export BOXLITE_API_KEY=blk_live_…
BOT_ADMINS=you bash deploy/deploy.sh                  # creates the public botlite-controller box
GITHUB_TOKEN=ghp_… node deploy/ctl.mjs github-token   # the bot account's classic PAT
GITHUB_APP_ID=… GITHUB_APP_KEY=app.pem node deploy/ctl.mjs github-app   # optional: PR writing
node deploy/ctl.mjs status                            # what it's waiting for, e.g. the ChatGPT login
```

- **BoxLite key:** it must be able to create boxes. If it can't create volumes, create
  `botlite-context` in the dashboard first.
- **GitHub token:** a *classic* PAT on the bot's own account with `notifications` + `public_repo`
  (the notifications API rejects fine-grained tokens). Not `repo`, which reaches private repos:
  the deploy refuses it. The bot is whoever the token belongs to.
- **Push App (PR writing):** a GitHub App of its own, separate from the webhook App. Give it
  *Repository permissions → Contents: Read and write* and nothing else, with no webhook. Install it
  on the bot's account for *all repositories*, so new forks are covered, generate a private key,
  and hand both over with `ctl github-app`. Without it the bot only answers. The controller mints
  one token per write turn for that turn's fork, and the box never sees it.
- **ChatGPT login:** the controller runs `codex login --device-auth` in its box, and `status` shows
  the link and code to approve with the bot's ChatGPT account. Use an account only the bot uses.
- **`CONTEXT_SECRET`** seals contexts and signs job tokens. It's generated on first start. Pass the
  same value to a redeploy (`CONTEXT_SECRET=… bash deploy/deploy.sh`) to keep every thread's context.

Day to day: `node deploy/ctl.mjs status | logs [n] | webhook | restart | rollback <commit> | admins <logins>`.
`restart` pulls the tracked branch and lets running turns finish first; `rollback` runs an earlier
commit of it until the next restart; `admins` replaces `BOT_ADMINS` and restarts, with no redeploy.
Add `--wait` to any of the three to wait until the next start is live and see which build it is.

### From GitHub

Keep the keys in the repo's `production` environment instead of on a laptop: secrets
`BOXLITE_API_KEY`, `BOT_GITHUB_TOKEN` and `PUSH_APP_PRIVATE_KEY`, variables `PUSH_APP_ID` and
`BOT_ADMINS`, with a required reviewer and only `main` allowed to deploy. Then the **deploy**
workflow operates the controller:

| Action | Does |
|---|---|
| `restart` | pull main and restart onto it |
| `handover` | give the controller its tokens and keys from the environment, e.g. after a rotation |
| `rollback` | run an earlier commit of main until the next restart or `/deploy` |

Each run waits until that build is live, and fails with how its start went if it isn't. **health**
checks `/healthz` every 15 minutes once the `CONTROLLER_URL` variable is set. **test** runs
`npm test` on every PR. The ChatGPT login stays in the controller: its refresh token changes as it
is used, so a copy would go stale.

<details>
<summary>Settings</summary>

The controller reads these from its environment; `deploy.sh` passes `VOLUME`, `CODEX_MODEL`,
`CODEX_EFFORT`, `BOTLITE_REF` and `BOT_ADMINS` through.

| Env | Default | |
|---|---|---|
| `BOT_ADMINS` | none | GitHub logins, comma-separated, who may ask for PRs anywhere and run the admin commands (`ctl admins` replaces it) |
| `VOLUME` | `botlite-context` | the shared context volume |
| `CODEX_MODEL` | Codex's default | model for every turn (also pinned by the proxy), until an admin's `/model` |
| `CODEX_EFFORT` | the model's default | reasoning effort for every turn (`low` … `xhigh`, `max`, `ultra`, as the model allows), until `/model` |
| `BOTLITE_REF` | `main` | the branch the controller runs |
| `SESSION_IMAGE` / `SESSION_CPUS` / `SESSION_MEMORY_MIB` | `node` / `2` / `4096` | session boxes |
| `MAX_CONCURRENT` | `3` | turns running at once |
| `DAILY_LIMIT_PER_USER` | `20` | requests per GitHub user per UTC day; the bot's admins have no limit |
| `JOB_TIMEOUT_MIN` | `20` | wall-clock limit of one turn |
| `HANG_MIN` | `10` | the watchdog kills a controller that makes no progress this long |
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
BOTLITE_E2E=1 npm test   # + a real Codex turn and resume through the proxy (needs codex 0.155.1)
```

## Limits

- **Public repos only, and PRs only on request.** It opens draft PRs from its own fork, only for
  the people above, and never pushes to anyone else's branch.
- **Forks that fall behind.** Before a push the controller syncs the fork with upstream. If
  upstream changed a workflow file since the last sync, GitHub may refuse that sync unless the bot's
  PAT also has the `workflow` scope; the turn then says the push failed.
- **A personal ChatGPT plan serves everyone.** OpenAI's terms may not allow a consumer login to be
  used this way; an API key is the sanctioned route for a public service.
- **Codex's private backend.** The model path depends on ChatGPT's Codex backend and Codex's login
  format as of 0.155.1, which is pinned. `BOTLITE_E2E=1 npm test` checks it on upgrade. The
  backend offers each model only from some Codex version on (`gpt-6-astra`: 0.153.0).
- **Region.** The controller must reach `chatgpt.com` and `auth.openai.com` from a country OpenAI
  supports.
