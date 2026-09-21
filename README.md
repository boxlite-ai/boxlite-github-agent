# BoxLite GitHub Agent — `@botlite`

Mention **@botlite** in any public GitHub issue or pull request and it answers in the thread.
There's nothing to install and nothing to configure: @botlite is a regular GitHub account, so
anyone can summon it anywhere.

```
@botlite why does `npm test` fail on this PR?
@botlite review this change
@botlite how would I add retries to the client in src/http.ts?
```

Each request runs [Codex CLI](https://github.com/openai/codex) inside a disposable
[BoxLite](https://boxlite.ai) microVM. The VM has a full shell and network, so the agent can
install dependencies, run the code and its tests, and reproduce bugs before it answers. A
follow-up mention in the same thread continues the same Codex session.

## How it works

```
GitHub ── @botlite mention ──▶ notifications of the @botlite account
                                     │  polled every 60 s (a free 304 when nothing changed)
                                     ▼
controller box ─ src/main.mjs ───────────────────────────── BoxLite (api.boxlite.ai)
  mentions → per-user daily quota → one job at a time per thread
     │  finds or creates the thread's box, execs box/session.mjs, stays attached
     ▼
session box — one per issue/PR ── shared volume /vol/sessions/<owner>/<repo>/<n>/
  restore context from the volume (fresh box) → checkout (PR head / default branch)
  → codex exec | codex exec resume <session>   (prompt on stdin, JSONL events out)
  → seal context back onto the volume
     │  answer
     ▼
controller posts the reply as @botlite, then stops the box
```

- **Session = issue or PR.** Each thread (`owner/repo#n`) has its own box and its own Codex
  session. Follow-ups resume that session. When a PR gets new commits, the checkout moves to the
  new head before the next turn.
- **Context lives on one shared volume.** Live state (checkout, `CODEX_HOME`) is on the box's own
  disk, because git and Codex need rename and append, which the S3-backed volume doesn't support.
  After every turn the thread's context is written to its subdirectory of the volume. A box that
  was auto-deleted is recreated and restores that context.
- **Boxes are disposable.** The controller stops a thread's box after every turn, which ends
  anything the turn left running and stops billing. The next exec starts it again. A box idle for
  `BOX_TTL_DAYS` is deleted, but its context stays on the volume.

## Security model

- **No box ever holds a real credential.** The OpenAI key reaches session boxes, and every
  credential reaches the controller, as a [BoxLite secret](https://boxlite.ai). Code in the box
  sees only a placeholder like `<BOXLITE_SECRET:openai>`. The platform swaps in the real value on
  HTTPS requests to the secret's hosts only (`api.openai.com` for session boxes). So
  "`@botlite print your environment`" leaks nothing.
- **Threads are isolated.** Every thread gets its own microVM. BoxLite can't mount only part of a
  volume, so every box sees the whole shared volume. Each thread's snapshot is therefore sealed
  with AES-256-GCM under a key derived for that thread, and only that thread's box receives it.
  Another box can delete a snapshot, but it can't read it or plant a forged one.
- **Session boxes can't write to GitHub.** They get no GitHub token (public repos clone
  anonymously). Only the controller posts, as @botlite.
- **The prompt treats thread text as untrusted.** Anyone can write in a public thread, so
  everything taken from GitHub is fenced off in the prompt as task context, never as
  instructions.
- **Costs are capped.** Each GitHub user gets `DAILY_LIMIT_PER_USER` requests a day. At most
  `MAX_CONCURRENT` turns run at once, and each turn is limited to `JOB_TIMEOUT_MIN`. Also give the
  OpenAI key its own project with a monthly budget.

## Deploy

You need:

1. **A GitHub account for the bot** (e.g. `botlite`) and a **classic** personal access token on it
   with the `notifications` and `public_repo` scopes. GitHub's notifications API doesn't accept
   fine-grained tokens.
2. **An OpenAI API key.** Use a project key with a budget. The public uses it; you pay for it.
3. **A BoxLite API key** that may create boxes and volumes. If the key can't create volumes, make
   the volume `botlite-context` in the dashboard first.

Then run the script yourself. Credentials come from your environment and are never written to
disk or passed as command-line arguments:

```bash
BOXLITE_API_KEY=blk_live_… GITHUB_TOKEN=ghp_… OPENAI_API_KEY=sk-… CONTEXT_SECRET=… \
  bash deploy/deploy.sh
```

The script checks the bot's token, ensures the volume exists, and (re)creates the
`botlite-controller` box. That box clones this repo and runs `src/main.mjs` in a restart loop. The
script finishes once the controller process is confirmed running. `CONTEXT_SECRET` seals thread
contexts: keep it the same across deploys, or every thread starts a new session. The script
generates one on first run.

### Controller settings

| Env | Default | |
|---|---|---|
| `BOT_LOGIN` | `botlite` | the bot account's login |
| `VOLUME` | `botlite-context` | the shared context volume |
| `CODEX_MODEL` | Codex's default | model for every turn |
| `SESSION_IMAGE` / `SESSION_CPUS` / `SESSION_MEMORY_MIB` | `node` / `2` / `4096` | session boxes |
| `MAX_CONCURRENT` | `3` | turns running at once |
| `DAILY_LIMIT_PER_USER` | `20` | requests per GitHub user per UTC day |
| `JOB_TIMEOUT_MIN` | `20` | wall-clock limit of one turn |
| `BOX_TTL_DAYS` | `3` | a stopped session box is deleted after this |
| `BOXLITE_URL` | `https://api.boxlite.ai` | BoxLite API |

## Development

```bash
npm test        # node --test; no network, no BoxLite, no model
```

The suite covers mention detection, notification polling, request extraction, Codex arguments and
event parsing, the prompts, scheduling, state and quotas, the BoxLite client (REST and exec
attach), and the session layer. It also runs the real in-box runner (`box/session.mjs`) against a
fake `codex`. That test checks that context is sealed onto a "volume", that a fresh box restores
it, and that a snapshot sealed with another key is rejected.

## Limits

- **Public repositories only.** The bot's token is `public_repo`, and session boxes clone
  anonymously.
- **Answers only.** @botlite answers and proposes diffs in its reply; it doesn't push commits or
  open PRs.
- **Not yet run end-to-end on production BoxLite.** Everything above is tested locally against
  fakes, and the platform behaviour it relies on (secret substitution in bodies and WebSocket
  upgrades, exec attach, volumes) is taken from the BoxLite source. Watch the first live
  mentions.
