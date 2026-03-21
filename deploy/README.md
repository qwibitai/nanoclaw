# Deploy NanoClaw + EasyBits

## Provider: DigitalOcean

**Cost**: ~$12 USD/month (s-1vcpu-2gb droplet in sfo3)

> **Note**: We first attempted Oracle Cloud Always Free (ARM A1.Flex in mx-queretaro-1). Both ARM and x86 Micro shapes returned "Out of host capacity" — the region was fully saturated. Oracle free tier ARM capacity is lottery-based; QRO is a small region with limited availability. Switching regions requires subscription and free tier is locked to home region. We moved to DigitalOcean for reliability.

## Prerequisites

- `doctl` authenticated (`doctl auth init`)
- SSH key registered in DigitalOcean
- Anthropic API key
- EasyBits API key

## Deploy

```bash
./deploy/deploy.sh
```

The script will:
- Create a droplet (1 vCPU, 2GB RAM, Ubuntu 24.04) in sfo3
- Install Docker, Node.js 22, clone repo, build everything
- Ask for your API keys and write `.env`
- Open an interactive session for WhatsApp QR scan
- Start the systemd service

## Post-Deploy: WhatsApp QR Code

Baileys 7.x deprecated `printQRInTerminal`. NanoClaw's default behavior is to `process.exit(1)` when a QR is needed (designed for local `/setup` skill).

For remote/headless servers, patch `src/channels/whatsapp.ts` before building:

```typescript
// Add import at top:
import qrcode from 'qrcode-terminal';

// Replace the if (qr) block (~line 87):
if (qr) {
  logger.info('Scan this QR code with WhatsApp:');
  qrcode.generate(qr, { small: true });
}
```

Then rebuild: `npm run build`

Run `node dist/index.js` interactively, scan the QR with WhatsApp → Linked Devices → Link a Device. Once connected, Ctrl+C and start the systemd service.

## Post-Deploy: Register a Group

NanoClaw starts with `groupCount: 0` and won't respond to any messages until you register a group.

1. Send a message in your WhatsApp group so NanoClaw detects it
2. Find the group JID:
   ```bash
   sqlite3 store/messages.db "SELECT jid, name FROM chats WHERE is_group = 1;"
   ```
3. Register it:
   ```bash
   sqlite3 store/messages.db "INSERT INTO registered_groups (jid, name, folder, trigger_pattern, added_at, requires_trigger) VALUES ('<JID>', '<GROUP_NAME>', 'main', '^@ghosty\b', '$(date -u +%Y-%m-%dT%H:%M:%SZ)', 0);"
   ```
4. Restart: `systemctl restart nanoclaw`
5. Verify: `journalctl -u nanoclaw | grep groupCount` should show `groupCount: 1`

## .env Configuration

```bash
ANTHROPIC_API_KEY=sk-ant-...
EASYBITS_API_KEY=eb_sk_live_...
ASSISTANT_NAME=ghosty          # Changes trigger from @Andy to @ghosty
```

**Important**: The database file is `store/messages.db` (NOT `store/nanoclaw.db`).

## Management

```bash
# SSH into droplet
ssh root@<DROPLET_IP>

# Logs
journalctl -u nanoclaw -f

# Restart
systemctl restart nanoclaw

# Stop
systemctl stop nanoclaw

# Tear down
doctl compute droplet delete nanoclaw-prod
```
