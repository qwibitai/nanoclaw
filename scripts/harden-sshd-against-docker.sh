#!/bin/bash
# Deny SSH from Docker bridge networks.
#
# Context: NanoClaw agent containers run on the Docker default bridge
# (172.17.0.0/16) and have reachable host network via
# --add-host=host.docker.internal:host-gateway. If an agent ever drops an
# SSH keypair into its writable mount and adds the pubkey to the host's
# authorized_keys, it can SSH back as the host user. This script refuses
# those connections at the sshd layer as defense in depth.
#
# This is a one-time host-level change. Run with sudo.
#
#   sudo bash scripts/harden-sshd-against-docker.sh

set -euo pipefail

CONF=/etc/ssh/sshd_config.d/50-nanoclaw-deny-docker.conf

if [ "$(id -u)" -ne 0 ]; then
  echo "Run with sudo: sudo bash $0" >&2
  exit 1
fi

if [ -f "$CONF" ]; then
  echo "Already present: $CONF"
  echo "Current contents:"
  cat "$CONF"
  exit 0
fi

cat > "$CONF" <<'EOF'
# Installed by scripts/harden-sshd-against-docker.sh
# Refuse SSH from Docker bridge networks. NanoClaw agent containers run on
# 172.17.0.0/16 (default bridge) and 172.18.0.0/16 (compose networks) and
# should never SSH into the host.
Match Address 172.17.0.0/16,172.18.0.0/16
  DenyUsers *
  PasswordAuthentication no
  PubkeyAuthentication no
  KbdInteractiveAuthentication no
EOF

chmod 644 "$CONF"

echo "Wrote: $CONF"
echo "Validating sshd config..."
sshd -t

echo "Reloading sshd..."
systemctl reload ssh || systemctl reload sshd

echo ""
echo "Done. Verify with:"
echo "  docker run --rm --add-host=host.docker.internal:host-gateway alpine sh -c 'apk add --no-cache openssh-client && ssh -o BatchMode=yes -o ConnectTimeout=5 alec@host.docker.internal true' || echo OK-SSH-REFUSED"
