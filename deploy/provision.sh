#!/usr/bin/env bash
set -euo pipefail

echo "=== NanoClaw Provisioning ==="

# Swap (2GB) for low-memory VMs
if [ ! -f /swapfile ]; then
  echo "Creating 2GB swap..."
  fallocate -l 2G /swapfile
  chmod 600 /swapfile
  mkswap /swapfile
  swapon /swapfile
  echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

# Docker
if ! command -v docker &>/dev/null; then
  echo "Installing Docker..."
  curl -fsSL https://get.docker.com | sh
fi

# Node.js 22
if ! command -v node &>/dev/null || ! node -v | grep -q "^v22"; then
  echo "Installing Node.js 22..."
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
fi

# sqlite3 (needed for group registration)
apt-get install -y sqlite3

# Create nanoclaw user (uid 1000 matches container's node user — avoids IPC permission issues)
if ! id nanoclaw &>/dev/null; then
  echo "Creating nanoclaw user..."
  useradd -m -s /bin/bash -u 1000 nanoclaw
  usermod -aG docker nanoclaw
fi

REPO_DIR="/home/nanoclaw/app"

# Clone repo
if [ ! -d "$REPO_DIR" ]; then
  echo "Cloning NanoClaw..."
  sudo -u nanoclaw git clone https://github.com/blissito/nanoclaw.git "$REPO_DIR"
fi

cd "$REPO_DIR"
sudo -u nanoclaw git fetch origin skill/easybits
sudo -u nanoclaw git checkout skill/easybits
sudo -u nanoclaw git pull origin skill/easybits

# Merge WhatsApp remote (needed for QR pairing)
sudo -u nanoclaw git remote add whatsapp https://github.com/qwibitai/nanoclaw-whatsapp.git 2>/dev/null || true
sudo -u nanoclaw git fetch whatsapp main
sudo -u nanoclaw git merge whatsapp/main --no-edit || true

# Patch WhatsApp channel for headless QR code display
# Baileys 7.x deprecated printQRInTerminal — must render QR manually
echo "Patching WhatsApp for headless QR..."
sed -i "1s|^|import qrcode from 'qrcode-terminal';\n|" src/channels/whatsapp.ts
sed -i "s/printQRInTerminal: false/printQRInTerminal: false/" src/channels/whatsapp.ts
python3 -c "
content = open('src/channels/whatsapp.ts').read()
old = '''      if (qr) {
        const msg =
          'WhatsApp authentication required. Run /setup in Claude Code.';
        logger.error(msg);
        exec(
          \`osascript -e 'display notification \"\${msg}\" with title \"NanoClaw\" sound name \"Basso\"'\`,
        );
        setTimeout(() => process.exit(1), 1000);
      }'''
new = '''      if (qr) {
        logger.info('Scan this QR code with WhatsApp (Linked Devices > Link a Device):');
        qrcode.generate(qr, { small: true });
      }'''
open('src/channels/whatsapp.ts', 'w').write(content.replace(old, new))
print('QR patch applied')
"

# Install & build
echo "Installing dependencies..."
sudo -u nanoclaw npm install
echo "Building..."
sudo -u nanoclaw npm run build

# Build agent container
echo "Building agent container..."
sudo -u nanoclaw ./container/build.sh

# Install systemd service
echo "Installing systemd service..."
cat > /etc/systemd/system/nanoclaw.service << 'EOF'
[Unit]
Description=NanoClaw Agent
After=network.target docker.service
Requires=docker.service

[Service]
Type=simple
User=nanoclaw
WorkingDirectory=/home/nanoclaw/app
ExecStart=/usr/bin/node dist/index.js
Restart=always
RestartSec=5
EnvironmentFile=/home/nanoclaw/app/.env
Environment=HOME=/home/nanoclaw
Environment=PATH=/usr/local/bin:/usr/bin:/bin

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable nanoclaw

echo ""
echo "=== Provisioning complete ==="
echo ""
echo "Next steps:"
echo "  1. Create .env:  nano /home/nanoclaw/app/.env"
echo "  2. Authenticate WhatsApp (interactive QR):"
echo "       sudo -u nanoclaw bash -c 'cd /home/nanoclaw/app && node dist/index.js'"
echo "     Scan the QR code, then Ctrl+C"
echo "  3. Register a group:"
echo "       # Send a message in the WhatsApp group first, then:"
echo "       sqlite3 /home/nanoclaw/app/store/messages.db \"SELECT jid, name FROM chats WHERE is_group = 1;\""
echo "       sqlite3 /home/nanoclaw/app/store/messages.db \"INSERT INTO registered_groups (jid, name, folder, trigger_pattern, added_at, requires_trigger) VALUES ('<JID>', '<NAME>', 'main', '^@ghosty\\\b', '$(date -u +%Y-%m-%dT%H:%M:%SZ)', 0);\""
echo "  4. Start service:  systemctl start nanoclaw"
