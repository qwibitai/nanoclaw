# NanoClaw — DigitalOcean Deployment Runbook

NanoClaw runs on a single DigitalOcean droplet as a systemd user service managed by Claude Code. This deployment targets a ~30-person team using Slack and Telegram channels, with identity-aware routing and isolated per-group memory. All channel connections use outbound WebSockets — no public ingress required.

## Droplet Sizing

| Size | RAM | vCPU | Max concurrent agents | Recommended for |
|------|-----|------|----------------------|-----------------|
| `s-2vcpu-4gb` | 4 GB | 2 | 5 | Dev/testing only |
| `s-4vcpu-8gb` | 8 GB | 4 | 15 | Up to 30 users (recommended) |
| `s-8vcpu-16gb` | 16 GB | 8 | 30 | High-load / future growth |

Set `MAX_CONCURRENT_CONTAINERS` in `nanoclaw/.env` to match the chosen size. Formula: `(RAM_GB - 1) * 3`, rounded down for margin. (Apply ~30% reduction for safety margin; table values already include this.)

## Initial Setup

Run `/deploy-digitalocean` in Claude Code. The skill handles droplet provisioning (via `doctl`), Node.js 22 + Docker install, firewall configuration, OneCLI credential vault setup, systemd user service install, and channel configuration. The skill is idempotent — re-running from any failed step is safe.

## Service Management (Linux systemd)

```bash
# Status
systemctl --user status nanoclaw

# Restart
systemctl --user restart nanoclaw

# Stop / Start
systemctl --user stop nanoclaw
systemctl --user start nanoclaw

# View logs (live)
journalctl --user -u nanoclaw -f

# View log file
tail -f ~/nanoclaw/logs/nanoclaw.log
```

`loginctl enable-linger` is set during initial setup so the user service remains active after SSH logout.

## Upgrade Path

Run `/update-nanoclaw` in Claude Code. It:

1. Fetches upstream main and previews changes
2. Merges (with conflict resolution guidance if needed)
3. Runs `npm run build` and `npm test`

After the skill completes, run these manually:

```bash
./container/build.sh          # rebuild agent container image
systemctl --user restart nanoclaw
```

Run `/migrate-nanoclaw` if customizations need replaying on the new upstream base.

## Database Backup

NanoClaw state is stored in `~/nanoclaw/store/messages.db` (SQLite). Recommended: nightly snapshot.

```bash
# Manual backup
sqlite3 ~/nanoclaw/store/messages.db ".backup $HOME/nanoclaw/store/messages.db.$(date +%Y%m%d)"

# Cron job (add via crontab -e):
0 2 * * * sqlite3 ~/nanoclaw/store/messages.db ".backup $HOME/nanoclaw/store/messages.db.$(date +\%Y\%m\%d)" && find ~/nanoclaw/store/ -name 'messages.db.[0-9]*' -mtime +30 -delete

# Restore from backup
systemctl --user stop nanoclaw
cp ~/nanoclaw/store/messages.db.YYYYMMDD ~/nanoclaw/store/messages.db
systemctl --user start nanoclaw
```

## Log Management

Logrotate is configured by `scripts/bootstrap-droplet.sh` (daily rotation, 14-day retention, `copytruncate` — no service restart needed).

```bash
# Manual rotation
logrotate -f /etc/logrotate.d/nanoclaw

# Check disk usage
du -sh ~/nanoclaw/logs/
du -sh ~/nanoclaw/data/sessions/
```

Clean up old session data (safe while running):

```bash
bash ~/nanoclaw/scripts/cleanup-sessions.sh
```

## Firewall

UFW is configured by `scripts/bootstrap-droplet.sh`:

- Inbound: SSH (22/tcp) only
- Outbound: all allowed
- Slack, Telegram, WhatsApp, and Discord channels use outbound WebSockets — no inbound ports required

```bash
# Check status
ufw status verbose
```

To open an inbound port for a future webhook-based channel:

```bash
ufw allow 443/tcp comment "https webhook"
```

## Troubleshooting

Run `/debug` in Claude Code for container-level issues. Check `~/nanoclaw/logs/nanoclaw.log` and `~/nanoclaw/logs/nanoclaw.error.log` for application errors.

For a service that will not start:

```bash
systemctl --user status nanoclaw
journalctl --user -u nanoclaw --no-pager -n 50
```

For credential errors, verify OneCLI secrets are registered:

```bash
onecli secrets list
grep ONECLI_URL ~/nanoclaw/.env
```
