#!/bin/bash
set -euo pipefail

# deploy.sh — One-shot deployment script for GenTech Agency (NanoClaw)
# Run on your server: bash deploy.sh

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$PROJECT_ROOT"

echo "============================================"
echo "  GenTech Agency — Server Deployment"
echo "============================================"
echo ""

# --- 1. Check prerequisites ---
echo "[1/7] Checking prerequisites..."

# Node.js
if ! command -v node &>/dev/null; then
  echo "ERROR: Node.js not found. Install Node.js 20+:"
  echo "  curl -fsSL https://deb.nodesource.com/setup_22.x | sudo bash -"
  echo "  sudo apt-get install -y nodejs"
  exit 1
fi

NODE_MAJOR=$(node --version | sed 's/^v//' | cut -d. -f1)
if [ "$NODE_MAJOR" -lt 20 ]; then
  echo "ERROR: Node.js $NODE_MAJOR found, need 20+. Upgrade Node.js."
  exit 1
fi
echo "  Node.js $(node --version) ✓"

# Docker
if ! command -v docker &>/dev/null; then
  echo "ERROR: Docker not found. Install Docker:"
  echo "  curl -fsSL https://get.docker.com | sh"
  exit 1
fi

if ! docker info &>/dev/null; then
  echo "ERROR: Docker daemon not running. Start it:"
  echo "  sudo systemctl start docker"
  exit 1
fi
echo "  Docker ✓"

# Build tools (for better-sqlite3)
if ! command -v gcc &>/dev/null || ! command -v make &>/dev/null; then
  echo "WARNING: Build tools (gcc, make) not found."
  echo "  Install: sudo apt-get install -y build-essential python3"
fi

# --- 2. Check .env ---
echo ""
echo "[2/7] Checking configuration..."

if [ ! -f "$PROJECT_ROOT/.env" ]; then
  echo "ERROR: .env file not found. Create it with at least:"
  echo ""
  echo "  # Authentication (pick one)"
  echo "  CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-..."
  echo "  # or"
  echo "  ANTHROPIC_API_KEY=sk-ant-api03-..."
  echo ""
  echo "  # Telegram"
  echo "  TELEGRAM_BOT_TOKEN=your-bot-token"
  echo ""
  exit 1
fi

# Check for auth key
if ! grep -qE '^(CLAUDE_CODE_OAUTH_TOKEN|ANTHROPIC_API_KEY)=' "$PROJECT_ROOT/.env"; then
  echo "ERROR: No authentication token found in .env"
  echo "  Add CLAUDE_CODE_OAUTH_TOKEN or ANTHROPIC_API_KEY"
  exit 1
fi
echo "  Authentication token ✓"

# Check for Telegram token
if ! grep -qE '^TELEGRAM_BOT_TOKEN=' "$PROJECT_ROOT/.env"; then
  echo "WARNING: TELEGRAM_BOT_TOKEN not set in .env"
  echo "  Telegram channel will be skipped"
else
  echo "  Telegram bot token ✓"
fi

# --- 3. Install dependencies ---
echo ""
echo "[3/7] Installing dependencies..."

NPM_FLAGS=""
if [ "$(id -u)" -eq 0 ]; then
  NPM_FLAGS="--unsafe-perm"
fi
npm ci $NPM_FLAGS 2>&1 | tail -3
echo "  Dependencies installed ✓"

# Verify native module
if node -e "require('better-sqlite3')" 2>/dev/null; then
  echo "  Native modules ✓"
else
  echo "ERROR: better-sqlite3 failed to load. Install build tools:"
  echo "  sudo apt-get install -y build-essential python3"
  echo "  npm rebuild better-sqlite3"
  exit 1
fi

# --- 4. Build TypeScript ---
echo ""
echo "[4/7] Building TypeScript..."
npm run build
echo "  Build complete ✓"

# --- 5. Build agent container ---
echo ""
echo "[5/7] Building agent container..."

if docker image inspect nanoclaw-agent:latest &>/dev/null; then
  echo "  Container image already exists, skipping (run ./container/build.sh to rebuild)"
else
  bash "$PROJECT_ROOT/container/build.sh"
  echo "  Container image built ✓"
fi

# --- 6. Test Telegram connectivity ---
echo ""
echo "[6/7] Testing Telegram connectivity..."

TELEGRAM_TOKEN=$(grep '^TELEGRAM_BOT_TOKEN=' "$PROJECT_ROOT/.env" | cut -d= -f2-)
if [ -n "$TELEGRAM_TOKEN" ]; then
  RESPONSE=$(curl -s --max-time 10 "https://api.telegram.org/bot${TELEGRAM_TOKEN}/getMe" 2>&1 || echo '{"ok":false}')
  if echo "$RESPONSE" | grep -q '"ok":true'; then
    BOT_NAME=$(echo "$RESPONSE" | grep -o '"first_name":"[^"]*"' | cut -d'"' -f4)
    echo "  Telegram bot connected: $BOT_NAME ✓"
  else
    echo "  WARNING: Telegram bot token test failed. Check your token."
    echo "  Response: $RESPONSE"
  fi
else
  echo "  Skipped (no token)"
fi

# --- 7. Set up and start service ---
echo ""
echo "[7/7] Setting up service..."

# Kill any existing nanoclaw processes
pkill -f "$PROJECT_ROOT/dist/index.js" 2>/dev/null || true
sleep 1

mkdir -p "$PROJECT_ROOT/logs"

# Detect service manager
if command -v systemctl &>/dev/null && systemctl --version &>/dev/null; then
  # Use the built-in setup step
  npx tsx setup/index.ts --step service
  echo ""
  echo "  Service installed via systemd ✓"
  echo ""
  echo "  Manage with:"
  if [ "$(id -u)" -eq 0 ]; then
    echo "    systemctl status nanoclaw"
    echo "    systemctl restart nanoclaw"
    echo "    journalctl -u nanoclaw -f"
  else
    echo "    systemctl --user status nanoclaw"
    echo "    systemctl --user restart nanoclaw"
    echo "    journalctl --user -u nanoclaw -f"
  fi
else
  # nohup fallback
  npx tsx setup/index.ts --step service
  echo ""
  echo "  Service wrapper created ✓"
  echo "  Start with: bash start-nanoclaw.sh"
  bash "$PROJECT_ROOT/start-nanoclaw.sh"
fi

echo ""
echo "============================================"
echo "  Deployment complete!"
echo "============================================"
echo ""
echo "  Logs:    tail -f $PROJECT_ROOT/logs/nanoclaw.log"
echo "  Errors:  tail -f $PROJECT_ROOT/logs/nanoclaw.error.log"
echo ""
echo "  Registered groups:"
for dir in "$PROJECT_ROOT"/groups/*/; do
  if [ -f "$dir/group.json" ]; then
    GROUP_NAME=$(basename "$dir")
    echo "    - $GROUP_NAME"
  fi
done
echo ""
