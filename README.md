# BoxLite GitHub Agent

A GitHub Action that reviews every pull request inside a [BoxLite](https://boxlite.ai)
microVM using Claude Code. The model runs **read-only** in a throwaway single-kernel
sandbox — untrusted PR code never touches your CI runner — and a trusted runner-side step
publishes the result as **inline review comments**, **one sticky summary**, and **one
check run**.

It is a **consumer of app.boxlite.ai**, not part of it: GitHub Actions triggers the run,
the review boots on your own BoxLite org, and your keys stay in your own GitHub Secrets.
BoxLite never custodies your credentials.

## Quick start

1. Add secrets (repo or org → Settings → Secrets and variables → Actions):
   - `BOXLITE_API_KEY` — your app.boxlite.ai org key (`blk_live_…`)
   - **one** Claude credential:
     - `ANTHROPIC_API_KEY` — an Anthropic Console API key (`sk-ant-api…`), or
     - `CLAUDE_CODE_OAUTH_TOKEN` — a Claude Pro/Max subscription token from
       `claude setup-token` (`sk-ant-oat…`). Draws on your subscription's limits;
       the box runs genuine Claude Code, so this is a sanctioned use.
2. Add `.github/workflows/boxlite-review.yml` (see [`examples/caller-workflow.yml`](examples/caller-workflow.yml)):

   ```yaml
   name: boxlite-review
   on:
     pull_request:
       types: [opened, synchronize, reopened, ready_for_review]
     issue_comment:            # optional: `@boxlite review` re-runs on demand
       types: [created]
   jobs:
     review:
       if: ${{ github.event_name != 'issue_comment' || contains(github.event.comment.body, '@boxlite review') }}
       runs-on: ubuntu-latest
       permissions: { contents: read, pull-requests: write, checks: write }
       steps:
         - uses: boxlite-ai/boxlite-github-agent@v1
           with:
             boxlite-api-key: ${{ secrets.BOXLITE_API_KEY }}
             anthropic-api-key: ${{ secrets.ANTHROPIC_API_KEY }}
   ```

Open a PR — inline comments and a summary appear in a minute or two. Push a commit and the
review refreshes in place. Comment `@boxlite review` to re-run.

## What you get

- **Inline comments** on the changed lines — a severity badge (🛑 blocker / ⚠️ warning /
  🧹 nit) and, where it applies, a one-click committable ` ```suggestion `. Posted as a
  single review (one notification), not a comment storm.
- **A sticky summary** — a one-line verdict and a compact call-graph of the change
  (file → symbol → ±LOC → note). Findings that fall outside the diff collapse into it.
- **A check run** — `success` when clean, `neutral` when there are findings (it never
  blocks merges), with the findings as annotations.

## Branded bot (optional, one-click install)

By default comments post as `github-actions[bot]`. To post as your own `your-app[bot]`:

1. Register a GitHub App (Settings → Developer settings → GitHub Apps). Permissions:
   **Pull requests: Read & write**, **Checks: Read & write**, **Contents: Read**,
   **Metadata: Read**. Generate a private key.
2. Install it on the target repos (this is the one-click experience).
3. Store the App id and private key as secrets (`BOXLITE_REVIEWER_APP_ID`,
   `BOXLITE_REVIEWER_APP_PRIVATE_KEY`) and pass them:

   ```yaml
   - uses: boxlite-ai/boxlite-github-agent@v1
     with:
       boxlite-api-key: ${{ secrets.BOXLITE_API_KEY }}
       anthropic-api-key: ${{ secrets.ANTHROPIC_API_KEY }}
       app-id: ${{ secrets.BOXLITE_REVIEWER_APP_ID }}
       app-private-key: ${{ secrets.BOXLITE_REVIEWER_APP_PRIVATE_KEY }}
   ```

The Action mints a short-lived, repo-scoped installation token from the App key via
[`actions/create-github-app-token`](https://github.com/actions/create-github-app-token).

The App private key is *your* master credential — with `app-private-key` it lives in the
secrets of repos/orgs **you** control. To let it stay yours while **anyone** installs the
bot, use the broker below instead.

### Public `@boxlite` bot (anyone can install)

To let *anyone* install the bot and have reviews post as `@boxlite[bot]` — without handing
your App key to every caller — run the token broker in [`broker/`](broker/README.md): a
tiny Cloudflare Worker that holds the App key and vends a per-repo, least-privilege token
after verifying each run's GitHub OIDC claim. Callers then just install `@boxlite` and add
`broker-url:` (with `id-token: write`) — no App key in their repo:

```yaml
permissions: { contents: read, pull-requests: write, checks: write, id-token: write }
steps:
  - uses: boxlite-ai/boxlite-github-agent@v1
    with:
      boxlite-api-key: ${{ secrets.BOXLITE_API_KEY }}
      anthropic-api-key: ${{ secrets.ANTHROPIC_API_KEY }}
      broker-url: https://boxlite-token-broker.<you>.workers.dev
```

## How it works

```
PR opened / pushed / `@boxlite review`
      │  GitHub fires the workflow (your Actions minutes)
      ▼
GitHub-hosted runner  ── trigger + publisher (this Action)
   holds for this job only: GH token (App or github.token) + your 2 secrets
      │  JsBoxlite.rest(app.boxlite.ai, your BOXLITE_API_KEY)
      ▼
BoxLite microVM  ── booted in YOUR org, isolated single-kernel sandbox
   clone PR → `claude -p` reviews the diff (read-only tools, no write token)
   → prints structured findings JSON
      │  findings travel back over the exec channel
      ▼
runner publishes: inline review + sticky summary + check run
      │
      ▼
runner deletes the box → compute back to zero
```

The box only reads and reasons; **every GitHub write happens on the runner**. Secrets
reach the box **per-exec** — never baked into the box image or persisted in box env. The
in-box entrypoint is pure Node ([`broker/src/reviewer.js.txt`](broker/src/reviewer.js.txt));
the publisher is [`lib/publish.mjs`](lib/publish.mjs).

## Security model

- **No custody.** Your BoxLite and Anthropic keys live in your GitHub Secrets and reach
  the box per-exec. Nothing is stored on a BoxLite-run service.
- **Isolation.** Each review runs in its own microVM kernel — a throwaway VM, so untrusted
  PR code is isolated from your CI runner and host.
- **The box makes no GitHub writes.** The clone token is scrubbed from `.git/config`
  before the model starts, and Claude runs read-only (`Read`, `Grep`, `Glob`, and
  `git diff/log/show` only) without the write token. The runner does all posting.
- **Fork PRs.** `pull_request` runs from forks don't receive secrets (GitHub policy), so
  this reviews same-repo PRs. Reviewing fork PRs needs the hosted-App path.

## Repository configuration

The `PROMPT` in [`broker/src/reviewer.js.txt`](broker/src/reviewer.js.txt) is the base review
policy. For per-repo tuning, add `.boxlite-review.yml` at the repo root:

```yaml
path_filters:                 # globs; `!` excludes. Findings under excluded paths are dropped.
  - "src/**"
  - "!**/*.lock"
  - "!dist/**"
path_instructions:            # extra guidance for matching files
  - path: "**/*.test.ts"
    instructions: "Focus on edge-case coverage."
focus: "security and concurrency"   # extra emphasis for the whole review
language: "zh-CN"             # language for the review prose (default: English)
profile: "lean"               # lean = high-signal · strict = also flag nits
```

## Local dry run

Test the whole pipeline from a laptop against a real microVM, no GitHub App:

```bash
npm install --no-save @boxlite-ai/boxlite yaml
export BOXLITE_API_KEY=blk_live_…
export ANTHROPIC_API_KEY=sk-ant-…            # or: export CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat…
export REPO=owner/repo PR_NUMBER=<n> GH_TOKEN=$(gh auth token) BASE_REF=main
export HEAD_SHA=$(gh pr view $PR_NUMBER --repo $REPO --json headRefOid -q .headRefOid)
node orchestrate.mjs
```

Inline comments + a sticky summary on the PR mean the pipeline works.

## Tests

Pure logic is unit-tested (no network, no microVM):

```bash
node --test test/*.test.mjs
```

Covers the findings contract (`lib/findings.mjs`), diff-mapping and rendering
(`lib/publish.mjs`), and the sticky-comment upsert (`lib/comment.mjs`).

## Inputs

| Input | Required | Default | Notes |
|---|---|---|---|
| `boxlite-api-key` | yes | — | Boots the review box in your org |
| `anthropic-api-key` | one of | — | Anthropic Console API key |
| `claude-code-oauth-token` | one of | — | `claude setup-token` subscription token |
| `boxlite-url` | no | `https://app.boxlite.ai/api` | REST base URL |
| `boxlite-image` | no | curated node image | Box image (must be curated) |
| `model` | no | Claude Code default | Explicit model id; empty tracks the latest |
| `trigger-phrase` | no | `@boxlite review` | Comment phrase that re-runs a review |
| `app-id` / `app-private-key` | no | — | Set both for the branded bot |
