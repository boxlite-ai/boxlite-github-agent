#!/bin/sh
# The controller checkout's post-merge hook: the gate between the boot loop's `git pull` and the
# new build starting. git runs it after every pull that moved the checkout, and a pull never
# changes it (hooks aren't tracked) — so it still works when a deploy breaks the launcher itself,
# which src/main.mjs's own rollback can't survive. Installed by deploy.sh and `ctl hook`.
#
# A build must parse, pass the launcher's test and start (offline). If the pulled one doesn't, the
# gate walks back through what the pull brought, newest first, and stays on the newest commit that
# passes, or on the build it had if none does, with the reason left for the controller to report
# (rollback.json). The branch stays checked out, so the next pull tries again: fixing main is enough.
cd "$(git rev-parse --show-toplevel)" || exit 0
# The tests run git in repos of their own and answer by exit code: nothing inherited may point them
# back at this repo, or make a failing one exit 0 (an outer test runner's NODE_TEST_CONTEXT does).
unset $(git rev-parse --local-env-vars) NODE_TEST_CONTEXT
state="${STATE_FILE:-$HOME/.botlite/state.json}"
state="${state%/*}"
new="$(git rev-parse HEAD)"
old="$(git rev-parse ORIG_HEAD)"

# Does the checked-out build pass? If not, $failed says what didn't.
check() {
  failed=""
  for f in src/*.mjs box/*.mjs deploy/*.mjs; do
    [ -f "$f" ] || continue
    node --check "$f" 2>/dev/null || failed="$failed $f"
  done
  [ -n "$failed" ] && return 1
  for t in test/launcher.test.mjs test/start.test.mjs; do
    [ -f "$t" ] || continue
    node --test "$t" >/dev/null 2>&1 || failed="$failed $t"
  done
  [ -z "$failed" ]
}
check && exit 0
why="${failed# }"
mkdir -p "$state"

# Hand edits in the checkout would go with the resets below: keep them next to the state.
if ! git diff --quiet HEAD; then
  saved="$state/gate-$(date -u +%Y%m%dT%H%M%SZ).patch"
  git diff HEAD > "$saved"
  echo "$(date -u +%FT%TZ) gate: saved local changes to $saved"
fi

to="$old"
for c in $(git rev-list --first-parent --max-count=20 "$old..$new" | sed 1d); do
  git reset --quiet --hard "$c"
  if check; then to="$c"; break; fi
done
git reset --quiet --hard "$to"
echo "$(date -u +%FT%TZ) gate: ${new%"${new#???????}"} failed its pre-start check ($why) — running ${to%"${to#???????}"}"
node -e 'const [file, from, to, why] = process.argv.slice(1)
require("fs").writeFileSync(file, JSON.stringify({ from, to, at: new Date().toISOString(), by: "gate", why: `failed its pre-start check (${why})` }) + "\n")' "$state/rollback.json" "$new" "$to" "$why"
