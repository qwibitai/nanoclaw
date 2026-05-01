# channels-remote.sh — resolve the git remote that carries the `channels`
# branch. Source this file and call `resolve_channels_remote`; echoes the
# remote name (e.g. `origin` or `upstream`).
#
# Typical fork setups keep the upstream nanoclaw repo under a remote named
# `upstream`, with `origin` pointing at the user's fork. The channels branch
# only lives upstream, so a hardcoded `git fetch origin channels` fails for
# forks. This helper walks `git remote -v`, picks the remote whose URL points
# at qwibitai/nanoclaw, and prints its name.
#
# Fallback: if no existing remote matches, add `upstream` pointing at
# github.com/qwibitai/nanoclaw and return that — keeps forks without an
# explicit upstream configured working on the first try.
#
# Explicit override: set NANOCLAW_CHANNELS_REMOTE=<name> to skip detection.
# The named remote must still point at a trusted canonical URL.

# Returns 0 if the URL is a canonical qwibitai/nanoclaw remote, 1 otherwise.
# Accepts HTTPS and SSH forms, with or without trailing .git.
_is_trusted_nanoclaw_url() {
  local url="$1"
  case "$url" in
    https://github.com/qwibitai/nanoclaw.git) return 0 ;;
    https://github.com/qwibitai/nanoclaw)     return 0 ;;
    git@github.com:qwibitai/nanoclaw.git)     return 0 ;;
    git@github.com:qwibitai/nanoclaw)         return 0 ;;
    *)                                         return 1 ;;
  esac
}

resolve_channels_remote() {
  if [ -n "${NANOCLAW_CHANNELS_REMOTE:-}" ]; then
    local override_url
    override_url=$(git remote get-url "$NANOCLAW_CHANNELS_REMOTE" 2>/dev/null || true)
    if [ -z "$override_url" ]; then
      echo "channels-remote: NANOCLAW_CHANNELS_REMOTE='${NANOCLAW_CHANNELS_REMOTE}' is not a known remote" >&2
      return 1
    fi
    if ! _is_trusted_nanoclaw_url "$override_url"; then
      echo "channels-remote: remote '${NANOCLAW_CHANNELS_REMOTE}' URL '${override_url}' is not a trusted qwibitai/nanoclaw URL" >&2
      return 1
    fi
    printf '%s' "$NANOCLAW_CHANNELS_REMOTE"
    return 0
  fi

  local remote url
  while IFS=$'\t' read -r remote url; do
    if _is_trusted_nanoclaw_url "$url"; then
      printf '%s' "$remote"
      return 0
    fi
  done < <(git remote -v 2>/dev/null | awk '$3 == "(fetch)" { print $1"\t"$2 }')

  # No matching remote — add `upstream` and use it. Silent on failure so
  # callers see the eventual `git fetch` error rather than a cryptic
  # remote-add failure.
  git remote add upstream https://github.com/qwibitai/nanoclaw.git 2>/dev/null || true
  printf '%s' "upstream"
}
