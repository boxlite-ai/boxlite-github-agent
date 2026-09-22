#!/bin/sh
# The controller checkout's post-merge hook: the gate between the boot loop's `git pull` and the
# new build starting. git runs it after every pull that moved the checkout, and a pull never
# changes it (hooks aren't tracked) — so it still works when a deploy breaks the launcher itself,
# which src/main.mjs's own rollback can't survive. Installed by deploy.sh and `ctl hook`.
#
# The new build must parse and pass the launcher's test; if not, the pull is undone and the boot
# loop starts the build it had, on the same branch, with the reason left for the controller to
# report (rollback.json). The next pull tries again, so fixing main is enough.
cd "$(git rev-parse --show-toplevel)" || exit 0
state="${STATE_FILE:-$HOME/.botlite/state.json}"
state="${state%/*}"
new="$(git rev-parse HEAD)"
old="$(git rev-parse ORIG_HEAD)"
failed=""
for f in src/*.mjs box/*.mjs deploy/*.mjs; do
  [ -f "$f" ] || continue
  node --check "$f" 2>/dev/null || failed="$failed $f"
done
if [ -z "$failed" ] && [ -f test/launcher.test.mjs ]; then
  node --test test/launcher.test.mjs >/dev/null 2>&1 || failed=" test/launcher.test.mjs"
fi
[ -z "$failed" ] && exit 0

echo "$(date -u +%FT%TZ) gate: ${new%"${new#???????}"} failed:$failed — staying on ${old%"${old#???????}"}"
git reset --quiet --hard "$old"
mkdir -p "$state"
printf '{"from":"%s","to":"%s","at":"%s","why":"failed its pre-start check (%s)"}\n' "$new" "$old" "$(date -u +%FT%TZ)" "${failed# }" > "$state/rollback.json"
