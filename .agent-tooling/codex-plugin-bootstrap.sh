#!/usr/bin/env bash
# Trusted Codex SessionStart bootstrap for a consumer repository.
#
# The committed consumer installer adopts and validates shared tooling first. Codex
# then registers one canonical Git marketplace for the whole machine and installs the
# plugin once. A canonical source is essential: local clone paths conflict because
# Codex keys configured marketplaces globally by their manifest name.
set -euo pipefail

repo_root="$(git rev-parse --show-toplevel 2>/dev/null || true)"
[[ -n "$repo_root" ]] || { printf 'agent-tooling: run inside a Git repository\n' >&2; exit 2; }
profile_file="$repo_root/.agent-tooling/profile.json"
installer="$repo_root/.agent-tooling/install.sh"
marketplace_file="$repo_root/.agents/plugins/marketplace.json"
[[ -r "$profile_file" ]] || { printf 'agent-tooling: missing %s\n' "$profile_file" >&2; exit 1; }
[[ -r "$installer" ]] || { printf 'agent-tooling: missing %s\n' "$installer" >&2; exit 1; }
[[ -r "$marketplace_file" ]] || { printf 'agent-tooling: missing %s\n' "$marketplace_file" >&2; exit 1; }
command -v jq >/dev/null 2>&1 || { printf 'agent-tooling: jq is required\n' >&2; exit 1; }
command -v codex >/dev/null 2>&1 || { printf 'agent-tooling: Codex CLI is required\n' >&2; exit 1; }

tooling_repo="$(jq -er '.tooling.repository | select(type == "string" and length > 0)' "$profile_file")" || {
  printf 'agent-tooling: tooling.repository is required\n' >&2
  exit 1
}
[[ "$tooling_repo" == "boxlite-ai/agent-tooling" ]] || {
  printf 'agent-tooling: unsupported tooling repository: %s\n' "$tooling_repo" >&2
  exit 1
}
tooling_ref="$(jq -er '.tooling.ref | select(type == "string" and length > 0)' "$profile_file")" || {
  printf 'agent-tooling: tooling.ref must name the branch to float on\n' >&2
  exit 1
}
[[ ! "$tooling_ref" =~ ^[0-9a-f]{40}$ ]] || {
  printf 'agent-tooling: tooling.ref names a branch; to freeze a revision write it to .agent-tooling/hold\n' >&2
  exit 1
}
if [[ "$tooling_ref" == -* ]] || ! git check-ref-format "refs/heads/$tooling_ref" >/dev/null 2>&1; then
  printf 'agent-tooling: tooling.ref is not a valid branch name: %s\n' "$tooling_ref" >&2
  exit 1
fi

validate_codex_marketplace_file() {
  local file="$1"
  [[ -r "$file" ]] || return 1
  jq -e --arg ref "$tooling_ref" '
    .name == "boxlite-agent-tooling" and
    any(.plugins[];
      .name == "boxlite-agent-tooling" and
      .source.source == "git-subdir" and
      .source.url == "https://github.com/boxlite-ai/agent-tooling.git" and
      .source.ref == $ref and
      .source.path == "./plugins/boxlite-agent-tooling" and
      .policy.installation == "INSTALLED_BY_DEFAULT" and
      .policy.authentication == "ON_INSTALL" and
      .category == "Developer Tools")
  ' "$file" >/dev/null 2>&1
}

validate_codex_marketplace_file "$marketplace_file" || {
  printf 'agent-tooling: invalid Codex marketplace for tooling.ref %s: %s\n' "$tooling_ref" "$marketplace_file" >&2
  exit 1
}

tooling_install_is_valid() {
  local common_git_dir record verify
  common_git_dir="$(git -C "$repo_root" rev-parse --git-common-dir)"
  [[ "$common_git_dir" == /* ]] || common_git_dir="$repo_root/$common_git_dir"
  record="$(head -n1 "$common_git_dir/agent-tooling/current" 2>/dev/null || true)"
  [[ "$record" =~ ^[0-9a-f]{40}$ ]] || return 1
  verify="$common_git_dir/agent-tooling/$record/plugins/boxlite-agent-tooling/scripts/verify-installation.sh"
  [[ -x "$verify" ]] || return 1
  "$verify" "$repo_root" >/dev/null
}

if ! tooling_install_is_valid 2>/dev/null; then
  install_output=""
  if install_output="$(cd "$repo_root" && AGENT_TOOLING_SYNC_ACTIVE=1 /usr/bin/env bash "$installer" 2>&1)"; then
    :
  else
    status="$?"
    [[ -z "$install_output" ]] || printf '%s\n' "$install_output" >&2
    printf 'agent-tooling: automatic tooling installation failed\n' >&2
    exit "$status"
  fi
  tooling_install_is_valid || {
    [[ -z "$install_output" ]] || printf '%s\n' "$install_output" >&2
    printf 'agent-tooling: automatic tooling installation did not produce a valid local installation\n' >&2
    exit 1
  }
fi

common_git_dir="$(git -C "$repo_root" rev-parse --git-common-dir)"
[[ "$common_git_dir" == /* ]] || common_git_dir="$repo_root/$common_git_dir"
read_expected_plugin_version() {
  adopted_tooling_revision="$(head -n1 "$common_git_dir/agent-tooling/current" 2>/dev/null || true)"
  [[ "$adopted_tooling_revision" =~ ^[0-9a-f]{40}$ ]] || {
    printf 'agent-tooling: adopted tooling revision is invalid after verification\n' >&2
    return 1
  }
  expected_plugin_manifest="$common_git_dir/agent-tooling/$adopted_tooling_revision/plugins/boxlite-agent-tooling/.codex-plugin/plugin.json"
  expected_plugin_version="$(jq -er '
    select(.name == "boxlite-agent-tooling") |
    .version | select(type == "string" and length > 0)
  ' "$expected_plugin_manifest" 2>/dev/null)" || {
    printf 'agent-tooling: adopted tooling has no valid Codex plugin version: %s\n' \
      "$expected_plugin_manifest" >&2
    return 1
  }
}

refresh_adopted_tooling() {
  local output status
  output="$(cd "$repo_root" && AGENT_TOOLING_SYNC_ACTIVE=1 /usr/bin/env bash "$installer" 2>&1)"
  status="$?"
  if [[ "$status" != 0 ]]; then
    [[ -z "$output" ]] || printf '%s\n' "$output" >&2
    printf 'agent-tooling: could not refresh adopted tooling before plugin reconciliation\n' >&2
    return "$status"
  fi
  tooling_install_is_valid || {
    [[ -z "$output" ]] || printf '%s\n' "$output" >&2
    printf 'agent-tooling: tooling refresh did not produce a valid local installation\n' >&2
    return 1
  }
  read_expected_plugin_version
}

read_expected_plugin_version || exit 1

hold_file="$repo_root/.agent-tooling/hold"
hold_sha=""
if [[ -e "$hold_file" ]]; then
  hold_sha="$(tr -d '\n' < "$hold_file")"
  { [[ "$hold_sha" =~ ^[0-9a-f]{40}$ ]] && [[ "$(wc -c < "$hold_file")" -le 41 ]]; } || {
    printf 'agent-tooling: %s must contain exactly one full lowercase commit SHA\n' "$hold_file" >&2
    exit 1
  }
  [[ "$hold_sha" == "$adopted_tooling_revision" ]] || {
    printf 'agent-tooling: hold %s is not the adopted tooling revision %s\n' \
      "$hold_sha" "$adopted_tooling_revision" >&2
    exit 1
  }
fi
