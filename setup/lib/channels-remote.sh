# channels-remote.sh — resolve the trusted git remote that carries the
# `channels` branch. Source this file and call `resolve_channels_remote`;
# it echoes the remote name (e.g. `origin` or `upstream`).
#
# Typical fork setups keep the upstream nanoclaw repo under a remote named
# `upstream`, with `origin` pointing at the user's fork. The channels branch
# only lives upstream, so a hardcoded `git fetch origin channels` fails for
# forks. This helper walks `git remote -v`, picks the remote whose URL points
# exactly at the canonical qwibitai/nanoclaw repository, and prints its name.
#
# Fallback: if no existing trusted remote matches, add `upstream` pointing at
# github.com/qwibitai/nanoclaw and return that — keeps forks without an
# explicit upstream configured working on the first try.
#
# Explicit override: set NANOCLAW_CHANNELS_REMOTE=<name> to select a remote by
# name. The override still must be a safe remote name and must point at the
# canonical qwibitai/nanoclaw repository before callers fetch executable
# adapter code from its `channels` branch.

NANOCLAW_CHANNELS_CANONICAL_URL="https://github.com/qwibitai/nanoclaw.git"

is_safe_channels_remote_name() {
  local remote=$1
  [[ "$remote" =~ ^[A-Za-z0-9][A-Za-z0-9._-]*$ ]]
}

is_trusted_channels_remote_url() {
  local url=${1%.git}
  case "$url" in
    https://github.com/qwibitai/nanoclaw|ssh://git@github.com/qwibitai/nanoclaw)
      return 0
      ;;
    git@github.com:qwibitai/nanoclaw)
      return 0
      ;;
    *)
      return 1
      ;;
  esac
}

channels_remote_url() {
  git remote get-url "$1" 2>/dev/null || true
}

validate_channels_remote() {
  local remote=$1
  local url

  if ! is_safe_channels_remote_name "$remote"; then
    echo "Refusing unsafe channels remote name: $remote" >&2
    return 1
  fi

  url=$(channels_remote_url "$remote")
  if [ -z "$url" ]; then
    echo "Channels remote '$remote' does not exist" >&2
    return 1
  fi

  if ! is_trusted_channels_remote_url "$url"; then
    echo "Refusing channels remote '$remote' with untrusted URL: $url" >&2
    echo "Expected the canonical qwibitai/nanoclaw repository." >&2
    return 1
  fi

  return 0
}

resolve_channels_remote() {
  if [ -n "${NANOCLAW_CHANNELS_REMOTE:-}" ]; then
    validate_channels_remote "$NANOCLAW_CHANNELS_REMOTE" || return 1
    printf '%s' "$NANOCLAW_CHANNELS_REMOTE"
    return 0
  fi

  local remote url
  while IFS=$'\t' read -r remote url; do
    if is_safe_channels_remote_name "$remote" && is_trusted_channels_remote_url "$url"; then
      printf '%s' "$remote"
      return 0
    fi
  done < <(git remote -v 2>/dev/null | awk '$3 == "(fetch)" { print $1"\t"$2 }')

  # No matching remote — add `upstream` and use it. If an existing `upstream`
  # remote points somewhere else, fail closed instead of fetching executable
  # channel adapter code from an attacker-controlled repository.
  if git remote get-url upstream >/dev/null 2>&1; then
    validate_channels_remote upstream || return 1
    printf '%s' "upstream"
    return 0
  fi

  git remote add upstream "$NANOCLAW_CHANNELS_CANONICAL_URL" || return 1
  validate_channels_remote upstream || return 1
  printf '%s' "upstream"
}
