#!/bin/bash
set -euo pipefail

# setup-droplet.sh — Migrate GenTech Agency to a DigitalOcean droplet
# Run locally: bash setup-droplet.sh
#
# Prerequisites: SSH access as root to the droplet

DROPLET_IP="${DROPLET_IP:-159.203.125.252}"
DROPLET_USER="${DROPLET_USER:-root}"
DEPLOY_PATH="${DEPLOY_PATH:-/opt/gentech}"
REPO_URL="${REPO_URL:-https://github.com/ProtoJay4789/GenTech_AI_Agency.git}"
LOCAL_PROJECT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

SSH_CMD="ssh -o StrictHostKeyChecking=accept-new ${DROPLET_USER}@${DROPLET_IP}"
SCP_CMD="scp -o StrictHostKeyChecking=accept-new"

echo "============================================"
echo "  GenTech Agency — Droplet Migration"
echo "============================================"
echo ""
echo "  Droplet:  ${DROPLET_USER}@${DROPLET_IP}"
echo "  Deploy:   ${DEPLOY_PATH}"
echo "  Repo:     ${REPO_URL}"
echo ""

# --- 0. Verify SSH connectivity ---
echo "[0/6] Testing SSH connection..."
if ! $SSH_CMD "echo 'SSH OK'" 2>/dev/null; then
  echo "ERROR: Cannot SSH into ${DROPLET_USER}@${DROPLET_IP}"
  echo "  Ensure your SSH key is added to the droplet."
  exit 1
fi
echo "  SSH connection ✓"

# --- 1. Install prerequisites ---
echo ""
echo "[1/6] Installing prerequisites on droplet..."

$SSH_CMD bash <<'REMOTE_SETUP'
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive

echo "  Updating system packages..."
apt-get update -qq
apt-get upgrade -y -qq

# Node.js 22
if ! command -v node &>/dev/null || [ "$(node --version | sed 's/^v//' | cut -d. -f1)" -lt 20 ]; then
  echo "  Installing Node.js 22..."
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y -qq nodejs
fi
echo "  Node.js $(node --version) ✓"

# Build tools
echo "  Installing build tools..."
apt-get install -y -qq build-essential python3 git

# Docker
if ! command -v docker &>/dev/null; then
  echo "  Installing Docker..."
  curl -fsSL https://get.docker.com | sh
fi
systemctl enable docker
systemctl start docker
echo "  Docker ✓"

echo "  Prerequisites complete ✓"
REMOTE_SETUP

# --- 2. Clean old content and clone repo ---
echo ""
echo "[2/6] Setting up project on droplet..."

$SSH_CMD bash <<REMOTE_CLONE
set -euo pipefail

# Stop existing nanoclaw service if running
systemctl stop nanoclaw 2>/dev/null || true
systemctl --user stop nanoclaw 2>/dev/null || true

# Remove old deployment if exists
if [ -d "${DEPLOY_PATH}" ]; then
  echo "  Removing old deployment at ${DEPLOY_PATH}..."
  rm -rf "${DEPLOY_PATH}"
fi

echo "  Cloning repository..."
git clone "${REPO_URL}" "${DEPLOY_PATH}"
echo "  Repository cloned ✓"
REMOTE_CLONE

# --- 3. Transfer persistent data ---
echo ""
echo "[3/6] Transferring persistent data..."

# .env file
if [ -f "${LOCAL_PROJECT}/.env" ]; then
  echo "  Copying .env..."
  $SCP_CMD "${LOCAL_PROJECT}/.env" "${DROPLET_USER}@${DROPLET_IP}:${DEPLOY_PATH}/.env"
  echo "  .env ✓"
else
  echo "  WARNING: No .env file found locally. You'll need to create one on the droplet."
fi

# SQLite database
if [ -f "${LOCAL_PROJECT}/store/messages.db" ]; then
  echo "  Copying database..."
  $SSH_CMD "mkdir -p ${DEPLOY_PATH}/store"
  $SCP_CMD "${LOCAL_PROJECT}/store/messages.db" "${DROPLET_USER}@${DROPLET_IP}:${DEPLOY_PATH}/store/messages.db"
  echo "  Database ✓"
else
  echo "  No existing database found (will be created fresh)"
fi

# Groups directory
if [ -d "${LOCAL_PROJECT}/groups" ]; then
  echo "  Copying groups data..."
  $SCP_CMD -r "${LOCAL_PROJECT}/groups/" "${DROPLET_USER}@${DROPLET_IP}:${DEPLOY_PATH}/groups/"
  echo "  Groups ✓"
fi

# Mount allowlist config
if [ -f "$HOME/.config/nanoclaw/mount-allowlist.json" ]; then
  echo "  Copying mount allowlist..."
  $SSH_CMD "mkdir -p /root/.config/nanoclaw"
  $SCP_CMD "$HOME/.config/nanoclaw/mount-allowlist.json" "${DROPLET_USER}@${DROPLET_IP}:/root/.config/nanoclaw/mount-allowlist.json"
fi

if [ -f "$HOME/.config/nanoclaw/sender-allowlist.json" ]; then
  echo "  Copying sender allowlist..."
  $SSH_CMD "mkdir -p /root/.config/nanoclaw"
  $SCP_CMD "$HOME/.config/nanoclaw/sender-allowlist.json" "${DROPLET_USER}@${DROPLET_IP}:/root/.config/nanoclaw/sender-allowlist.json"
fi

echo "  Data transfer complete ✓"

# --- 4. Configure resources for 2GB droplet ---
echo ""
echo "[4/7] Configuring for 2GB droplet..."

$SSH_CMD bash <<REMOTE_CONFIG
set -euo pipefail

# --- Swap setup (critical for 2GB droplets) ---
# Without swap, Docker containers get OOM-killed almost immediately
if [ ! -f /swapfile ]; then
  echo "  Creating 2GB swap file..."
  fallocate -l 2G /swapfile
  chmod 600 /swapfile
  mkswap /swapfile
  swapon /swapfile
  echo '/swapfile none swap sw 0 0' >> /etc/fstab
  echo "  Swap enabled (2GB) ✓"
else
  echo "  Swap already exists ✓"
fi

# Reduce swappiness so RAM is preferred over swap
sysctl vm.swappiness=10 2>/dev/null || true
grep -q 'vm.swappiness' /etc/sysctl.conf 2>/dev/null || echo 'vm.swappiness=10' >> /etc/sysctl.conf

echo "  Swap: \$(free -h | awk '/Swap/{print \$2}')"

cd "${DEPLOY_PATH}"

# --- VPS-optimized .env configuration ---
if [ -f .env ]; then
  # MAX_CONCURRENT_CONTAINERS: limit for 2GB RAM
  if ! grep -q '^MAX_CONCURRENT_CONTAINERS=' .env; then
    echo "" >> .env
    echo "# VPS resource limits (2GB droplet)" >> .env
    echo "MAX_CONCURRENT_CONTAINERS=2" >> .env
    echo "  Set MAX_CONCURRENT_CONTAINERS=2 ✓"
  fi

  # CONTAINER_TIMEOUT: 10 min instead of 30 min
  if ! grep -q '^CONTAINER_TIMEOUT=' .env; then
    echo "CONTAINER_TIMEOUT=600000" >> .env
    echo "  Set CONTAINER_TIMEOUT=600000 (10min) ✓"
  fi

  # IDLE_TIMEOUT: 5 min instead of 30 min to free memory faster
  if ! grep -q '^IDLE_TIMEOUT=' .env; then
    echo "IDLE_TIMEOUT=300000" >> .env
    echo "  Set IDLE_TIMEOUT=300000 (5min) ✓"
  fi
fi

# Create logs directory
mkdir -p logs

echo "  Configuration complete ✓"
REMOTE_CONFIG

# --- 5. Run deploy.sh on droplet ---
echo ""
echo "[5/7] Running deployment..."

$SSH_CMD bash <<REMOTE_DEPLOY
set -euo pipefail
cd "${DEPLOY_PATH}"
bash deploy.sh
REMOTE_DEPLOY

# --- 6. Test container connectivity ---
echo ""
echo "[6/7] Testing container→host connectivity..."

$SSH_CMD bash <<REMOTE_CONNECTIVITY
set -euo pipefail

# Verify containers can reach the host's credential proxy port
PROXY_PORT=\$(grep '^CREDENTIAL_PROXY_PORT=' "${DEPLOY_PATH}/.env" 2>/dev/null | cut -d= -f2- || echo "3001")
PROXY_PORT=\${PROXY_PORT:-3001}

# Determine the expected host gateway address
DOCKER0_IP=\$(ip -4 addr show docker0 2>/dev/null | grep -oP 'inet \K[\d.]+' || echo "")
if [ -n "\$DOCKER0_IP" ]; then
  HOST_GW="\$DOCKER0_IP"
else
  HOST_GW="172.17.0.1"
fi

echo "  Docker bridge IP: \${DOCKER0_IP:-not found (will use host-gateway)}"
echo "  Expected proxy at: \${HOST_GW}:\${PROXY_PORT}"

# Quick test: can a container resolve host.docker.internal?
CONTAINER_TEST=\$(docker run --rm --add-host=host.docker.internal:host-gateway \
  alpine:latest sh -c "getent hosts host.docker.internal 2>/dev/null | awk '{print \\\$1}'" 2>/dev/null || echo "")

if [ -n "\$CONTAINER_TEST" ]; then
  echo "  Container→host resolution: \$CONTAINER_TEST ✓"
else
  echo "  WARNING: Container cannot resolve host.docker.internal"
  echo "  The credential proxy may not be reachable from containers."
  echo "  Set CREDENTIAL_PROXY_HOST=0.0.0.0 in .env if issues persist."
fi
REMOTE_CONNECTIVITY

# --- 7. Verify ---
echo ""
echo "[7/7] Verifying deployment..."

$SSH_CMD bash <<'REMOTE_VERIFY'
set -euo pipefail

echo "  Service status:"
if systemctl is-active nanoclaw &>/dev/null; then
  echo "    nanoclaw: active ✓"
elif systemctl --user is-active nanoclaw &>/dev/null; then
  echo "    nanoclaw (user): active ✓"
else
  echo "    WARNING: nanoclaw service not detected as active"
  echo "    Check: systemctl status nanoclaw"
fi

echo ""
echo "  Docker status:"
if docker info &>/dev/null; then
  echo "    Docker: running ✓"
else
  echo "    WARNING: Docker not accessible"
fi

echo ""
echo "  Disk usage:"
du -sh /opt/gentech 2>/dev/null || true
REMOTE_VERIFY

echo ""
echo "============================================"
echo "  Migration complete!"
echo "============================================"
echo ""
echo "  Connect:  ssh ${DROPLET_USER}@${DROPLET_IP}"
echo "  Logs:     ssh ${DROPLET_USER}@${DROPLET_IP} 'journalctl -u nanoclaw -f'"
echo "  Status:   ssh ${DROPLET_USER}@${DROPLET_IP} 'systemctl status nanoclaw'"
echo ""
echo "  NOTE: If using OAuth token, you may need to generate a fresh"
echo "  token on the droplet:"
echo "    ssh ${DROPLET_USER}@${DROPLET_IP}"
echo "    npx @anthropic-ai/claude-code setup-token"
echo "    # Then update ${DEPLOY_PATH}/.env with the new token"
echo "    systemctl restart nanoclaw"
echo ""
