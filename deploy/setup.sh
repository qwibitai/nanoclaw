#!/bin/bash
# BHD-ITSM-Agent — Automated Server Setup
# Run on a clean Ubuntu 22.04+ or Debian 12+ server
#
# Usage: ./deploy/setup.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"

echo "=============================================="
echo "  BHD-ITSM-Agent — Server Setup"
echo "=============================================="
echo ""
echo "Project root: $PROJECT_ROOT"
echo ""

# --- 1. System Dependencies ---
echo "[1/8] Checking system dependencies..."

install_node() {
    echo "  Installing Node.js 22..."
    curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
    sudo apt-get install -y nodejs
}

install_docker() {
    echo "  Installing Docker..."
    curl -fsSL https://get.docker.com | sudo sh
    sudo usermod -aG docker "$USER"
    echo "  NOTE: You may need to log out and back in for Docker group to take effect."
}

if ! command -v node &>/dev/null; then
    install_node
else
    NODE_VERSION=$(node -v | sed 's/v//' | cut -d. -f1)
    if [ "$NODE_VERSION" -lt 20 ]; then
        echo "  Node.js $NODE_VERSION is too old (need 20+). Upgrading..."
        install_node
    else
        echo "  Node.js $(node -v) — OK"
    fi
fi

if ! command -v docker &>/dev/null; then
    install_docker
else
    echo "  Docker $(docker --version | awk '{print $3}') — OK"
fi

# Ensure essential build tools are available
if ! command -v gcc &>/dev/null; then
    echo "  Installing build-essential (required for native modules)..."
    sudo apt-get update -qq
    sudo apt-get install -y build-essential python3
fi

# --- 2. NPM Dependencies ---
echo ""
echo "[2/8] Installing NPM dependencies..."
cd "$PROJECT_ROOT"
npm install

echo "  Installing portal dependencies..."
cd "$PROJECT_ROOT/portal"
npm install
cd "$PROJECT_ROOT"

# --- 3. Environment Configuration ---
echo ""
echo "[3/8] Setting up environment..."

if [ ! -f "$PROJECT_ROOT/.env" ]; then
    cp "$PROJECT_ROOT/.env.example" "$PROJECT_ROOT/.env"
    echo "  Created .env from template."
    echo ""
    echo "  ⚠  IMPORTANT: Edit .env with your API keys before starting:"
    echo "     - ANTHROPIC_API_KEY (required)"
    echo "     - VIVANTIO_API_TOKEN (required for ticket integration)"
    echo "     - PORTAL_JWT_SECRET (generate a secure random string)"
    echo "     - PORTAL_ADMIN_PASSWORD (change from default)"
    echo ""
    echo "  Run: nano $PROJECT_ROOT/.env"
    echo ""
else
    echo "  .env already exists — preserving existing configuration."
fi

# --- 4. Build Backend ---
echo "[4/8] Building backend..."
npm run build

# --- 5. Build Portal ---
echo ""
echo "[5/8] Building portal..."
npm run portal:build

# --- 6. Build Container Image ---
echo ""
echo "[6/8] Building agent container image..."
if command -v docker &>/dev/null && docker info &>/dev/null 2>&1; then
    "$PROJECT_ROOT/container/build.sh"
else
    echo "  Skipping container build (Docker not accessible)."
    echo "  Run './container/build.sh' after Docker is configured."
fi

# --- 7. Create Directories ---
echo ""
echo "[7/8] Creating runtime directories..."
mkdir -p "$PROJECT_ROOT/store"
mkdir -p "$PROJECT_ROOT/data"
mkdir -p "$PROJECT_ROOT/logs"
mkdir -p "$PROJECT_ROOT/groups/main"
mkdir -p "$PROJECT_ROOT/groups/global"

# Create default main group CLAUDE.md if missing
if [ ! -f "$PROJECT_ROOT/groups/main/CLAUDE.md" ]; then
    echo "# BHD Admin Agent" > "$PROJECT_ROOT/groups/main/CLAUDE.md"
    echo "" >> "$PROJECT_ROOT/groups/main/CLAUDE.md"
    echo "You are the admin agent for Blackhawk Data ITSM system." >> "$PROJECT_ROOT/groups/main/CLAUDE.md"
fi

if [ ! -f "$PROJECT_ROOT/groups/global/CLAUDE.md" ]; then
    echo "# Global Knowledge" > "$PROJECT_ROOT/groups/global/CLAUDE.md"
    echo "" >> "$PROJECT_ROOT/groups/global/CLAUDE.md"
    echo "Shared read-only knowledge available to all agents." >> "$PROJECT_ROOT/groups/global/CLAUDE.md"
fi

# --- 8. Install systemd Service ---
echo ""
echo "[8/8] Installing systemd service..."

NODE_PATH=$(which node)
SERVICE_FILE="/etc/systemd/system/bhd-itsm-agent.service"

sudo tee "$SERVICE_FILE" > /dev/null <<UNIT
[Unit]
Description=BHD-ITSM-Agent — AI Ticket Triage Service
After=network.target docker.service
Wants=docker.service

[Service]
Type=simple
User=$USER
WorkingDirectory=$PROJECT_ROOT
ExecStart=$NODE_PATH $PROJECT_ROOT/dist/index.js
Restart=always
RestartSec=10
Environment=HOME=$HOME
Environment=PATH=/usr/local/bin:/usr/bin:/bin:$HOME/.local/bin
StandardOutput=append:$PROJECT_ROOT/logs/bhd-itsm-agent.log
StandardError=append:$PROJECT_ROOT/logs/bhd-itsm-agent.error.log

[Install]
WantedBy=multi-user.target
UNIT

sudo systemctl daemon-reload
sudo systemctl enable bhd-itsm-agent

echo ""
echo "=============================================="
echo "  Setup Complete!"
echo "=============================================="
echo ""
echo "Next steps:"
echo ""
echo "  1. Edit your environment file:"
echo "     nano $PROJECT_ROOT/.env"
echo ""
echo "  2. Start the service:"
echo "     sudo systemctl start bhd-itsm-agent"
echo ""
echo "  3. Check status:"
echo "     sudo systemctl status bhd-itsm-agent"
echo ""
echo "  4. View logs:"
echo "     journalctl -u bhd-itsm-agent -f"
echo ""
echo "  5. Access the Agent Manager Portal:"
echo "     http://$(hostname -I | awk '{print $1}'):3200"
echo "     Login: admin@blackhawkdata.com / changeme"
echo ""
echo "  6. Run the portal frontend (for development):"
echo "     npm run portal:dev"
echo ""
