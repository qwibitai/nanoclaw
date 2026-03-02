#!/bin/bash
# Sovereign Deploy Script
# Sets up Sovereign as a persistent service on macOS (launchd) or Linux (systemd).
# Auto-detects platform. Works on Mac Mini, Mac Studio, or any Linux VPS.
#
# Usage:
#   Mac:   bash scripts/deploy.sh
#   Linux: sudo bash scripts/deploy.sh

set -e

PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
NODE_BIN="$(command -v node 2>/dev/null || echo '')"
PLATFORM="$(uname -s)"
HOME_DIR="${HOME:-$(eval echo ~"$(whoami)")}"

echo "=== Sovereign Deploy ==="
echo "Platform: $PLATFORM"
echo "Project:  $PROJECT_DIR"
echo "Node:     ${NODE_BIN:-not found}"
echo ""

# ── Prerequisites ──

if [ -z "$NODE_BIN" ]; then
  echo "ERROR: Node.js not found."
  if [ "$PLATFORM" = "Darwin" ]; then
    echo "Install with: brew install node"
  else
    echo "Install Node.js 20+ from https://nodejs.org"
  fi
  exit 1
fi

NODE_MAJOR=$(node -e "console.log(process.versions.node.split('.')[0])")
if [ "$NODE_MAJOR" -lt 20 ] 2>/dev/null; then
  echo "ERROR: Node.js 20+ required (found v$(node --version))"
  exit 1
fi

if ! command -v docker &>/dev/null; then
  echo "ERROR: Docker not found."
  if [ "$PLATFORM" = "Darwin" ]; then
    echo "Install Docker Desktop from https://docker.com/products/docker-desktop"
  else
    echo "Install Docker: https://docs.docker.com/engine/install/"
  fi
  exit 1
fi

if [ ! -f "$PROJECT_DIR/.env" ]; then
  echo "ERROR: .env file not found."
  echo "Run: cp .env.example .env  then fill in your API keys."
  exit 1
fi

# ── Build ──

if [ ! -f "$PROJECT_DIR/dist/index.js" ]; then
  echo "Building TypeScript..."
  cd "$PROJECT_DIR" && npm run build
  echo ""
fi

if ! docker image inspect sovereign-agent:latest &>/dev/null 2>&1; then
  echo "Building agent container (this takes a few minutes)..."
  cd "$PROJECT_DIR/container" && ./build.sh
  echo ""
fi

# ── macOS (launchd) ──

deploy_macos() {
  local SERVICE_LABEL="com.sovereign"
  local PLIST_PATH="$HOME_DIR/Library/LaunchAgents/${SERVICE_LABEL}.plist"
  local LOG_DIR="$PROJECT_DIR/logs"

  mkdir -p "$LOG_DIR"
  mkdir -p "$(dirname "$PLIST_PATH")"

  echo "Setting up launchd service..."

  # Stop existing service if loaded
  if launchctl list 2>/dev/null | grep -q "$SERVICE_LABEL"; then
    echo "Stopping existing Sovereign service..."
    launchctl unload "$PLIST_PATH" 2>/dev/null || true
    sleep 2
  fi

  # Also kill any manual/nohup instances
  pkill -f "node.*dist/index.js" 2>/dev/null || true
  sleep 1

  # Write plist
  cat > "$PLIST_PATH" << EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${SERVICE_LABEL}</string>
    <key>ProgramArguments</key>
    <array>
        <string>${NODE_BIN}</string>
        <string>${PROJECT_DIR}/dist/index.js</string>
    </array>
    <key>WorkingDirectory</key>
    <string>${PROJECT_DIR}</string>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <dict>
        <key>SuccessfulExit</key>
        <false/>
    </dict>
    <key>ThrottleInterval</key>
    <integer>5</integer>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:${HOME_DIR}/.local/bin</string>
        <key>HOME</key>
        <string>${HOME_DIR}</string>
        <key>NODE_ENV</key>
        <string>production</string>
    </dict>
    <key>StandardOutPath</key>
    <string>${LOG_DIR}/sovereign.log</string>
    <key>StandardErrorPath</key>
    <string>${LOG_DIR}/sovereign.error.log</string>
</dict>
</plist>
EOF

  # Load and start
  launchctl load "$PLIST_PATH"
  sleep 3

  # Verify
  if launchctl list 2>/dev/null | grep -q "$SERVICE_LABEL"; then
    echo ""
    echo "=== Sovereign is running on macOS ==="
    echo ""
    echo "Commands:"
    echo "  launchctl list | grep sovereign                             # Check status"
    echo "  tail -f $LOG_DIR/sovereign.log                   # Follow logs"
    echo "  launchctl unload $PLIST_PATH   # Stop"
    echo "  launchctl load $PLIST_PATH     # Start"
    echo "  launchctl kickstart -k gui/\$(id -u)/$SERVICE_LABEL          # Restart"
    echo ""
    echo "Notes:"
    echo "  - Sovereign starts automatically when you log in."
    echo "  - For 24/7 operation (Mac Mini/Studio), enable auto-login"
    echo "    in System Settings > Users & Groups > Login Options."
    echo "  - Docker Desktop must be running. Enable 'Start Docker Desktop"
    echo "    when you sign in' in Docker Desktop > Settings > General."
  else
    echo "ERROR: Service failed to start. Check logs:"
    echo "  cat $LOG_DIR/sovereign.error.log"
    exit 1
  fi
}

# ── Linux (systemd) ──

deploy_linux() {
  local SERVICE_NAME="sovereign"
  local SERVICE_FILE="/etc/systemd/system/${SERVICE_NAME}.service"

  if [ "$(id -u)" -ne 0 ]; then
    echo "ERROR: Linux deploy requires root. Run with: sudo bash scripts/deploy.sh"
    exit 1
  fi

  echo "Creating systemd service..."

  # Stop any existing manual instances
  pkill -f "node.*dist/index.js" 2>/dev/null || true
  sleep 1

  cat > "$SERVICE_FILE" << EOF
[Unit]
Description=Sovereign AI Agent
After=network-online.target docker.service
Wants=docker.service
Requires=network-online.target

[Service]
Type=simple
WorkingDirectory=$PROJECT_DIR
ExecStart=$NODE_BIN dist/index.js
Restart=on-failure
RestartSec=5
StartLimitIntervalSec=300
StartLimitBurst=5
EnvironmentFile=$PROJECT_DIR/.env
Environment=HOME=$HOME_DIR
Environment=NODE_ENV=production

# Logging
StandardOutput=journal
StandardError=journal
SyslogIdentifier=sovereign

[Install]
WantedBy=multi-user.target
EOF

  systemctl daemon-reload
  systemctl enable "$SERVICE_NAME"
  systemctl start "$SERVICE_NAME"
  sleep 3

  if systemctl is-active --quiet "$SERVICE_NAME"; then
    echo ""
    echo "=== Sovereign is running on Linux ==="
    echo ""
    echo "Commands:"
    echo "  systemctl status $SERVICE_NAME     # Check status"
    echo "  journalctl -u $SERVICE_NAME -f     # Follow logs"
    echo "  systemctl restart $SERVICE_NAME    # Restart"
    echo "  systemctl stop $SERVICE_NAME       # Stop"
    echo ""
    systemctl status "$SERVICE_NAME" --no-pager -l | head -15
  else
    echo "ERROR: Service failed to start. Check logs:"
    echo "  journalctl -u $SERVICE_NAME -n 50"
    exit 1
  fi
}

# ── Run ──

if [ "$PLATFORM" = "Darwin" ]; then
  deploy_macos
elif [ "$PLATFORM" = "Linux" ]; then
  deploy_linux
else
  echo "ERROR: Unsupported platform: $PLATFORM"
  echo "Sovereign supports macOS and Linux."
  exit 1
fi
