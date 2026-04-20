#!/usr/bin/env bash
set -euo pipefail

# Must run as root
[ "$(id -u)" = "0" ] || { echo "Must run as root"; exit 1; }

export DEBIAN_FRONTEND=noninteractive

# ---------------------------------------------------------------------------
# 1. Node.js 22 via NodeSource
# ---------------------------------------------------------------------------
echo "=== BOOTSTRAP: Installing Node.js 22 ==="
node --version 2>/dev/null | grep -q '^v22' || {
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
}

# ---------------------------------------------------------------------------
# 2. Docker via get.docker.com
# ---------------------------------------------------------------------------
echo "=== BOOTSTRAP: Installing Docker ==="
command -v docker &>/dev/null || {
  curl -fsSL https://get.docker.com | sh
}
# Ensure Docker starts on boot (idempotent)
systemctl enable docker --quiet
systemctl start docker

# ---------------------------------------------------------------------------
# 3. UFW firewall rules (deny all inbound except SSH)
# ---------------------------------------------------------------------------
echo "=== BOOTSTRAP: Configuring UFW firewall ==="
apt-get install -y ufw
ufw default deny incoming
ufw default allow outgoing
ufw allow 22/tcp
# NanoClaw channels use outbound WebSockets - no inbound ports needed
ufw --force enable

# ---------------------------------------------------------------------------
# 4. logrotate for NanoClaw logs
# ---------------------------------------------------------------------------
echo "=== BOOTSTRAP: Configuring logrotate ==="
cat > /etc/logrotate.d/nanoclaw <<'EOF'
/root/nanoclaw/logs/*.log {
    daily
    missingok
    rotate 14
    compress
    delaycompress
    notifempty
    copytruncate
}
EOF

# ---------------------------------------------------------------------------
# 5. Unattended upgrades (security patches only)
# ---------------------------------------------------------------------------
echo "=== BOOTSTRAP: Configuring unattended-upgrades ==="
apt-get update -qq
apt-get install -y unattended-upgrades
# Write the config (idempotent — overwrite is safe)
cat > /etc/apt/apt.conf.d/20auto-upgrades <<'EOF'
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
EOF

# ---------------------------------------------------------------------------
# 6. Success
# ---------------------------------------------------------------------------
echo "=== NANOCLAW BOOTSTRAP: SUCCESS ==="
echo "Node: $(node --version)"
echo "Docker: $(docker --version)"
echo "UFW: $(ufw status 2>/dev/null | head -1 || echo 'not available')"
