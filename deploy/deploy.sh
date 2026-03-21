#!/usr/bin/env bash
set -euo pipefail

DROPLET_NAME="nanoclaw-prod"
REGION="sfo3"
SIZE="s-1vcpu-2gb"
IMAGE="ubuntu-24-04-x64"
SSH_KEY_NAME="nanoclaw-key"

echo "=== NanoClaw Deploy (DigitalOcean) ==="
echo ""

# Prereqs
command -v doctl &>/dev/null || { echo "Error: doctl not installed. Run: brew install doctl"; exit 1; }

# Detect local SSH key
SSH_KEY=""
for key in ~/.ssh/id_ed25519 ~/.ssh/id_rsa; do
  if [ -f "$key" ]; then
    SSH_KEY="$key"
    break
  fi
done
[ -z "$SSH_KEY" ] && { echo "Error: No SSH key found (~/.ssh/id_ed25519 or ~/.ssh/id_rsa)"; exit 1; }
echo "Using SSH key: $SSH_KEY"

# Get DO SSH key ID
SSH_KEY_ID=$(doctl compute ssh-key list --format ID,Name --no-header | grep "$SSH_KEY_NAME" | awk '{print $1}')
[ -z "$SSH_KEY_ID" ] && { echo "Error: SSH key '$SSH_KEY_NAME' not found in DigitalOcean"; exit 1; }

# Check if droplet already exists
EXISTING_IP=$(doctl compute droplet list --format Name,PublicIPv4 --no-header | grep "^$DROPLET_NAME " | awk '{print $2}' || true)

if [ -n "$EXISTING_IP" ]; then
  echo "Droplet '$DROPLET_NAME' already exists at $EXISTING_IP"
  VM_IP="$EXISTING_IP"
else
  echo "Creating droplet ($SIZE in $REGION)..."
  doctl compute droplet create "$DROPLET_NAME" \
    --region "$REGION" \
    --size "$SIZE" \
    --image "$IMAGE" \
    --ssh-keys "$SSH_KEY_ID" \
    --wait

  VM_IP=$(doctl compute droplet list --format Name,PublicIPv4 --no-header | grep "^$DROPLET_NAME " | awk '{print $2}')
  echo "Droplet created!"
fi

echo ""
echo "VM IP: $VM_IP"

SSH_CMD="ssh -i $SSH_KEY -o StrictHostKeyChecking=accept-new root@$VM_IP"
SCP_CMD="scp -i $SSH_KEY -o StrictHostKeyChecking=accept-new"

# Wait for SSH to be ready
echo ""
echo "Waiting for SSH..."
for i in $(seq 1 30); do
  $SSH_CMD "echo ok" 2>/dev/null && break
  sleep 5
done

# Upload and run provision script
echo ""
echo "Uploading provision script..."
$SCP_CMD deploy/provision.sh "root@$VM_IP:/tmp/provision.sh"

echo ""
echo "Running provisioning (this takes a few minutes)..."
$SSH_CMD "chmod +x /tmp/provision.sh && /tmp/provision.sh"

# Collect API keys
echo ""
echo "=== Configuration ==="
read -rp "ANTHROPIC_API_KEY: " ANTHROPIC_KEY
read -rp "EASYBITS_API_KEY [eb_sk_live_e2vZNcNFNMRTE7BvemR79HfJ4qJ05X5M]: " EASYBITS_KEY
EASYBITS_KEY="${EASYBITS_KEY:-eb_sk_live_e2vZNcNFNMRTE7BvemR79HfJ4qJ05X5M}"

read -rp "Bot name (trigger, default: ghosty): " BOT_NAME
BOT_NAME="${BOT_NAME:-ghosty}"

# Write .env
echo ""
echo "Writing .env..."
$SSH_CMD "cat > /home/nanoclaw/app/.env << EOF
ANTHROPIC_API_KEY=$ANTHROPIC_KEY
EASYBITS_API_KEY=$EASYBITS_KEY
ASSISTANT_NAME=$BOT_NAME
EOF
chown nanoclaw:nanoclaw /home/nanoclaw/app/.env"

# Interactive session for WhatsApp QR
echo ""
echo "=== WhatsApp Authentication ==="
echo "An interactive session will open. A QR code will appear."
echo "Scan it with WhatsApp > Linked Devices > Link a Device."
echo "Once connected ('Connected to WhatsApp' appears), press Ctrl+C."
echo ""
read -rp "Press Enter to start..."
$SSH_CMD -t "sudo -u nanoclaw bash -c 'cd /home/nanoclaw/app && node dist/index.js'"

# Register group
echo ""
echo "=== Group Registration ==="
echo "NanoClaw needs a registered group to respond to messages."
echo "Send a message in the WhatsApp group you want to use, then press Enter."
read -rp "Press Enter after sending a message..."

# Start briefly to detect the group, then stop
$SSH_CMD "systemctl start nanoclaw && sleep 10 && systemctl stop nanoclaw"

echo ""
echo "Detected groups:"
$SSH_CMD "sqlite3 /home/nanoclaw/app/store/messages.db \"SELECT jid, name FROM chats WHERE is_group = 1;\"" | while IFS='|' read -r jid name; do
  echo "  [$jid] $name"
done

echo ""
read -rp "Paste the JID of the group to register: " GROUP_JID
read -rp "Group name: " GROUP_NAME

$SSH_CMD "sqlite3 /home/nanoclaw/app/store/messages.db \"INSERT OR REPLACE INTO registered_groups (jid, name, folder, trigger_pattern, added_at, requires_trigger) VALUES ('$GROUP_JID', '$GROUP_NAME', 'main', '^@${BOT_NAME}\\\\b', datetime('now'), 0);\""

echo "Group registered!"

# Start service
echo ""
echo "Starting NanoClaw service..."
$SSH_CMD "systemctl start nanoclaw"
sleep 3
$SSH_CMD "journalctl -u nanoclaw --no-pager -n 5 | grep -E 'groupCount|running|Connected'"

echo ""
echo "=== Deploy complete! ==="
echo ""
echo "Send a message in the '$GROUP_NAME' group to test."
echo ""
echo "Manage:"
echo "  ssh root@$VM_IP"
echo "  journalctl -u nanoclaw -f"
echo "  systemctl restart nanoclaw"
echo ""
echo "Tear down:"
echo "  doctl compute droplet delete $DROPLET_NAME"
