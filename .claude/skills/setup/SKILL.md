---
name: setup
description: Run initial NanoClaw setup on Ubuntu Server. Use when user wants to install dependencies, build rootfs, configure networking, authenticate WhatsApp, register their main channel, or start the background service. Triggers on "setup", "install", "configure nanoclaw", or first-time setup requests.
---

# NanoClaw Setup

Run all commands automatically. Only pause when user action is required (scanning QR codes).

## 1. Install Dependencies

```bash
npm install
```

## 2. Verify Firecracker Setup

Check that the Firecracker prerequisites are in place:

```bash
echo "=== Checking Firecracker Prerequisites ==="

echo -n "1. /dev/kvm access: "
[ -r /dev/kvm ] && [ -w /dev/kvm ] && echo "OK" || echo "MISSING - run: sudo usermod -aG kvm $USER"

echo -n "2. Firecracker binary: "
[ -x /usr/local/bin/firecracker ] && echo "OK ($(/usr/local/bin/firecracker --version 2>&1 | head -1))" || echo "MISSING - install from https://github.com/firecracker-microvm/firecracker/releases"

echo -n "3. VM kernel: "
[ -f /opt/firecracker/vmlinux.bin ] && echo "OK" || echo "MISSING - download a Firecracker-compatible vmlinux"

echo -n "4. Agent rootfs: "
[ -f /opt/firecracker/agent-rootfs.ext4 ] && echo "OK ($(du -h /opt/firecracker/agent-rootfs.ext4 | cut -f1))" || echo "MISSING - will build in step 3"

echo -n "5. Network bridge (fcbr0): "
ip link show fcbr0 &>/dev/null && echo "OK" || echo "MISSING - will configure in step 3"
```

If Firecracker is not installed, tell the user:
> Firecracker v1.7.0+ is required for running agents in isolated microVMs.
>
> Install it:
> ```bash
> ARCH=$(uname -m)
> curl -L https://github.com/firecracker-microvm/firecracker/releases/download/v1.7.0/firecracker-v1.7.0-${ARCH}.tgz | tar xz
> sudo mv release-v1.7.0-${ARCH}/firecracker-v1.7.0-${ARCH} /usr/local/bin/firecracker
> sudo chmod +x /usr/local/bin/firecracker
> rm -rf release-v1.7.0-${ARCH}
> ```
>
> You also need a Firecracker-compatible kernel:
> ```bash
> sudo mkdir -p /opt/firecracker
> curl -L -o /opt/firecracker/vmlinux.bin https://s3.amazonaws.com/spec.ccfc.min/img/quickstart_guide/x86_64/kernels/vmlinux.bin
> ```
>
> And ensure your user is in the kvm group:
> ```bash
> sudo usermod -aG kvm $USER
> # Log out and back in for this to take effect
> ```

## 3. Build Rootfs and Configure Networking

### 3a. Set up networking (bridge + NAT)

```bash
npm run setup-network
```

### 3b. Build the agent rootfs image

This creates `/opt/firecracker/agent-rootfs.ext4` with Ubuntu 22.04, Node.js 22, and Claude Code CLI.

```bash
npm run build-rootfs
```

Verify:
```bash
[ -f /opt/firecracker/agent-rootfs.ext4 ] && echo "Rootfs built: $(du -h /opt/firecracker/agent-rootfs.ext4 | cut -f1)" || echo "Build failed"
```

## 4. Configure Vercel AI Gateway

Ask the user:
> Do you have a Vercel AI Gateway API key? This allows Claude Code to use your existing Claude Max subscription ($0 API costs).
>
> Get one from: https://vercel.com/account/ai-gateway

If they have a key:
```bash
echo "VERCEL_AI_GATEWAY_KEY=<their-key>" > .env
```

If they don't have one and want to use a direct API key instead:
```bash
echo "ANTHROPIC_API_KEY=<their-key>" > .env
```

Verify:
```bash
[ -f .env ] && echo ".env configured" || echo ".env missing"
```

## 5. WhatsApp Authentication

**USER ACTION REQUIRED**

Run the authentication script:

```bash
npm run auth
```

Tell the user:
> A QR code will appear. On your phone:
> 1. Open WhatsApp
> 2. Tap **Settings → Linked Devices → Link a Device**
> 3. Scan the QR code

Wait for the script to output "Successfully authenticated" then continue.

## 6. Configure Assistant Name

Ask the user:
> What trigger word do you want to use? (default: `Andy`)
>
> Messages starting with `@TriggerWord` will be sent to Claude.

If they choose something other than `Andy`, update:
1. `groups/CLAUDE.md` - Change "# Andy" and "You are Andy" to the new name
2. `groups/main/CLAUDE.md` - Same changes at the top

## 7. Register Main Channel

Ask the user:
> Do you want to use your **personal chat** (message yourself) or a **WhatsApp group** as your main control channel?

For personal chat:
> Send any message to yourself in WhatsApp (the "Message Yourself" chat). Tell me when done.

After user confirms, start the app briefly to capture the message:

```bash
timeout 10 npm run dev || true
```

Then find the JID from the database:

```bash
sqlite3 store/messages.db "SELECT DISTINCT chat_jid, name FROM chats ORDER BY last_message_time DESC LIMIT 5"
```

Create/update `data/registered_groups.json`:
```json
{
  "JID_HERE": {
    "name": "main",
    "folder": "main",
    "trigger": "@ASSISTANT_NAME",
    "added_at": "CURRENT_ISO_TIMESTAMP"
  }
}
```

Ensure the groups folder exists:
```bash
mkdir -p groups/main/logs
```

## 8. Configure External Directory Access (Mount Allowlist)

Ask the user:
> Do you want the agent to be able to access any directories **outside** the NanoClaw project?
>
> Examples: Git repositories, project folders, documents you want Claude to work on.

If **no**, create an empty allowlist:

```bash
mkdir -p ~/.config/nanoclaw
cat > ~/.config/nanoclaw/mount-allowlist.json << 'EOF'
{
  "allowedRoots": [],
  "blockedPatterns": [],
  "nonMainReadOnly": true
}
EOF
```

If **yes**, ask which directories and create the allowlist accordingly. See the mount-security.ts module for the format.

## 9. Configure systemd Service

Generate the systemd service file:

```bash
NODE_PATH=$(which tsx || which node)
PROJECT_PATH=$(pwd)

sudo bash -c "cat > /etc/systemd/system/nanoclaw.service << EOF
[Unit]
Description=NanoClaw Personal Claude Assistant
After=network.target

[Service]
Type=simple
User=$(whoami)
WorkingDirectory=${PROJECT_PATH}
ExecStart=${NODE_PATH} src/index.ts
Restart=always
RestartSec=5
StandardOutput=append:${PROJECT_PATH}/logs/nanoclaw.log
StandardError=append:${PROJECT_PATH}/logs/nanoclaw.error.log
Environment=HOME=${HOME}
Environment=PATH=/usr/local/bin:/usr/bin:/bin:${HOME}/.local/bin

[Install]
WantedBy=multi-user.target
EOF"

mkdir -p logs
sudo systemctl daemon-reload
sudo systemctl enable nanoclaw
sudo systemctl start nanoclaw
```

Verify it's running:
```bash
sleep 2 && sudo systemctl status nanoclaw --no-pager
```

## 10. Test

Tell the user:
> Send `@ASSISTANT_NAME hello` in your registered chat.

Check the logs:
```bash
tail -f logs/nanoclaw.log
```

## Troubleshooting

**Service not starting**: Check `logs/nanoclaw.error.log` or `sudo journalctl -u nanoclaw`

**VM fails to boot**:
- Check /dev/kvm access: `ls -la /dev/kvm`
- Check rootfs exists: `ls -la /opt/firecracker/agent-rootfs.ext4`
- Check bridge exists: `ip link show fcbr0`
- Check VM logs: `cat groups/main/logs/firecracker-*.log | tail -50`

**No response to messages**:
- Verify the trigger pattern matches
- Check that the chat JID is in `data/registered_groups.json`
- Check `logs/nanoclaw.log` for errors

**WhatsApp disconnected**:
- Run `npm run auth` to re-authenticate
- Restart: `sudo systemctl restart nanoclaw`

**Restart service**:
```bash
sudo systemctl restart nanoclaw
```
