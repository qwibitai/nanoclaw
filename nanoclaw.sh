#!/usr/bin/env bash
#
# NanoClaw — end-to-end setup entry point.
#
# Runs two parts from the user's perspective as one continuous flow:
#   - bash-side: install the basics (Node + pnpm + native modules) under a
#     bash-rendered clack-alike spinner. Can't use setup/auto.ts here since
#     tsx isn't available until pnpm install completes.
#   - hand off to `pnpm run setup:auto`, which renders the rest with
#     @clack/prompts. The wordmark is printed once here so setup:auto can
#     skip it and the flow reads as a single sequence.
#
# Obeys the three-level output contract (see docs/setup-flow.md):
#   1. User-facing       — concise status line with elapsed time
#   2. Progression log   — logs/setup.log (header + one entry per step)
#   3. Raw per-step log  — logs/setup-steps/NN-name.log (full verbatim output)
#
# Config via env — passed through unchanged:
#   NANOCLAW_SKIP  comma-separated setup:auto step names to skip
#   SECRET_NAME    OneCLI secret name (default: Anthropic)
#   HOST_PATTERN   OneCLI host pattern (default: api.anthropic.com)

set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$PROJECT_ROOT"

LOGS_DIR="$PROJECT_ROOT/logs"
STEPS_DIR="$LOGS_DIR/setup-steps"
PROGRESS_LOG="$LOGS_DIR/setup.log"

# Diagnostics: persisted install-id + fire-and-forget emit. Sourced early
# so `setup_launched` covers dropoff before bootstrap even starts.
# shellcheck source=setup/lib/diagnostics.sh
source "$PROJECT_ROOT/setup/lib/diagnostics.sh"
ph_event setup_launched \
  platform="$(uname -s | tr 'A-Z' 'a-z')" \
  is_wsl="$([ -f /proc/version ] && grep -qi 'microsoft\|wsl' /proc/version 2>/dev/null && echo true || echo false)"

# ─── log helpers ────────────────────────────────────────────────────────

ts_utc() { date -u +%Y-%m-%dT%H:%M:%SZ; }

write_header() {
  local ts
  ts=$(ts_utc)
  local branch commit
  branch=$(git branch --show-current 2>/dev/null || echo unknown)
  commit=$(git rev-parse --short HEAD 2>/dev/null || echo unknown)
  {
    echo "## ${ts} · setup:auto started"
    echo "  invocation: nanoclaw.sh"
    echo "  user: $(whoami)"
    echo "  cwd: ${PROJECT_ROOT}"
    echo "  branch: ${branch}"
    echo "  commit: ${commit}"
    echo ""
  } > "$PROGRESS_LOG"
}

# grep_field FIELD FILE — first value of FIELD: from a status block.
grep_field() {
  grep "^$1:" "$2" 2>/dev/null | head -1 | sed "s/^$1: *//" || true
}

write_bootstrap_entry() {
  local status=$1 dur=$2 raw=$3
  local ts
  ts=$(ts_utc)
  local platform is_wsl node_version deps_ok native_ok has_build_tools
  platform=$(grep_field PLATFORM "$raw")
  is_wsl=$(grep_field IS_WSL "$raw")
  node_version=$(grep_field NODE_VERSION "$raw" | head -1)
  deps_ok=$(grep_field DEPS_OK "$raw")
  native_ok=$(grep_field NATIVE_OK "$raw")
  has_build_tools=$(grep_field HAS_BUILD_TOOLS "$raw")
  {
    echo "=== [${ts}] bootstrap [${dur}s] → ${status} ==="
    [ -n "$platform" ]        && echo "  platform: ${platform}"
    [ -n "$is_wsl" ]          && echo "  is_wsl: ${is_wsl}"
    [ -n "$node_version" ]    && echo "  node_version: ${node_version}"
    [ -n "$deps_ok" ]         && echo "  deps_ok: ${deps_ok}"
    [ -n "$native_ok" ]       && echo "  native_ok: ${native_ok}"
    [ -n "$has_build_tools" ] && echo "  has_build_tools: ${has_build_tools}"
    # Emit the raw path relative to PROJECT_ROOT so the progression log
     # is portable and matches the TS-side format (logs/setup-steps/NN-…).
    echo "  raw: ${raw#${PROJECT_ROOT}/}"
    echo ""
  } >> "$PROGRESS_LOG"
}

write_abort_entry() {
  local step=$1 error=$2
  local ts
  ts=$(ts_utc)
  echo "## ${ts} · aborted at ${step} (${error})" >> "$PROGRESS_LOG"
}

# ─── bash-side "clack-alike" status line ────────────────────────────────

use_ansi() { [ -t 1 ] && [ -z "${NO_COLOR:-}" ]; }
dim()     { use_ansi && printf '\033[2m%s\033[0m' "$1" || printf '%s' "$1"; }
gray()    { use_ansi && printf '\033[90m%s\033[0m' "$1" || printf '%s' "$1"; }
red()     { use_ansi && printf '\033[31m%s\033[0m' "$1" || printf '%s' "$1"; }
bold()    { use_ansi && printf '\033[1m%s\033[0m' "$1" || printf '%s' "$1"; }
# brand cyan (≈ #2BB7CE) — truecolor when supported, 16-color cyan fallback.
brand_bold() {
  if use_ansi; then
    if [ "${COLORTERM:-}" = "truecolor" ] || [ "${COLORTERM:-}" = "24bit" ]; then
      printf '\033[1;38;2;43;183;206m%s\033[0m' "$1"
    else
      printf '\033[1;36m%s\033[0m' "$1"
    fi
  else
    printf '%s' "$1"
  fi
}
clear_line() { use_ansi && printf '\r\033[2K' || printf '\n'; }

spinner_start()   { printf '%s  %s…' "$(gray '◒')" "$1"; }
spinner_update()  { clear_line; printf '%s  %s… %s' "$(gray '◒')" "$1" "$(dim "(${2}s)")"; }
spinner_success() { clear_line; printf '%s  %s %s\n' "$(gray '◇')" "$1" "$(dim "(${2}s)")"; }
spinner_failure() { clear_line; printf '%s  %s %s\n' "$(red '✗')"  "$1" "$(dim "(${2}s)")"; }

# ─── fresh-run setup ────────────────────────────────────────────────────

rm -rf "$STEPS_DIR"
rm -f  "$PROGRESS_LOG"
mkdir -p "$STEPS_DIR" "$LOGS_DIR"
write_header

# NanoClaw wordmark — clack's intro carries the "let's get you set up" framing,
# so we don't print a subtitle here. setup:auto sees NANOCLAW_BOOTSTRAPPED=1 and
# skips re-printing the wordmark, keeping the flow visually continuous.
printf '\n  %s%s\n\n' "$(bold 'Nano')" "$(brand_bold 'Claw')"

# ─── pre-flight: Homebrew on macOS ─────────────────────────────────────
# setup/install-node.sh and setup/install-docker.sh both require `brew` on
# macOS. On a factory Mac there's no brew, and those helpers would fail
# later inside the bootstrap spinner with a cryptic error. Prompt here,
# before the spinner starts, so the user knows what's about to happen and
# brew's own interactive sudo/CLT prompts stay readable.
if [ "$(uname -s)" = "Darwin" ] && ! command -v brew >/dev/null 2>&1; then
  printf '  %s\n' \
    "$(dim "Homebrew isn't installed. NanoClaw uses it to install Node and Docker on your Mac.")"
  printf '  %s\n\n' \
    "$(dim "This also installs Apple's Command Line Tools, which can take 5-10 minutes.")"
  read -r -p "  $(bold 'Install Homebrew now?') [Y/n] " BREW_ANS </dev/tty

  case "${BREW_ANS:-Y}" in
    [Yy]*|'')
      printf '\n'
      # Official installer. Runs interactively, triggers xcode-select --install
      # for Command Line Tools, and prompts for the user's password for sudo.
      # `|| true` so a user-cancelled install doesn't kill us via `set -e`;
      # the PATH check below is the real gate.
      /bin/bash -c \
        "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)" \
        || true

      # Put brew on PATH for this session (the installer writes to
      # .zprofile/.bash_profile for future shells, but not this one).
      if [ -x /opt/homebrew/bin/brew ]; then
        eval "$(/opt/homebrew/bin/brew shellenv)"
      elif [ -x /usr/local/bin/brew ]; then
        eval "$(/usr/local/bin/brew shellenv)"
      fi

      if ! command -v brew >/dev/null 2>&1; then
        printf '\n  %s %s\n' "$(red '✗')" "Homebrew install didn't complete."
        printf '  %s\n\n' \
          "$(dim 'Install manually from https://brew.sh and re-run: bash nanoclaw.sh')"
        exit 1
      fi
      printf '\n'
      ;;
    *)
      printf '\n  %s\n\n' \
        "$(dim 'NanoClaw needs Homebrew. Install it from https://brew.sh and re-run.')"
      exit 1
      ;;
  esac
fi

# ─── first step: install the basics (Node + pnpm + native modules) ─────

BOOTSTRAP_RAW="${STEPS_DIR}/01-bootstrap.log"
BOOTSTRAP_LABEL="Installing the basics"
BOOTSTRAP_START=$(date +%s)

# One-line "why" that teaches a differentiator while the user waits.
printf '%s  %s\n' "$(gray '│')" \
  "$(dim "Small. Runs on your machine. Yours to modify.")"
spinner_start "$BOOTSTRAP_LABEL"

# Run in the background so we can tick elapsed time. Capture exit code via
# a tmpfile (subshell $? is lost after the while loop finishes).
BOOTSTRAP_EXIT_FILE=$(mktemp -t nanoclaw-bootstrap-exit.XXXXXX)
(
  # setup.sh's legacy `log()` writes to a file; point it at the raw log
  # so its verbose entries land alongside the stdout we're capturing.
  export NANOCLAW_BOOTSTRAP_LOG="$BOOTSTRAP_RAW"
  if bash setup.sh > "$BOOTSTRAP_RAW" 2>&1; then
    echo 0 > "$BOOTSTRAP_EXIT_FILE"
  else
    echo $? > "$BOOTSTRAP_EXIT_FILE"
  fi
) &
BOOTSTRAP_PID=$!

while kill -0 "$BOOTSTRAP_PID" 2>/dev/null; do
  sleep 1
  if kill -0 "$BOOTSTRAP_PID" 2>/dev/null; then
    spinner_update "$BOOTSTRAP_LABEL" "$(( $(date +%s) - BOOTSTRAP_START ))"
  fi
done
# `wait` surfaces the child's exit code; we've already captured it.
wait "$BOOTSTRAP_PID" 2>/dev/null || true

BOOTSTRAP_RC=$(cat "$BOOTSTRAP_EXIT_FILE")
rm -f "$BOOTSTRAP_EXIT_FILE"
BOOTSTRAP_DUR=$(( $(date +%s) - BOOTSTRAP_START ))

if [ "$BOOTSTRAP_RC" -eq 0 ]; then
  spinner_success "Basics ready" "$BOOTSTRAP_DUR"
  write_bootstrap_entry success "$BOOTSTRAP_DUR" "$BOOTSTRAP_RAW"
else
  spinner_failure "Couldn't install the basics" "$BOOTSTRAP_DUR"
  write_bootstrap_entry failed "$BOOTSTRAP_DUR" "$BOOTSTRAP_RAW"
  write_abort_entry bootstrap "exit-${BOOTSTRAP_RC}"

  echo
  echo "$(dim '── last 40 lines of ')$(dim "$BOOTSTRAP_RAW")$(dim ' ──')"
  tail -40 "$BOOTSTRAP_RAW"
  echo
  echo "$(dim "Full raw log: $BOOTSTRAP_RAW")"
  echo "$(dim "Progression:  $PROGRESS_LOG")"
  exit 1
fi

# ─── hand off to setup:auto ────────────────────────────────────────────

# NANOCLAW_BOOTSTRAPPED=1 tells setup/auto.ts to skip the wordmark (we
# already printed it) and to append to the progression log rather than
# wipe it.
export NANOCLAW_BOOTSTRAPPED=1

# setup.sh may have just installed pnpm via npm into a prefix that's not on
# our PATH (custom `npm config set prefix`, or the default prefix missing
# from the shell's login PATH). Its PATH mutation doesn't propagate back
# to us — so replay the same lookup here before the exec.
if ! command -v pnpm >/dev/null 2>&1 && command -v npm >/dev/null 2>&1; then
  NPM_PREFIX="$(npm config get prefix 2>/dev/null)"
  if [ -n "$NPM_PREFIX" ] && [ -x "$NPM_PREFIX/bin/pnpm" ]; then
    export PATH="$NPM_PREFIX/bin:$PATH"
  fi
fi

# --silent suppresses pnpm's `> nanoclaw@2.0.0 setup:auto / > tsx setup/auto.ts`
# preamble so the flow continues visually from "Basics installed" straight
# into setup:auto's spinner. exec so signals (Ctrl-C) propagate directly.
# `-- "$@"` forwards any flags (e.g. --onecli-api-host) to setup:auto.
exec pnpm --silent run setup:auto -- "$@"
