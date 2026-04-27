#!/bin/bash
# restart.sh — bash bridge to setup/lib/restart.ts.
#
# Source this from any add-<channel>.sh after $PROJECT_ROOT is set, then call
# `restart_service`. The TS implementation reads logs/setup.log to figure out
# whether this install used launchd / systemd / nohup, issues the right
# restart command, and waits for data/cli.sock to come back online before
# returning.
#
# Returns 0 on success, non-zero otherwise. The TS side prints a one-line
# `mode=<m> ok=<bool>[ reason=<r>]` summary on stderr for diagnostics.
#
# Why a bridge instead of duplicating the dispatch logic in bash: the case
# statement here used to silently swallow errors with `|| true` on every
# script, which masked the entire bug class this fix addresses. One impl
# means one place to get this right.

restart_service() {
  local root="${PROJECT_ROOT:-$PWD}"
  local tsx_bin="$root/node_modules/.bin/tsx"
  if [ ! -x "$tsx_bin" ]; then
    echo "restart_service: tsx not found at $tsx_bin" >&2
    return 1
  fi
  ( cd "$root" && "$tsx_bin" setup/lib/restart.ts )
}
