#!/bin/bash
# Setup step: probe — single upfront parallel-ish scan that snapshots every
# prerequisite and dependency for /new-setup's dynamic context injection.
# Rendered into the SKILL.md prompt via `!bash setup/probe.sh` so Claude sees
# the current system state before generating its first response.
#
# Pure bash by design: this runs BEFORE setup.sh has installed Node, pnpm, and
# node_modules, so it cannot rely on any Node-based tooling. Every field below
# is computed from POSIX utilities + grep/awk/curl.
#
# This is a routing aid, NOT a replacement for per-step idempotency checks.
# Each step keeps its own checks; probe tells the skill which steps to skip.
#
# Keep fast (<2s total). All probes swallow their own errors and report a
# neutral state rather than failing the whole scan.
set -u

START_S=$(date +%s)

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOCAL_BIN="$HOME/.local/bin"

# Per-checkout install names (match setup/lib/install-slug.ts).
# shellcheck source=setup/lib/install-slug.sh
source "$PROJECT_ROOT/setup/lib/install-slug.sh"
LAUNCHD_LABEL=$(launchd_label)
SYSTEMD_UNIT=$(systemd_unit)
AGENT_IMAGE="$(container_image_base):latest"

export PATH="$LOCAL_BIN:$PATH"

command_exists() { command -v "$1" >/dev/null 2>&1; }

# Best-effort 2s timeout; falls back to no timeout on macOS if `timeout` isn't
# installed (the probed commands are all expected to return fast anyway).
with_timeout() {
  if command_exists timeout; then timeout 2 "$@"
  elif command_exists gtimeout; then gtimeout 2 "$@"
  else "$@"
  fi
}

trim() {
  local s="$1"
  s="${s#"${s%%[![:space:]]*}"}"
  s="${s%"${s##*[![:space:]]}"}"
  printf '%s' "$s"
}

read_env_var() {
  local name="$1"
  local envfile="$PROJECT_ROOT/.env"
  [[ -f "$envfile" ]] || return 0
  local line
  line=$(grep -E "^${name}=" "$envfile" 2>/dev/null | head -n1) || return 0
  [[ -z "$line" ]] && return 0
  local val="${line#*=}"
  val="${val%\"}"; val="${val#\"}"
  val="${val%\'}"; val="${val#\'}"
  trim "$val"
}

probe_os() {
  case "$(uname -s 2>/dev/null)" in
    Darwin) echo "macos" ;;
    Linux)
      if [[ -r /proc/version ]] && grep -qEi "microsoft|wsl" /proc/version; then
        echo "wsl"
      else
        echo "linux"
      fi
      ;;
    *) echo "unknown" ;;
  esac
}

probe_host_deps() {
  local node_modules="$PROJECT_ROOT/node_modules"
  local native="$node_modules/better-sqlite3/build/Release/better_sqlite3.node"
  # `better-sqlite3`'s compiled native binding is the canonical proof that
  # `pnpm install` ran AND the native build step succeeded.
  if [[ -d "$node_modules" && -f "$native" ]]; then
    echo "ok"
  else
    echo "missing"
  fi
}

# Sets DOCKER_STATUS and IMAGE_PRESENT as globals.
probe_docker() {
  DOCKER_STATUS="not_found"
  IMAGE_PRESENT="false"
  command_exists docker || return 0
  if ! with_timeout docker info >/dev/null 2>&1; then
    DOCKER_STATUS="installed_not_running"
    return 0
  fi
  DOCKER_STATUS="running"
  if with_timeout docker image inspect "$AGENT_IMAGE" >/dev/null 2>&1; then
    IMAGE_PRESENT="true"
  fi
}

probe_onecli_url() {
  local url
  url=$(read_env_var ONECLI_URL)
  if [[ -n "$url" ]]; then
    printf '%s' "$url"
    return
  fi
  command_exists onecli || return 0
  local out
  out=$(with_timeout onecli config get api-host 2>/dev/null) || return 0
  # Minimal JSON extract: {"value":"http..."} — avoid hard dep on jq
  if [[ "$out" =~ \"value\"[[:space:]]*:[[:space:]]*\"([^\"]+)\" ]]; then
    printf '%s' "${BASH_REMATCH[1]}"
  fi
}

probe_onecli_status() {
  local url="$1"
  if ! command_exists onecli && [[ ! -x "$LOCAL_BIN/onecli" ]]; then
    echo "not_found"; return
  fi
  if [[ -z "$url" ]]; then
    echo "installed_not_healthy"; return
  fi
  if command_exists curl \
     && curl -fsS --max-time 2 "${url}/api/health" >/dev/null 2>&1; then
    echo "healthy"
  else
    echo "installed_not_healthy"
  fi
}

probe_anthropic_secret() {
  command_exists onecli || { echo "false"; return; }
  local out
  out=$(with_timeout onecli secrets list 2>/dev/null) || { echo "false"; return; }
  if echo "$out" | grep -Eq '"type"[[:space:]]*:[[:space:]]*"anthropic"'; then
    echo "true"
  else
    echo "false"
  fi
}

probe_service_status() {
  local platform="$1"
  case "$platform" in
    macos)
      command_exists launchctl || { echo "not_configured"; return; }
      local line
      line=$(with_timeout launchctl list 2>/dev/null | grep "$LAUNCHD_LABEL") || {
        echo "not_configured"; return; }
      local pid
      pid=$(echo "$line" | awk '{print $1}')
      if [[ -n "$pid" && "$pid" != "-" ]]; then
        echo "running"
      else
        echo "stopped"
      fi
      ;;
    linux|wsl)
      command_exists systemctl || { echo "not_configured"; return; }
      if with_timeout systemctl --user is-active "$SYSTEMD_UNIT" >/dev/null 2>&1; then
        echo "running"
      elif with_timeout systemctl --user cat nanoclaw >/dev/null 2>&1; then
        echo "stopped"
      else
        echo "not_configured"
      fi
      ;;
    *)
      echo "not_configured"
      ;;
  esac
}

probe_display_name() {
  local platform="$1"
  local reject_re='^(|root)$'
  local name

  if command_exists git; then
    name=$(trim "$(git config --global user.name 2>/dev/null)")
    if [[ -n "$name" && ! "$name" =~ $reject_re ]]; then
      printf '%s' "$name"; return
    fi
  fi

  local user="${USER:-$(id -un 2>/dev/null)}"

  case "$platform" in
    macos)
      if command_exists id; then
        name=$(trim "$(id -F "$user" 2>/dev/null)")
        if [[ -n "$name" && ! "$name" =~ $reject_re ]]; then
          printf '%s' "$name"; return
        fi
      fi
      ;;
    linux|wsl)
      if command_exists getent; then
        local entry gecos
        entry=$(getent passwd "$user" 2>/dev/null)
        gecos=$(echo "$entry" | awk -F: '{print $5}')
        name=$(trim "$(echo "$gecos" | awk -F, '{print $1}')")
        if [[ -n "$name" && ! "$name" =~ $reject_re ]]; then
          printf '%s' "$name"; return
        fi
      fi
      ;;
  esac

  if [[ -n "$user" && ! "$user" =~ $reject_re ]]; then
    printf '%s' "$user"
  else
    printf 'User'
  fi
}

OS=$(probe_os)
SHELL_NAME="${SHELL:-unknown}"
HOST_DEPS=$(probe_host_deps)
probe_docker
ONECLI_URL_VAL=$(probe_onecli_url)
ONECLI_STATUS=$(probe_onecli_status "$ONECLI_URL_VAL")
if [[ "$ONECLI_STATUS" == "not_found" ]]; then
  ANTHROPIC_SECRET="false"
else
  ANTHROPIC_SECRET=$(probe_anthropic_secret)
fi
SERVICE_STATUS=$(probe_service_status "$OS")
DISPLAY_NAME=$(probe_display_name "$OS")

END_S=$(date +%s)
ELAPSED_MS=$(( (END_S - START_S) * 1000 ))

cat <<EOF
=== NANOCLAW SETUP: PROBE ===
OS: ${OS}
SHELL: ${SHELL_NAME}
HOST_DEPS: ${HOST_DEPS}
DOCKER: ${DOCKER_STATUS}
IMAGE_PRESENT: ${IMAGE_PRESENT}
ONECLI_STATUS: ${ONECLI_STATUS}
ONECLI_URL: ${ONECLI_URL_VAL:-none}
ANTHROPIC_SECRET: ${ANTHROPIC_SECRET}
SERVICE_STATUS: ${SERVICE_STATUS}
INFERRED_DISPLAY_NAME: ${DISPLAY_NAME}
ELAPSED_MS: ${ELAPSED_MS}
STATUS: success
=== END ===
EOF
