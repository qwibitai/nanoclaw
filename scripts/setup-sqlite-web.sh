#!/usr/bin/env bash
# setup-sqlite-web.sh — Install sqlite-web as a companion service to NanoClaw.
# Binds publicly on port 8088, password-protected via SQLITE_WEB_PASSWORD in .env.
# Access from any browser: http://your-server-ip:8088

set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="$PROJECT_ROOT/.env"
SERVICE_FILE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/sqlite-web.service"

# --- Ensure SQLITE_WEB_PASSWORD is set in .env ---

if grep -q "^SQLITE_WEB_PASSWORD=" "$ENV_FILE" 2>/dev/null; then
  echo "SQLITE_WEB_PASSWORD already set in .env — skipping."
else
  # Generate a random password if not provided
  PASSWORD="${1:-$(openssl rand -base64 18 | tr -d '/+=' | head -c 24)}"
  echo "SQLITE_WEB_PASSWORD=${PASSWORD}" >> "$ENV_FILE"
  echo ""
  echo "Generated password: $PASSWORD"
  echo "(saved to .env as SQLITE_WEB_PASSWORD)"
  echo ""
fi

# --- Install sqlite-web ---

echo "Installing sqlite-web..."
pip3 install sqlite-web

# --- Register systemd service ---

echo "Registering systemd service..."
sudo cp "$SERVICE_FILE" /etc/systemd/system/sqlite-web.service
sudo systemctl daemon-reload
sudo systemctl enable sqlite-web
sudo systemctl start sqlite-web

# --- Done ---

SERVER_IP=$(curl -s ifconfig.me 2>/dev/null || hostname -I | awk '{print $1}')

echo ""
echo "Done. sqlite-web is running at http://${SERVER_IP}:8088"
echo "Password: $(grep '^SQLITE_WEB_PASSWORD=' "$ENV_FILE" | cut -d= -f2)"
echo ""
echo "Open port 8088 on your firewall if needed:"
echo "  sudo ufw allow 8088"
echo ""
echo "Service commands:"
echo "  sudo systemctl status sqlite-web"
echo "  sudo systemctl restart sqlite-web"
echo "  sudo systemctl stop sqlite-web"
