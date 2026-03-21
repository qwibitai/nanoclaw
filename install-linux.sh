#!/usr/bin/env bash
# install-linux.sh — One-liner NanoClaw installer for Linux
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/heyjawrsh/shpshft/main/install-linux.sh | bash
#
# What this does:
#   1. Checks OS / arch (x86_64 and aarch64 supported)
#   2. Installs Docker CE if missing
#   3. Pulls the NanoClaw Linux session container from ghcr.io
#   4. Clones nanoclaw to ~/nanoclaw-<suffix>
#   5. Creates an isolated Docker bridge network with iptables filtering
#      (allows DNS, HTTPS/HTTP, and whitelisted IPs; blocks everything else)
#   6. Launches a Claude Code session — type /setup when it starts
#
# Network filtering uses the same bypass-host model as Docker Sandboxes on macOS/Windows,
# implemented via ipset + iptables DOCKER-USER chain rules. Rules are removed on exit.

set -euo pipefail

# ── Configuration ─────────────────────────────────────────────────────────────

REPO_URL="https://github.com/qwibitai/nanoclaw.git"
IMAGE="ghcr.io/heyjawrsh/nanoclaw-linux:latest"
SUFFIX=$(date +%s | tail -c 5)
WORKSPACE="${HOME}/nanoclaw-${SUFFIX}"
CONTAINER_NAME="nanoclaw-session-${SUFFIX}"
NETWORK_NAME="nanoclaw-net-${SUFFIX}"
IPSET_NAME="nanoclaw-${SUFFIX}"

# Runtime state
DOCKER="docker"
NETWORK_CREATED=false
IPTABLES_ACTIVE=false

# Outbound hosts explicitly whitelisted by IP at session start.
# All port 443/80 is also allowed as a CDN fallback (covers npm, package
# registries, and any CDN-backed service not resolvable to stable IPs).
BYPASS_HOSTS=(
  # Claude / Anthropic
  "api.anthropic.com"
  # Telegram
  "api.telegram.org"
  "web.telegram.org"
  # WhatsApp
  "web.whatsapp.com"
  "v.whatsapp.net"
  "e.whatsapp.net"
  # Discord
  "discord.com"
  "gateway.discord.gg"
  "cdn.discordapp.com"
  # Slack
  "slack.com"
  "api.slack.com"
  # npm
  "registry.npmjs.org"
  # GitHub (needed for skill branch merges in /setup)
  "github.com"
  "api.github.com"
  "objects.githubusercontent.com"
  "raw.githubusercontent.com"
  # ghcr.io (container image pulls)
  "ghcr.io"
  "pkg.github.com"
)

# ── Output helpers ─────────────────────────────────────────────────────────────

step() { echo; echo "==> $*"; }
info() { echo "    $*"; }
warn() { echo "    [!] $*" >&2; }
die()  { echo; echo "ERROR: $*" >&2; exit 1; }

# ── Cleanup (trap EXIT) ────────────────────────────────────────────────────────

cleanup() {
  # Remove iptables rules tagged with our session ID (highest line number first
  # to avoid renumbering issues)
  if [[ "$IPTABLES_ACTIVE" == "true" ]]; then
    echo
    echo "Cleaning up network rules..."
    while true; do
      local line
      line=$(sudo iptables -L DOCKER-USER --line-numbers -n 2>/dev/null \
             | awk -v tag="nanoclaw-${SUFFIX}" '$0 ~ tag {print $1}' \
             | tail -1)
      [[ -z "$line" ]] && break
      sudo iptables -D DOCKER-USER "$line" 2>/dev/null || break
    done
    sudo ipset destroy "$IPSET_NAME" 2>/dev/null || true
  fi

  if [[ "$NETWORK_CREATED" == "true" ]]; then
    $DOCKER network rm "$NETWORK_NAME" 2>/dev/null || true
  fi
}

trap cleanup EXIT

# ── Step 1: OS and architecture check ─────────────────────────────────────────

check_os() {
  step "Checking environment"

  [[ "$(uname -s)" == "Linux" ]] || die "This installer is for Linux only."

  case "$(uname -m)" in
    x86_64)  info "Architecture: x86_64 (amd64)" ;;
    aarch64) info "Architecture: aarch64 (arm64)" ;;
    *)       die "Unsupported architecture: $(uname -m). Only x86_64 and aarch64 are supported." ;;
  esac

  # Verify sudo access up front so later steps don't block mid-install
  if ! sudo -n true 2>/dev/null; then
    info "sudo is required for Docker and iptables setup."
    sudo true || die "sudo access is required to continue."
  fi
}

# ── Step 2: Docker CE ─────────────────────────────────────────────────────────

install_docker() {
  step "Checking Docker"

  # Already accessible without sudo
  if command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
    info "Docker $(docker --version | awk '{print $3}' | tr -d ,) is running"
    DOCKER="docker"
    return
  fi

  # Installed but group not yet active in this session — use sudo
  if command -v docker >/dev/null 2>&1 && sudo docker info >/dev/null 2>&1; then
    warn "Docker requires sudo in this session (log out and back in after setup to fix)"
    DOCKER="sudo docker"
    return
  fi

  info "Docker not found — installing Docker CE..."
  curl -fsSL https://get.docker.com | sudo sh
  sudo usermod -aG docker "$USER"

  if docker info >/dev/null 2>&1; then
    DOCKER="docker"
    info "Docker CE installed"
  elif sudo docker info >/dev/null 2>&1; then
    DOCKER="sudo docker"
    info "Docker CE installed (log out and back in after setup to use without sudo)"
  else
    die "Docker was installed but the daemon is not responding. Try: sudo systemctl start docker"
  fi
}

# ── Step 3: Pull session image ────────────────────────────────────────────────

pull_image() {
  step "Pulling session image"
  info "$IMAGE"
  $DOCKER pull "$IMAGE"
}

# ── Step 4: Clone nanoclaw ────────────────────────────────────────────────────

clone_repo() {
  step "Cloning nanoclaw"
  git clone --branch main "$REPO_URL" "$WORKSPACE" </dev/null
  info "Cloned to $WORKSPACE"
}

# ── Step 5: Network isolation ─────────────────────────────────────────────────

# Inner function — called with set -e temporarily relaxed so failures are
# non-fatal (network filtering is best-effort).
_setup_iptables() {
  local subnet="$1"

  # Install ipset if not present
  if ! command -v ipset >/dev/null 2>&1; then
    info "Installing ipset..."
    if command -v apt-get >/dev/null 2>&1; then
      sudo apt-get install -y -qq ipset
    elif command -v yum >/dev/null 2>&1; then
      sudo yum install -y -q ipset
    else
      warn "Cannot install ipset — skipping IP-level filtering"
      return 1
    fi
  fi

  # Populate ipset with resolved bypass host IPs
  info "Resolving bypass hosts..."
  sudo ipset create "$IPSET_NAME" hash:ip family inet 2>/dev/null \
    || sudo ipset flush "$IPSET_NAME"

  local resolved=0
  for host in "${BYPASS_HOSTS[@]}"; do
    while IFS= read -r ip; do
      [[ "$ip" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]] || continue
      sudo ipset add "$IPSET_NAME" "$ip" 2>/dev/null || true
      ((resolved++)) || true
    done < <(getent ahostsv4 "$host" 2>/dev/null | awk '{print $1}' | sort -u)
  done
  info "Resolved $resolved IPs across ${#BYPASS_HOSTS[@]} hosts"

  local tag="nanoclaw-${SUFFIX}"

  # Rules are inserted at position 1 each time, so insert in reverse desired
  # priority — the last insert ends up first in the chain.
  #
  # Final rule order in DOCKER-USER:
  #   1. ESTABLISHED/RELATED → ACCEPT  (return traffic, fast path)
  #   2. DNS 53/udp+tcp      → ACCEPT
  #   3. ipset bypass IPs    → ACCEPT  (explicit IP whitelist)
  #   4. TCP 443 + 80        → ACCEPT  (CDN fallback: npm, GitHub, etc.)
  #   5. all other from subnet → DROP

  # Insert 4 first (lowest priority of the ACCEPTs)
  sudo iptables -I DOCKER-USER 1 -s "$subnet" -p tcp \
    -m multiport --dports 80,443 \
    -m comment --comment "$tag" -j ACCEPT

  # Insert 3
  sudo iptables -I DOCKER-USER 1 -s "$subnet" \
    -m set --match-set "$IPSET_NAME" dst \
    -m comment --comment "$tag" -j ACCEPT

  # Insert 2 (DNS)
  sudo iptables -I DOCKER-USER 1 -s "$subnet" -p udp --dport 53 \
    -m comment --comment "$tag" -j ACCEPT
  sudo iptables -I DOCKER-USER 1 -s "$subnet" -p tcp --dport 53 \
    -m comment --comment "$tag" -j ACCEPT

  # Insert 1 last so it's checked first
  sudo iptables -I DOCKER-USER 1 -s "$subnet" \
    -m conntrack --ctstate ESTABLISHED,RELATED \
    -m comment --comment "$tag" -j ACCEPT

  # Append DROP at the end (lowest priority)
  sudo iptables -A DOCKER-USER -s "$subnet" \
    -m comment --comment "$tag" -j DROP

  return 0
}

setup_network() {
  step "Setting up network isolation"

  # Create a dedicated bridge network for the session container
  $DOCKER network create --driver bridge "$NETWORK_NAME" >/dev/null
  NETWORK_CREATED=true

  local subnet
  subnet=$($DOCKER network inspect "$NETWORK_NAME" \
    --format '{{range .IPAM.Config}}{{.Subnet}}{{end}}')
  info "Network: $NETWORK_NAME  subnet: $subnet"

  # iptables filtering is best-effort — warn and continue if it fails
  if ! sudo iptables -L DOCKER-USER >/dev/null 2>&1; then
    warn "DOCKER-USER chain not found — skipping iptables filtering."
    warn "Ensure the Docker daemon is running and iptables support is enabled."
    return
  fi

  if _setup_iptables "$subnet"; then
    IPTABLES_ACTIVE=true
    info "Network filtering active (HTTPS/HTTP allowed, other protocols blocked)"
  else
    warn "iptables filtering could not be configured — session will run without it."
  fi
}

# ── Step 6: Launch session ────────────────────────────────────────────────────

run_session() {
  step "Launching NanoClaw"
  echo
  echo "  ┌─────────────────────────────────────────┐"
  echo "  │   Session ready — starting Claude Code  │"
  echo "  │   Type /setup when Claude starts        │"
  echo "  └─────────────────────────────────────────┘"
  echo

  # Persist Claude auth across sessions by mounting the host ~/.claude dir
  mkdir -p "${HOME}/.claude"

  # shellcheck disable=SC2086
  $DOCKER run --rm -it \
    --name "$CONTAINER_NAME" \
    --network "$NETWORK_NAME" \
    -v /var/run/docker.sock:/var/run/docker.sock \
    -v "$WORKSPACE:/workspace" \
    -v "${HOME}/.claude:/root/.claude" \
    -w /workspace \
    "$IMAGE" \
    claude </dev/tty

  echo
  echo "Session ended. Your workspace is at: $WORKSPACE"
  echo "To reconnect to this workspace:"
  # shellcheck disable=SC2086
  echo "  $DOCKER run --rm -it \\"
  echo "    -v /var/run/docker.sock:/var/run/docker.sock \\"
  echo "    -v $WORKSPACE:/workspace \\"
  echo "    -v \${HOME}/.claude:/root/.claude \\"
  echo "    -w /workspace \\"
  echo "    $IMAGE \\"
  echo "    claude"
}

# ── Main ──────────────────────────────────────────────────────────────────────

echo
echo "══════════════════════════════════════════"
echo "  NanoClaw Linux Installer"
echo "══════════════════════════════════════════"

check_os
install_docker
pull_image
clone_repo
setup_network
run_session
