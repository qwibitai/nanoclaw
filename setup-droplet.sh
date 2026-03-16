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

# --- 4. Add resource limits for 2GB droplet ---
echo ""
echo "[4/6] Configuring for 2GB droplet..."

$SSH_CMD bash <<REMOTE_CONFIG
set -euo pipefail

cd "${DEPLOY_PATH}"

# Add MAX_CONCURRENT_CONTAINERS if not set
if [ -f .env ] && ! grep -q '^MAX_CONCURRENT_CONTAINERS=' .env; then
  echo "" >> .env
  echo "# Limit concurrent containers for 2GB RAM droplet" >> .env
  echo "MAX_CONCURRENT_CONTAINERS=2" >> .env
  echo "  Set MAX_CONCURRENT_CONTAINERS=2 ✓"
fi

# Create logs directory
mkdir -p logs

echo "  Configuration complete ✓"
REMOTE_CONFIG

# --- 5. Run deploy.sh on droplet ---
echo ""
echo "[5/6] Running deployment..."

$SSH_CMD bash <<REMOTE_DEPLOY
set -euo pipefail
cd "${DEPLOY_PATH}"
bash deploy.sh
REMOTE_DEPLOY

# --- 6. Verify ---
echo ""
echo "[6/6] Verifying deployment..."

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
