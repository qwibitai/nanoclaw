#!/usr/bin/env bash
# Install and configure OneCLI for NanoClaw.
#
# Idempotent: safe to re-run. Detects existing install and skips work.
# Non-destructive: never overwrites existing .env values without warning.
#
# Phases:
#   1. Install OneCLI gateway + CLI binary if missing
#   2. Detect the reachable gateway URL (loopback or Docker bridge)
#   3. Persist ONECLI_URL in .env
#   4. If ONECLI_API_KEY available (env or .env), run `onecli auth login`
#   5. If no API key, print bootstrap instructions and exit cleanly
#
# Optional env vars:
#   ONECLI_PORT          gateway port (default: 10254)
#   ONECLI_SCHEME        http | https (default: http). Set https when
#                        the gateway is fronted by TLS in production.
#   ONECLI_INSECURE_TLS  0 | 1 (default: 0). Pair with ONECLI_SCHEME=https
#                        on self-signed deployments to skip cert verification.
#                        Production-CA installs leave this at 0 so curl
#                        stays strict.
#   HEALTH_TIMEOUT       seconds to wait for /api/health (default: 30)
#   ENV_FILE             where to persist ONECLI_URL (default: ./.env)
#
# Exit codes:
#   0 = OneCLI installed; auth complete OR awaiting manual API key step
#   1 = install failed (network, missing curl, etc.)
#   2 = gateway did not become healthy after install
#   3 = required prerequisite missing (curl, write access)

set -euo pipefail

ONECLI_PORT="${ONECLI_PORT:-10254}"
# Scheme used when assembling candidate gateway URLs. Defaults to `http`
# for back-compat with local-dev / loopback installations. Set to
# `https` for production deployments where the gateway is fronted by
# TLS. Anything else exits with a config error.
ONECLI_SCHEME="${ONECLI_SCHEME:-http}"
# When ONECLI_SCHEME=https and the gateway is using a self-signed cert
# (typical for a private deployment), set ONECLI_INSECURE_TLS=1 so the
# health probe + onecli config don't reject the cert. Off by default
# so production-CA setups stay strict.
ONECLI_INSECURE_TLS="${ONECLI_INSECURE_TLS:-0}"
HEALTH_TIMEOUT="${HEALTH_TIMEOUT:-30}"
ENV_FILE="${ENV_FILE:-$(pwd)/.env}"

case "$ONECLI_SCHEME" in
  http|https) ;;
  *) printf '[install-onecli] FAIL: ONECLI_SCHEME must be "http" or "https" (got %q)\n' "$ONECLI_SCHEME" >&2; exit 3 ;;
esac

# Curl flags shared by every probe + auth call. -k is gated by the
# explicit opt-in env var so an https deployment with a real cert
# behaves strictly.
CURL_TLS_FLAGS=()
if [ "$ONECLI_SCHEME" = "https" ] && [ "$ONECLI_INSECURE_TLS" = "1" ]; then
  CURL_TLS_FLAGS+=("-k")
fi

# OneCLI compose lives at $HOME/.onecli/ by default (root install -> /root/.onecli/).
# Its env_file directive loads $HOME/.env one level up (used at container runtime
# for vars like GATEWAY_SKIP_VERIFY_HOSTS that the gateway process reads).
# A separate $HOME/.onecli/.env is used by docker-compose for parse-time
# variable substitution (e.g. ${ONECLI_BIND_HOST}, ${ONECLI_MTU}).
ONECLI_HOME_DIR="${ONECLI_HOME_DIR:-$HOME/.onecli}"
ONECLI_COMPOSE="${ONECLI_COMPOSE:-$ONECLI_HOME_DIR/docker-compose.yml}"
ONECLI_HOME_ENV="${ONECLI_HOME_ENV:-$HOME/.env}"
ONECLI_COMPOSE_ENV="${ONECLI_COMPOSE_ENV:-$ONECLI_HOME_DIR/.env}"

log()  { printf '[install-onecli] %s\n' "$*"; }
warn() { printf '[install-onecli] WARN: %s\n' "$*" >&2; }
fail() { printf '[install-onecli] FAIL: %s\n' "$*" >&2; exit "${2:-1}"; }

# --- Phase 0: prerequisites ---

command -v curl >/dev/null || fail "curl not in PATH — install curl first" 3
command -v sh   >/dev/null || fail "sh not in PATH"                        3

# Add ~/.local/bin to PATH for the rest of this script (CLI installs there on some systems)
export PATH="$HOME/.local/bin:$PATH"

# --- Phase 1: install gateway + CLI if missing ---

ALREADY_INSTALLED=0
if command -v onecli >/dev/null 2>&1; then
  log "OneCLI binary present: $(command -v onecli)"
  ALREADY_INSTALLED=1
else
  log "installing OneCLI gateway..."
  curl -fsSL onecli.sh/install | sh || fail "gateway install failed" 1

  log "installing OneCLI CLI..."
  curl -fsSL onecli.sh/cli/install | sh || fail "CLI install failed" 1

  # Re-export PATH in case installer just dropped binary in ~/.local/bin
  export PATH="$HOME/.local/bin:$PATH"
  command -v onecli >/dev/null 2>&1 || fail "onecli still not in PATH after install" 1
fi

# --- Phase 2: persist ~/.local/bin in shell rc files (only if CLI lives there) ---

if [ -x "$HOME/.local/bin/onecli" ]; then
  for rc in "$HOME/.bashrc" "$HOME/.zshrc"; do
    [ -f "$rc" ] || continue
    if ! grep -q '\.local/bin' "$rc" 2>/dev/null; then
      log "adding ~/.local/bin to PATH in $rc"
      printf '\n# Added by nanoclaw install-onecli.sh\nexport PATH="$HOME/.local/bin:$PATH"\n' >> "$rc"
    fi
  done
fi

# --- Phase 2.5: configure OneCLI compose for Linux Docker (bind host + MTU) ---
#
# OneCLI's compose file uses ${ONECLI_BIND_HOST:-127.0.0.1} for port mapping
# and creates a user-defined bridge network whose default MTU is 1500. On
# Linux + Docker, two adjustments are needed for the gateway to be reachable
# from sibling containers AND for upstream TLS handshakes to complete:
#
#   ONECLI_BIND_HOST=<docker0 bridge IP>  -> ports reachable from sibling
#                                            containers (not just loopback)
#   com.docker.network.driver.mtu=1450    -> matches typical cloud VM MTU,
#                                            avoids fragmented MITM packets
#
# We write these to $HOME/.onecli/.env (the compose-dir env file used for
# parse-time substitution) and patch the compose YAML to add the MTU
# driver_opts block if it's not already present. Skipped on macOS (no
# docker0 interface and no MTU issue with Desktop's vmnet).

ONECLI_RESTART_NEEDED=0

if [ -d /sys/class/net/docker0 ]; then
  BRIDGE_IP=$(ip -4 addr show docker0 2>/dev/null | awk '/inet /{print $2}' | cut -d/ -f1 | head -1)

  # Detect host MTU from default route's interface; fall back to 1450 (safe)
  DEFAULT_IFACE=$(ip route show default 2>/dev/null | awk '/default/{for(i=1;i<=NF;i++)if($i=="dev"){print $(i+1);exit}}')
  HOST_MTU=$(cat /sys/class/net/"${DEFAULT_IFACE:-eth0}"/mtu 2>/dev/null || echo 1450)
  TARGET_MTU="${ONECLI_MTU:-$HOST_MTU}"

  if [ -n "$BRIDGE_IP" ] && [ -d "$ONECLI_HOME_DIR" ]; then
    [ -f "$ONECLI_COMPOSE_ENV" ] || touch "$ONECLI_COMPOSE_ENV" 2>/dev/null

    # Helper: idempotent set in a .env file
    set_env_kv() {
      local file=$1 key=$2 value=$3
      if grep -qE "^${key}=" "$file" 2>/dev/null; then
        local cur
        cur=$(grep -E "^${key}=" "$file" | head -1 | cut -d= -f2- | tr -d '"' | tr -d "'")
        if [ "$cur" != "$value" ]; then
          sed -i "s|^${key}=.*|${key}=${value}|" "$file"
          log "  $key: $cur -> $value"
          return 0
        fi
        return 1
      else
        printf '%s=%s\n' "$key" "$value" >> "$file"
        log "  $key=$value (added)"
        return 0
      fi
    }

    log "configuring OneCLI compose-dir env: $ONECLI_COMPOSE_ENV"
    if set_env_kv "$ONECLI_COMPOSE_ENV" ONECLI_BIND_HOST "$BRIDGE_IP"; then ONECLI_RESTART_NEEDED=1; fi
    if set_env_kv "$ONECLI_COMPOSE_ENV" ONECLI_MTU "$TARGET_MTU"; then ONECLI_RESTART_NEEDED=1; fi

    # Patch compose YAML to add MTU driver_opts under the onecli network if missing.
    # Targets the trailing block:
    #   networks:
    #     onecli:
    #       driver: bridge
    if [ -f "$ONECLI_COMPOSE" ]; then
      if ! grep -qE 'com\.docker\.network\.driver\.mtu' "$ONECLI_COMPOSE"; then
        log "patching $ONECLI_COMPOSE to add MTU driver_opts"
        cp -p "$ONECLI_COMPOSE" "${ONECLI_COMPOSE}.bak.$(date +%Y%m%d-%H%M%S)"
        # Append driver_opts after `driver: bridge` line in the onecli network block.
        # Conservative: only modify if the exact pattern matches.
        sed -i '/^networks:$/,$ {
          /^  onecli:$/,/^[^ ]/ {
            /^    driver: bridge$/a\
    driver_opts:\
      com.docker.network.driver.mtu: "${ONECLI_MTU:-1450}"
          }
        }' "$ONECLI_COMPOSE"
        ONECLI_RESTART_NEEDED=1
      else
        log "compose already has MTU driver_opts"
      fi
    fi
  fi
fi

if [ "$ONECLI_RESTART_NEEDED" -eq 1 ] && [ -f "$ONECLI_COMPOSE" ]; then
  log "recreating OneCLI containers + network to apply config..."
  if docker compose -p onecli -f "$ONECLI_COMPOSE" down >/dev/null 2>&1 \
     && docker compose -p onecli -f "$ONECLI_COMPOSE" up -d >/dev/null 2>&1; then
    log "OneCLI recreated"
    sleep 5  # give containers a moment to come up before health check
  else
    warn "OneCLI recreate failed — try manually:"
    warn "  docker compose -p onecli -f $ONECLI_COMPOSE down"
    warn "  docker compose -p onecli -f $ONECLI_COMPOSE up -d"
  fi
fi

# --- Phase 3: detect reachable gateway URL ---

# Build candidate list. Docker-bridge IP first when present (new containerized
# OneCLI binds to docker0 by default on Linux).
CANDIDATES=()
if [ -d /sys/class/net/docker0 ]; then
  BRIDGE_IP=$(ip -4 addr show docker0 2>/dev/null | awk '/inet /{print $2}' | cut -d/ -f1 | head -1)
  [ -n "${BRIDGE_IP:-}" ] && CANDIDATES+=("${ONECLI_SCHEME}://${BRIDGE_IP}:${ONECLI_PORT}")
fi
CANDIDATES+=("${ONECLI_SCHEME}://127.0.0.1:${ONECLI_PORT}")
CANDIDATES+=("${ONECLI_SCHEME}://localhost:${ONECLI_PORT}")

probe_health() {
  # OneCLI 1.5+ uses /api/health; fall back to /health for older versions.
  curl -sf "${CURL_TLS_FLAGS[@]}" -m 2 "${1}/api/health" >/dev/null 2>&1 || \
    curl -sf "${CURL_TLS_FLAGS[@]}" -m 2 "${1}/health" >/dev/null 2>&1
}

log "probing gateway candidates: ${CANDIDATES[*]}"
ONECLI_URL=""
for i in $(seq 1 "$HEALTH_TIMEOUT"); do
  for u in "${CANDIDATES[@]}"; do
    if probe_health "$u"; then
      ONECLI_URL="$u"
      break 2
    fi
  done
  sleep 1
done

if [ -z "$ONECLI_URL" ]; then
  warn "no reachable gateway found on any of: ${CANDIDATES[*]}"
  warn "check: docker ps | grep onecli"
  warn "check: ps aux | grep -i onecli | grep -v grep"
  exit 2
fi

log "gateway healthy at $ONECLI_URL"

# --- Phase 4: configure CLI to point at this URL ---

log "configuring CLI: api-host = $ONECLI_URL"
onecli config set api-host "$ONECLI_URL" >/dev/null 2>&1 || \
  warn "onecli config set api-host failed (may not be needed in this CLI version)"

# --- Phase 5: persist ONECLI_URL in .env ---

if [ -f "$ENV_FILE" ]; then
  if grep -qE '^ONECLI_URL=' "$ENV_FILE"; then
    CURRENT=$(grep -E '^ONECLI_URL=' "$ENV_FILE" | head -1 | cut -d= -f2- | tr -d '"' | tr -d "'")
    if [ "$CURRENT" != "$ONECLI_URL" ]; then
      warn "ONECLI_URL in $ENV_FILE is '$CURRENT' (detected '$ONECLI_URL') — leaving as-is"
      warn "to switch, edit $ENV_FILE manually"
    else
      log "ONECLI_URL already set in $ENV_FILE"
    fi
  else
    log "appending ONECLI_URL=$ONECLI_URL to $ENV_FILE"
    printf '\n# OneCLI gateway URL — added by install-onecli.sh\nONECLI_URL=%s\n' "$ONECLI_URL" >> "$ENV_FILE"
  fi
else
  warn "$ENV_FILE not found — skipping .env update (run from your nanoclaw install dir)"
fi

# --- Phase 6: ensure per-group agents exist ---
#
# Each NanoClaw group needs its own OneCLI agent identity (per the
# docs: https://www.onecli.sh/docs/guides/nanoclaw). The 'main' group
# uses OneCLI's default agent and does not need an explicit agent.
#
# Detects groups from the groups/ directory and creates a OneCLI agent
# for each one whose identifier is missing. Idempotent.

GROUPS_DIR="${GROUPS_DIR:-$(pwd)/groups}"
DETECTED_GROUPS=()
if [ -d "$GROUPS_DIR" ]; then
  while IFS= read -r g; do
    base=$(basename "$g")
    case "$base" in
      .*|main) continue ;;  # skip hidden + main (uses default agent)
      *) DETECTED_GROUPS+=("$base") ;;
    esac
  done < <(find "$GROUPS_DIR" -mindepth 1 -maxdepth 1 -type d 2>/dev/null | sort)
fi

# Allow override via AGENTS env var (comma-separated identifiers)
if [ -n "${AGENTS:-}" ]; then
  IFS=',' read -ra DETECTED_GROUPS <<< "$AGENTS"
fi

# Default: at least create 'copilot' if no groups detected (covers fresh installs)
if [ "${#DETECTED_GROUPS[@]}" -eq 0 ]; then
  log "no groups detected in $GROUPS_DIR — defaulting to 'copilot'"
  DETECTED_GROUPS=("copilot")
fi

log "ensuring OneCLI agents for groups: ${DETECTED_GROUPS[*]}"

# Helper: get JSON via HTTP API (no auth needed in single-user mode).
# Inherits CURL_TLS_FLAGS so https + insecure-tls flows through here too.
api_get() {
  curl -sf "${CURL_TLS_FLAGS[@]}" -m 5 "${ONECLI_URL}$1" 2>/dev/null
}
api_post() {
  curl -sf "${CURL_TLS_FLAGS[@]}" -m 5 -X POST -H 'Content-Type: application/json' \
    -d "$2" "${ONECLI_URL}$1" 2>/dev/null
}

# Helper: extract a JSON field for an agent by identifier (uses python3)
agent_field() {
  local list_json=$1 identifier=$2 field=$3
  printf '%s' "$list_json" | python3 -c "
import sys, json
data = json.load(sys.stdin)
if isinstance(data, dict): data = data.get('data', [])
for a in data:
  if a.get('identifier') == '$identifier':
    print(a.get('$field', ''))
    break
" 2>/dev/null
}

command -v python3 >/dev/null || fail "python3 required for agent JSON parsing — apt install python3" 3

AGENTS_JSON=$(api_get /api/agents) || fail "could not list agents from $ONECLI_URL/api/agents" 1

PRIMARY_TOKEN=""
for ident in "${DETECTED_GROUPS[@]}"; do
  EXISTING_TOKEN=$(agent_field "$AGENTS_JSON" "$ident" accessToken)
  if [ -n "$EXISTING_TOKEN" ]; then
    log "agent '$ident' already exists"
  else
    # Build a CamelCase display name from identifier
    DISPLAY_NAME=$(printf '%s' "$ident" | sed -E 's/(^|-)([a-z])/\U\2/g')
    log "creating agent '$ident' (display: $DISPLAY_NAME)"
    if api_post /api/agents "{\"name\":\"$DISPLAY_NAME\",\"identifier\":\"$ident\"}" >/dev/null; then
      AGENTS_JSON=$(api_get /api/agents)
      EXISTING_TOKEN=$(agent_field "$AGENTS_JSON" "$ident" accessToken)
    else
      warn "failed to create agent '$ident' — skipping"
      continue
    fi
  fi
  # Capture first valid token as the SDK's primary token
  if [ -z "$PRIMARY_TOKEN" ] && [ -n "$EXISTING_TOKEN" ]; then
    PRIMARY_TOKEN="$EXISTING_TOKEN"
    PRIMARY_AGENT="$ident"
  fi
done

# --- Phase 7: API key persistence + auth login ---

# Prefer explicit env override, then existing .env, then primary agent token
ONECLI_API_KEY="${ONECLI_API_KEY:-}"
if [ -z "$ONECLI_API_KEY" ] && [ -f "$ENV_FILE" ]; then
  ONECLI_API_KEY=$(grep -E '^ONECLI_API_KEY=' "$ENV_FILE" 2>/dev/null | head -1 | cut -d= -f2- | tr -d '"' | tr -d "'" || true)
fi
if [ -z "$ONECLI_API_KEY" ] && [ -n "$PRIMARY_TOKEN" ]; then
  log "using agent '$PRIMARY_AGENT' access token as ONECLI_API_KEY"
  ONECLI_API_KEY="$PRIMARY_TOKEN"
fi

if [ -n "$ONECLI_API_KEY" ]; then
  if onecli auth login --api-key "$ONECLI_API_KEY" >/dev/null 2>&1; then
    log "CLI auth login succeeded"
  else
    warn "auth login failed — single-user mode may not require it; continuing"
  fi

  if [ -f "$ENV_FILE" ]; then
    if grep -qE '^ONECLI_API_KEY=' "$ENV_FILE"; then
      CURRENT_KEY=$(grep -E '^ONECLI_API_KEY=' "$ENV_FILE" | head -1 | cut -d= -f2- | tr -d '"' | tr -d "'")
      if [ "$CURRENT_KEY" != "$ONECLI_API_KEY" ]; then
        warn "ONECLI_API_KEY in $ENV_FILE differs from current — leaving as-is"
      else
        log "ONECLI_API_KEY already set in $ENV_FILE"
      fi
    else
      log "appending ONECLI_API_KEY to $ENV_FILE"
      printf 'ONECLI_API_KEY=%s\n' "$ONECLI_API_KEY" >> "$ENV_FILE"
    fi
  fi

  AUTH_STATUS="configured"
else
  AUTH_STATUS="no agents created — manual setup needed"
fi

# --- Phase 7: configure GATEWAY_SKIP_VERIFY_HOSTS for self-signed internal hosts ---
#
# OneCLI's TLS MITM verifies upstream certs. Internal services (OpenSearch,
# Wazuh, Velociraptor) typically use self-signed certs and would otherwise
# fail with "serving MITM connection" errors.
#
# We auto-detect by scanning every */.env in the install dir for a
# VERIFY_CERTS=false / SSL_VERIFY=false / VERIFY_SSL=false flag, then
# extracting the host from any URL/HOST/HOSTS variable in the same file.
# The result is written to OneCLI's env_file ($HOME/.env) which the
# compose stack loads automatically.

detect_skip_hosts() {
  local hosts=""
  for envfile in "$(pwd)"/*/.env; do
    [ -f "$envfile" ] || continue
    if grep -qiE '^[A-Z_]*(VERIFY_CERTS?|SSL_VERIFY|VERIFY_SSL)=(false|0|no)' "$envfile" 2>/dev/null; then
      while IFS= read -r line; do
        h=$(printf '%s' "$line" | sed -E 's#^[A-Z_]+=##; s#^["'"'"']##; s#["'"'"']$##; s#^https?://##; s#[:/].*##')
        [ -n "$h" ] && hosts="${hosts}${h},"
      done < <(grep -E '^[A-Z_]+(URL|HOSTS?)=https?://' "$envfile" 2>/dev/null)
    fi
  done
  printf '%s' "$hosts" | tr ',' '\n' | grep -v '^$' | sort -u | tr '\n' ',' | sed 's/,$//'
}

if [ -n "${SKIP_VERIFY_HOSTS:-}" ]; then
  HOSTS_LIST="$SKIP_VERIFY_HOSTS"
  log "using SKIP_VERIFY_HOSTS override: $HOSTS_LIST"
else
  HOSTS_LIST=$(detect_skip_hosts)
  if [ -n "$HOSTS_LIST" ]; then
    log "auto-detected self-signed internal hosts: $HOSTS_LIST"
  fi
fi

if [ -n "$HOSTS_LIST" ]; then
  if [ ! -f "$ONECLI_HOME_ENV" ]; then
    log "creating $ONECLI_HOME_ENV (OneCLI's env_file)"
    touch "$ONECLI_HOME_ENV" 2>/dev/null || warn "could not create $ONECLI_HOME_ENV"
  fi

  RESTART_NEEDED=0
  if [ -f "$ONECLI_HOME_ENV" ]; then
    if grep -qE '^GATEWAY_SKIP_VERIFY_HOSTS=' "$ONECLI_HOME_ENV"; then
      CURRENT=$(grep -E '^GATEWAY_SKIP_VERIFY_HOSTS=' "$ONECLI_HOME_ENV" | head -1 | cut -d= -f2- | tr -d '"' | tr -d "'")
      if [ "$CURRENT" = "$HOSTS_LIST" ]; then
        log "GATEWAY_SKIP_VERIFY_HOSTS already configured: $CURRENT"
      else
        log "updating GATEWAY_SKIP_VERIFY_HOSTS in $ONECLI_HOME_ENV"
        log "  was: $CURRENT"
        log "  now: $HOSTS_LIST"
        sed -i "s|^GATEWAY_SKIP_VERIFY_HOSTS=.*|GATEWAY_SKIP_VERIFY_HOSTS=$HOSTS_LIST|" "$ONECLI_HOME_ENV"
        RESTART_NEEDED=1
      fi
    else
      log "appending GATEWAY_SKIP_VERIFY_HOSTS=$HOSTS_LIST to $ONECLI_HOME_ENV"
      printf '\n# OneCLI: skip TLS verification for self-signed internal hosts\nGATEWAY_SKIP_VERIFY_HOSTS=%s\n' "$HOSTS_LIST" >> "$ONECLI_HOME_ENV"
      RESTART_NEEDED=1
    fi

    if [ "$RESTART_NEEDED" -eq 1 ]; then
      if [ -f "$ONECLI_COMPOSE" ]; then
        log "restarting OneCLI to pick up new gateway env config..."
        if docker compose -p onecli -f "$ONECLI_COMPOSE" up -d >/dev/null 2>&1; then
          log "OneCLI restarted"
          # Re-poll health since restart drops the gateway briefly
          for _ in $(seq 1 10); do
            probe_health "$ONECLI_URL" && break
            sleep 1
          done
        else
          warn "docker compose restart failed — restart manually:"
          warn "  docker compose -p onecli -f $ONECLI_COMPOSE up -d"
        fi
      else
        warn "OneCLI compose file not found at $ONECLI_COMPOSE — restart OneCLI manually"
      fi
    fi
  fi
fi

# --- Phase 8: report ---

echo
log "DONE."
log "  Gateway:        $ONECLI_URL (healthy)"
log "  CLI version:    $(onecli version 2>/dev/null | grep -oE '"version"[^,]*' | head -1 | tr -d '"' | sed 's/version://;s/[ ]//g' || echo unknown)"
log "  Already done:   $([ "$ALREADY_INSTALLED" -eq 1 ] && echo yes || echo no)"
log "  Auth status:    $AUTH_STATUS"
log "  Agents:         ${DETECTED_GROUPS[*]:-(none)}"
log "  Skip-verify:    ${HOSTS_LIST:-(none detected)}"
echo

if [ "$AUTH_STATUS" = "no agents created — manual setup needed" ]; then
  cat <<EOF
NEXT STEP — manual agent creation needed.

The script could not auto-create any agents. This usually means OneCLI
is in multi-user mode (NEXTAUTH_SECRET is set) and requires browser
signup before the API can be used.

  1. Open the dashboard:
       ssh -L 10254:$(echo "$ONECLI_URL" | sed -E 's#https?://##') root@<this-host>
       then open: ${ONECLI_SCHEME}://localhost:10254

  2. Sign in (Google OAuth if configured) and create an agent.
  3. Copy the agent access token and re-run:
       ONECLI_API_KEY=<token> bash scripts/install-onecli.sh

  REFERENCE: https://www.onecli.sh/docs/guides/nanoclaw

EOF
  exit 0
fi

cat <<EOF
NEXT STEP — register your Anthropic credential:

  Run the next script:
    bash scripts/migrate-anthropic-to-vault.sh

  Or manually:
    onecli secrets create --name Anthropic --type anthropic \\
      --value <your-token> --host-pattern api.anthropic.com

EOF
