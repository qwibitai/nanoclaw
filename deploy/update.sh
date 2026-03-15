#!/bin/bash
# BHD-ITSM-Agent — Pull latest changes, rebuild, and restart
#
# Usage: ./deploy/update.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"

echo "BHD-ITSM-Agent — Updating..."

cd "$PROJECT_ROOT"

# Pull latest
echo "[1/5] Pulling latest changes..."
git pull

# Install dependencies
echo "[2/5] Installing dependencies..."
npm install
cd portal && npm install && cd ..

# Build
echo "[3/5] Building backend..."
npm run build

echo "[4/5] Building portal..."
npm run portal:build

# Rebuild container if Docker is available
echo "[5/5] Rebuilding agent container..."
if command -v docker &>/dev/null && docker info &>/dev/null 2>&1; then
    ./container/build.sh
else
    echo "  Docker not available — skipping container rebuild."
fi

# Restart service
echo ""
echo "Restarting service..."
sudo systemctl restart bhd-itsm-agent

echo ""
echo "Update complete! Check status:"
echo "  sudo systemctl status bhd-itsm-agent"
echo "  journalctl -u bhd-itsm-agent -f"
