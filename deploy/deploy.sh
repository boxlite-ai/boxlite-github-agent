#!/usr/bin/env bash
# Deploy @botlite onto BoxLite: the controller box (session boxes — one per issue, PR or Slack
# thread — are created by the controller on demand; the context volume must exist or be creatable).
#
# Only BOXLITE_API_KEY is required. Anything else can be handed over later — the controller waits
# for it, and `node deploy/ctl.mjs status` says what it's waiting for:
#
#   BOXLITE_API_KEY=blk_live_… [GITHUB_TOKEN=ghp_…] [CONTEXT_SECRET=…] bash deploy/deploy.sh
#
#   GITHUB_TOKEN     classic PAT of the bot's own GitHub account (notifications + public_repo);
#                    or later: GITHUB_TOKEN=… node deploy/ctl.mjs github-token
#   CODEX_AUTH_FILE  an existing device login of the bot (default ~/.botlite-codex/auth.json);
#                    if absent the controller runs the device login itself, in its box — the
#                    link and one-time code show up in `node deploy/ctl.mjs status`
#   CONTEXT_SECRET   seals thread contexts; else the controller generates one and keeps it. Pass
#                    the same one on redeploys to keep threads' context across a new box.
#   WEBHOOK_SECRET   the GitHub App webhook's secret, likewise (else the App needs the new one)
#
# The Slack app's tokens, and Slack threads' own context secret, are handed over afterwards:
# `ctl slack-tokens`, or the deploy workflow's handover (README: "From GitHub").
#
# Nothing is written to disk and no credential appears in any process's argv (curl gets its auth
# header through a pipe, jq reads secrets from its environment). Every credential passed here
# becomes a BoxLite secret: the controller sees only a placeholder, swapped for the real value
# on the way to its own host.
# The bot's handle is whoever GITHUB_TOKEN belongs to (BOT_LOGIN only names who you expect).
# Optional: BOT_LOGIN (boxliteai) VOLUME (botlite-context) CODEX_MODEL CODEX_EFFORT BOTLITE_REF (main)
#           BOXLITE_URL (https://api.boxlite.ai)
#           BOT_ADMINS  GitHub logins, comma-separated, who may ask for PRs anywhere and run the
#                       admin commands; PR writing also needs the push App (ctl github-app)
set -euo pipefail

API="${BOXLITE_URL:-https://api.boxlite.ai}"
BOT="${BOT_LOGIN:-boxliteai}"
VOLUME="${VOLUME:-botlite-context}"
REF="${BOTLITE_REF:-main}"
AUTH_FILE="${CODEX_AUTH_FILE:-$HOME/.botlite-codex/auth.json}"
NAME=botlite-controller
PORT=8788
: "${BOXLITE_API_KEY:?set BOXLITE_API_KEY}"
export BOXLITE_API_KEY
command -v jq >/dev/null || { echo "✘ jq is required" >&2; exit 1; }
die() { echo "✘ $*" >&2; exit 1; }

# curl with its auth header fed through a pipe (printf is a builtin: no argv); stdin stays free
# for a request body. Prints the response body, then the status code on the last line.
authed() { local token=$1; shift; curl -sS --config <(printf 'header = "Authorization: Bearer %s"\n' "$token") -w '\n%{http_code}' "$@"; }
bl() { local method=$1 path=$2; shift 2; authed "$BOXLITE_API_KEY" -X "$method" -H 'Content-Type: application/json' "$API$path" "$@"; }
status() { tail -n1 <<<"$1"; }
body() { sed '$d' <<<"$1"; }

echo "→ The bot's ChatGPT login…"
if [ -f "$AUTH_FILE" ]; then
  CHATGPT_ACCESS_TOKEN=$(jq -r '.tokens.access_token // empty' "$AUTH_FILE")
  CHATGPT_REFRESH_TOKEN=$(jq -r '.tokens.refresh_token // empty' "$AUTH_FILE")
  CHATGPT_ACCOUNT_ID=$(jq -r '.tokens.account_id // empty' "$AUTH_FILE")
  CHATGPT_LAST_REFRESH=$(jq -r '.last_refresh // empty' "$AUTH_FILE")
  [ -n "$CHATGPT_ACCESS_TOKEN" ] && [ -n "$CHATGPT_REFRESH_TOKEN" ] && [ -n "$CHATGPT_ACCOUNT_ID" ] || die "$AUTH_FILE is not a ChatGPT (device) login"
  export CHATGPT_ACCESS_TOKEN CHATGPT_REFRESH_TOKEN
  echo "  from $AUTH_FILE: account $CHATGPT_ACCOUNT_ID · last refreshed ${CHATGPT_LAST_REFRESH:-unknown}"
else
  CHATGPT_ACCOUNT_ID='' CHATGPT_LAST_REFRESH=''
  echo "  none at $AUTH_FILE — the controller will run the device login in its box (see ctl status)"
fi

echo "→ The bot's GitHub token…"
if [ -n "${GITHUB_TOKEN:-}" ]; then
  export GITHUB_TOKEN
  HDRS=$(mktemp); trap 'rm -f "$HDRS"' EXIT
  res=$(authed "$GITHUB_TOKEN" -D "$HDRS" https://api.github.com/user)
  [ "$(status "$res")" = 200 ] || die "GitHub rejected GITHUB_TOKEN ($(status "$res"))"
  login=$(body "$res" | jq -r .login)
  scopes=$(grep -i '^x-oauth-scopes:' "$HDRS" | cut -d: -f2- | tr -d '\r' || true)
  [ "$(tr '[:upper:]' '[:lower:]' <<<"$login")" = "$(tr '[:upper:]' '[:lower:]' <<<"$BOT")" ] || echo "  ⚠ token belongs to @$login, not @$BOT — mentions of @$BOT won't reach it"
  # The bot opens PRs with this token, so no reach beyond public repos (`repo` covers private ones).
  grep -Eq '(^|[ ,])(repo|delete_repo)(,|$)' <<<"$scopes" && die "token has more scopes than the bot should hold (has:$scopes) — use a classic PAT with notifications + public_repo"
  grep -Eq '(^|[ ,])notifications(,|$)' <<<"$scopes" || die "token lacks the notifications scope (has:$scopes) — use a classic PAT"
  grep -Eq '(^|[ ,])public_repo(,|$)' <<<"$scopes" || die "token lacks the public_repo scope (has:$scopes)"
  grep -Eq '(^|[ ,])workflow(,|$)' <<<"$scopes" || echo "  ⚠ token lacks the workflow scope — a fork can't catch up with an upstream that changed a workflow, and PRs from it fail"
  echo "  @$login ·$scopes"
else
  echo "  not given — the controller will wait for it (GITHUB_TOKEN=… node deploy/ctl.mjs github-token)"
fi

echo "→ Context volume \"$VOLUME\"…"
res=$(bl GET /v1/volumes)
if [ "$(status "$res")" = 403 ]; then
  echo "  ⚠ this API key has no volume permission — make sure a volume named \"$VOLUME\" exists (BoxLite dashboard → Volumes)"
elif [ "$(status "$res")" != 200 ]; then
  die "listing volumes failed ($(status "$res")): $(body "$res" | head -c 300)"
elif body "$res" | jq -e --arg v "$VOLUME" '(.volumes? // .items? // .data? // .) | map(select(.name == $v or .id == $v)) | length > 0' >/dev/null; then
  echo "  exists"
else
  res=$(bl POST /v1/volumes --data "$(jq -n --arg n "$VOLUME" '{name: $n}')")
  case "$(status "$res")" in
    2*) echo "  created" ;;
    403) die "this API key can't create volumes — create \"$VOLUME\" in the BoxLite dashboard (Volumes), then re-run" ;;
    *) die "creating the volume failed ($(status "$res")): $(body "$res" | head -c 300)" ;;
  esac
fi

echo "→ Controller box \"$NAME\"…"
if [ "$(status "$(bl GET "/v1/boxes/$NAME")")" = 200 ]; then
  echo "  replacing the running controller"
  bl DELETE "/v1/boxes/$NAME?force=true" >/dev/null
  for _ in $(seq 1 30); do [ "$(status "$(bl GET "/v1/boxes/$NAME")")" = 404 ] && break; sleep 2; done
fi

# The controller's program: fetch this repo, then run it forever — nothing else restarts a box.
# Each restart pulls the branch first (`ctl restart` = deploy new code, keep login and state).
BOOT='set -u
mkdir -p "$HOME/.botlite" && exec >> "$HOME/.botlite/controller.log" 2>&1
cd "$HOME"
[ -d botlite/.git ] || git clone --quiet --branch "$BOTLITE_REF" https://github.com/boxlite-ai/boxlite-github-agent.git botlite
# The pull gate (deploy/post-merge.sh): installed once; a pull never replaces a hook. If that fails,
# the bot still starts (the rollback in src/main.mjs still guards it), and the log says so.
[ -x botlite/.git/hooks/post-merge ] || install -m 755 botlite/deploy/post-merge.sh botlite/.git/hooks/post-merge \
  || echo "$(date -u +%FT%TZ) gate: not installed, so pulls go unchecked until ctl hook installs it"
export STATE_FILE="${STATE_FILE:-$HOME/.botlite/state.json}"
# BoxLite swaps secrets in by intercepting HTTPS with a CA it adds to the system bundle; Node only
# trusts its own bundle unless told (without this: SELF_SIGNED_CERT_IN_CHAIN on every call).
export NODE_EXTRA_CA_CERTS=/etc/ssl/certs/ca-certificates.crt
# Codex CLI, for the ChatGPT device login run in this box.
command -v codex >/dev/null || npm install -g --silent --prefix "$HOME/.codex-cli" @openai/codex@0.155.1
export PATH="$HOME/.codex-cli/bin:$PATH"
has_ws() { "$@" -e "process.exit(typeof WebSocket === \"function\" ? 0 : 1)" 2>/dev/null; }
if has_ws node; then NODE=(node)
elif has_ws node --experimental-websocket; then NODE=(node --experimental-websocket)
else npm install -g --silent --prefix "$HOME/.node22" node@22 && NODE=("$HOME/.node22/bin/node"); fi
while true; do
  git -C botlite pull --quiet --ff-only || echo "git pull failed; running what is checked out"
  echo "$(date -u +%FT%TZ) starting controller ($(git -C botlite rev-parse --short HEAD))"
  "${NODE[@]}" botlite/src/main.mjs
  code=$? # taken now: inside the echo, $(date) would have reset it to 0
  echo "$(date -u +%FT%TZ) controller exited ($code), restarting in 10s"; sleep 10
done'

# Public inbound: session boxes reach the controller's model proxy over its preview URL (every
# request needs a live job token; everything else there is a 404).
jq -n --arg name "$NAME" --arg volume "$VOLUME" --arg ref "$REF" --arg model "${CODEX_MODEL:-}" --arg effort "${CODEX_EFFORT:-}" --arg admins "${BOT_ADMINS:-}" \
  --arg account "$CHATGPT_ACCOUNT_ID" --arg refreshed "$CHATGPT_LAST_REFRESH" --arg port "$PORT" --arg boot "$BOOT" '{
    name: $name, image: "node", cpus: 1, memory_mib: 2048,
    network: {outbound: {mode: "enabled"}, inbound: {mode: "enabled"}},
    auto_stop: 0,
    env: ({VOLUME: $volume, BOTLITE_REF: $ref, PORT: $port}
          + (if $ENV.CONTEXT_SECRET then {CONTEXT_SECRET: $ENV.CONTEXT_SECRET} else {} end)
          + (if $ENV.WEBHOOK_SECRET then {WEBHOOK_SECRET: $ENV.WEBHOOK_SECRET} else {} end)
          + (if $account == "" then {} else {CHATGPT_ACCOUNT_ID: $account} end)
          + (if $refreshed == "" then {} else {CHATGPT_LAST_REFRESH: $refreshed} end)
          + (if $model == "" then {} else {CODEX_MODEL: $model} end)
          + (if $effort == "" then {} else {CODEX_EFFORT: $effort} end)
          + (if $admins == "" then {} else {BOT_ADMINS: $admins} end)),
    secrets: [
      {name: "boxlite", value: $ENV.BOXLITE_API_KEY, hosts: ["api.boxlite.ai"]},
      (if $ENV.GITHUB_TOKEN then {name: "github", value: $ENV.GITHUB_TOKEN, hosts: ["api.github.com"]} else empty end),
      (if $ENV.CHATGPT_ACCESS_TOKEN then {name: "chatgpt_access", value: $ENV.CHATGPT_ACCESS_TOKEN, hosts: ["chatgpt.com"]} else empty end),
      (if $ENV.CHATGPT_REFRESH_TOKEN then {name: "chatgpt_refresh", value: $ENV.CHATGPT_REFRESH_TOKEN, hosts: ["auth.openai.com"]} else empty end)
    ],
    cmd: ["bash", "-lc", $boot]
  }' | { res=$(bl POST /v1/boxes --data @-); case "$(status "$res")" in
    2*|408) ;; # 408: still starting in the background
    *) die "creating the controller failed ($(status "$res")): $(body "$res" | head -c 300)" ;;
  esac; }

echo "→ Waiting for the controller to come up…"
# The process is running (`mai[n]` so the check can't match its own command line; /proc needs no
# procps) and its proxy answers (bash's /dev/tcp: no node or curl needed in the image).
CHECK=$(jq -n --arg s "grep -qs 'botlite/src/mai[n].mjs' /proc/[0-9]*/cmdline && exec 3<>/dev/tcp/127.0.0.1/$PORT && printf 'GET /healthz HTTP/1.0\\r\\n\\r\\n' >&3 && head -1 <&3 | grep -q ' 200'" '{command: "bash", args: ["-lc", $s]}')
ok=""
for _ in $(seq 1 36); do
  sleep 5
  res=$(bl POST "/v1/boxes/$NAME/exec" --data "$CHECK")
  exec_id=$(body "$res" | jq -r '.execution_id // empty' 2>/dev/null || true)
  [ -n "$exec_id" ] || continue
  st=''
  for _ in $(seq 1 10); do
    sleep 1
    st=$(body "$(bl GET "/v1/boxes/$NAME/executions/$exec_id")")
    [ "$(jq -r '.status // empty' <<<"$st" 2>/dev/null)" = completed ] && break
  done
  [ "$(jq -r '.exit_code // empty' <<<"$st" 2>/dev/null)" = 0 ] && { ok=1; break; }
done

echo
if [ -n "$ok" ]; then
  echo "✅ controller up. What it's doing / waiting for:"
  node "$(dirname "$0")/ctl.mjs" status || true
else
  echo "⚠ The controller box exists but isn't confirmed up yet — try: node deploy/ctl.mjs logs"
fi
