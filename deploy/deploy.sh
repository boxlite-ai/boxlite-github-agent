#!/usr/bin/env bash
# Deploy @botlite onto BoxLite: the shared context volume + the controller box. Session boxes
# (one per issue/PR) are created by the controller on demand.
#
# Before the first deploy, give the bot its own ChatGPT login — kept in a file, not the keychain,
# and separate from your personal one (the controller rotates it; a login in use elsewhere breaks):
#
#   CODEX_HOME=~/.botlite-codex codex login --device-auth -c cli_auth_credentials_store='"file"'
#
# Then run this yourself. Credentials come from your environment and that file; nothing is written
# to disk, and no credential appears in any process's argv (curl gets its auth header through a
# pipe, jq reads secrets from its environment):
#
#   BOXLITE_API_KEY=blk_live_… GITHUB_TOKEN=ghp_… CONTEXT_SECRET=… bash deploy/deploy.sh
#
#   GITHUB_TOKEN     classic PAT of the bot's own GitHub account: scopes notifications + public_repo
#   CONTEXT_SECRET   seals each thread's context snapshot and signs job tokens; keep it stable
#                    across deploys (a new one = every thread starts a fresh Codex session).
#                    Generated when unset.
#   CODEX_AUTH_FILE  the bot's device login (default ~/.botlite-codex/auth.json)
#
# Every credential becomes a BoxLite secret: the controller sees only placeholders, which the
# platform swaps for the real values on the way to GitHub, BoxLite, chatgpt.com, auth.openai.com.
# Optional: BOT_LOGIN (botlite) VOLUME (botlite-context) CODEX_MODEL BOTLITE_REF (main)
#           BOXLITE_URL (https://api.boxlite.ai)
set -euo pipefail

API="${BOXLITE_URL:-https://api.boxlite.ai}"
BOT="${BOT_LOGIN:-botlite}"
VOLUME="${VOLUME:-botlite-context}"
REF="${BOTLITE_REF:-main}"
AUTH_FILE="${CODEX_AUTH_FILE:-$HOME/.botlite-codex/auth.json}"
NAME=botlite-controller
PORT=8788
: "${BOXLITE_API_KEY:?set BOXLITE_API_KEY}" "${GITHUB_TOKEN:?set GITHUB_TOKEN (classic PAT of the bot account)}"
export BOXLITE_API_KEY GITHUB_TOKEN
command -v jq >/dev/null || { echo "✘ jq is required" >&2; exit 1; }
die() { echo "✘ $*" >&2; exit 1; }

# curl with its auth header fed through a pipe (printf is a builtin: no argv); stdin stays free
# for a request body. Prints the response body, then the status code on the last line.
authed() { local token=$1; shift; curl -sS --config <(printf 'header = "Authorization: Bearer %s"\n' "$token") -w '\n%{http_code}' "$@"; }
bl() { local method=$1 path=$2; shift 2; authed "$BOXLITE_API_KEY" -X "$method" -H 'Content-Type: application/json' "$API$path" "$@"; }
status() { tail -n1 <<<"$1"; }
body() { sed '$d' <<<"$1"; }

echo "→ The bot's ChatGPT login ($AUTH_FILE)…"
[ -f "$AUTH_FILE" ] || die "no login there — run: CODEX_HOME=$(dirname "$AUTH_FILE") codex login --device-auth -c cli_auth_credentials_store='\"file\"'"
CHATGPT_ACCESS_TOKEN=$(jq -r '.tokens.access_token // empty' "$AUTH_FILE")
CHATGPT_REFRESH_TOKEN=$(jq -r '.tokens.refresh_token // empty' "$AUTH_FILE")
CHATGPT_ACCOUNT_ID=$(jq -r '.tokens.account_id // empty' "$AUTH_FILE")
CHATGPT_LAST_REFRESH=$(jq -r '.last_refresh // empty' "$AUTH_FILE")
[ -n "$CHATGPT_ACCESS_TOKEN" ] && [ -n "$CHATGPT_REFRESH_TOKEN" ] && [ -n "$CHATGPT_ACCOUNT_ID" ] || die "$AUTH_FILE is not a ChatGPT (device) login"
export CHATGPT_ACCESS_TOKEN CHATGPT_REFRESH_TOKEN
echo "  account $CHATGPT_ACCOUNT_ID · last refreshed ${CHATGPT_LAST_REFRESH:-unknown}"

echo "→ Checking the bot's GitHub token…"
HDRS=$(mktemp); trap 'rm -f "$HDRS"' EXIT
res=$(authed "$GITHUB_TOKEN" -D "$HDRS" https://api.github.com/user)
[ "$(status "$res")" = 200 ] || die "GitHub rejected GITHUB_TOKEN ($(status "$res"))"
login=$(body "$res" | jq -r .login)
scopes=$(grep -i '^x-oauth-scopes:' "$HDRS" | cut -d: -f2- | tr -d '\r' || true)
[ "$(tr '[:upper:]' '[:lower:]' <<<"$login")" = "$(tr '[:upper:]' '[:lower:]' <<<"$BOT")" ] || echo "  ⚠ token belongs to @$login, not @$BOT — mentions of @$BOT won't reach it"
grep -Eq '(^|[ ,])(notifications|repo)(,|$)' <<<"$scopes" || die "token lacks the notifications scope (has:$scopes) — use a classic PAT"
grep -Eq '(^|[ ,])(public_repo|repo)(,|$)' <<<"$scopes" || die "token lacks the public_repo scope (has:$scopes)"
echo "  @$login ·$scopes"

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

if [ -z "${CONTEXT_SECRET:-}" ]; then
  CONTEXT_SECRET=$(openssl rand -base64 32)
  echo "  ⚠ generated CONTEXT_SECRET — save it and pass it on every redeploy, or threads lose their context:"
  echo "    CONTEXT_SECRET=$CONTEXT_SECRET"
fi
export CONTEXT_SECRET

echo "→ Controller box \"$NAME\"…"
if [ "$(status "$(bl GET "/v1/boxes/$NAME")")" = 200 ]; then
  echo "  replacing the running controller"
  bl DELETE "/v1/boxes/$NAME?force=true" >/dev/null
  for _ in $(seq 1 30); do [ "$(status "$(bl GET "/v1/boxes/$NAME")")" = 404 ] && break; sleep 2; done
fi

# The controller's program: fetch this repo, then run it forever (nothing else restarts a box).
BOOT='set -u
cd "$HOME"
[ -d botlite/.git ] || git clone --quiet --depth 1 --branch "$BOTLITE_REF" https://github.com/boxlite-ai/boxlite-github-agent.git botlite
export STATE_FILE="${STATE_FILE:-$HOME/.botlite/state.json}"
# BoxLite swaps secrets in by intercepting HTTPS with a CA it adds to the system bundle; Node only
# trusts its own bundle unless told (without this: SELF_SIGNED_CERT_IN_CHAIN on every call).
export NODE_EXTRA_CA_CERTS=/etc/ssl/certs/ca-certificates.crt
has_ws() { "$@" -e "process.exit(typeof WebSocket === \"function\" ? 0 : 1)" 2>/dev/null; }
if has_ws node; then NODE=(node)
elif has_ws node --experimental-websocket; then NODE=(node --experimental-websocket)
else npm install -g --silent --prefix "$HOME/.node22" node@22 && NODE=("$HOME/.node22/bin/node"); fi
while true; do "${NODE[@]}" botlite/src/main.mjs; echo "controller exited ($?), restarting in 10s" >&2; sleep 10; done'

# Public inbound: session boxes reach the controller's model proxy over its preview URL (every
# request needs a live job token; everything else there is a 404).
jq -n --arg name "$NAME" --arg bot "$BOT" --arg volume "$VOLUME" --arg ref "$REF" --arg model "${CODEX_MODEL:-}" \
  --arg account "$CHATGPT_ACCOUNT_ID" --arg refreshed "$CHATGPT_LAST_REFRESH" --arg port "$PORT" --arg boot "$BOOT" '{
    name: $name, image: "node", cpus: 1, memory_mib: 1024,
    network: {outbound: {mode: "enabled"}, inbound: {mode: "enabled"}},
    auto_stop: 0,
    env: ({BOT_LOGIN: $bot, VOLUME: $volume, BOTLITE_REF: $ref, PORT: $port, CONTEXT_SECRET: $ENV.CONTEXT_SECRET,
           CHATGPT_ACCOUNT_ID: $account}
          + (if $refreshed == "" then {} else {CHATGPT_LAST_REFRESH: $refreshed} end)
          + (if $model == "" then {} else {CODEX_MODEL: $model} end)),
    secrets: [
      {name: "github", value: $ENV.GITHUB_TOKEN, hosts: ["api.github.com"]},
      {name: "boxlite", value: $ENV.BOXLITE_API_KEY, hosts: ["api.boxlite.ai"]},
      {name: "chatgpt_access", value: $ENV.CHATGPT_ACCESS_TOKEN, hosts: ["chatgpt.com"]},
      {name: "chatgpt_refresh", value: $ENV.CHATGPT_REFRESH_TOKEN, hosts: ["auth.openai.com"]}
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
for _ in $(seq 1 24); do
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
  echo "✅ @$BOT is live. Mention @$BOT in any public issue or PR — it answers within a minute or two."
  echo "   The controller now owns this ChatGPT login: after its first refresh (~weekly) the copy in"
  echo "   $AUTH_FILE stops working — expected. For a later redeploy, log in again first."
else
  echo "⚠ The controller box exists but isn't confirmed running yet — check \"$NAME\" in the BoxLite dashboard."
fi
