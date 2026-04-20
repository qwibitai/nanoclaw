# DigitalOcean Droplet Sizing Reference

## Droplet Size Recommendations

| Slug | vCPU | RAM | Storage | Concurrent Agents | Recommended Users | Notes |
|------|------|-----|---------|-------------------|-------------------|-------|
| `s-1vcpu-2gb` | 1 | 2 GB | 50 GB SSD | 2 | 1–5 | Development/testing only. Not suitable for production. |
| `s-2vcpu-4gb` | 2 | 4 GB | 80 GB SSD | 5 | Up to 15 | Minimum production size. Suitable for small teams. Set `MAX_CONCURRENT_CONTAINERS=5`. |
| `s-4vcpu-8gb` | 4 | 8 GB | 160 GB SSD | 15 | Up to 30 | Recommended for company assistants. Set `MAX_CONCURRENT_CONTAINERS=15`. |
| `s-8vcpu-16gb` | 8 | 16 GB | 320 GB SSD | 30 | Up to 60 | High-load deployments. Set `MAX_CONCURRENT_CONTAINERS=30`. |
| `s-8vcpu-32gb` | 8 | 32 GB | 400 GB SSD | 40 | 60+ | Large organizations with heavy concurrent usage. |

### How to Choose

Each concurrent agent container uses roughly 200–300 MB of RAM under typical load. Add ~1 GB overhead for the NanoClaw host process, Docker daemon, and the OS. The formula:

```
MAX_CONCURRENT_CONTAINERS ≈ (RAM_GB - 1) * 3
```

For example, an 8 GB droplet: `(8 - 1) * 3 = 21` — round down to `15` for a comfortable margin.

The `s-4vcpu-8gb` droplet is the recommended starting point for company deployments. It costs approximately $48/month on DigitalOcean (check current pricing at https://www.digitalocean.com/pricing/droplets).

## Maintenance Commands

### Log Rotation

The bootstrap script configures logrotate for `nanoclaw/logs/`. Manual rotation:

```bash
# Force rotate all NanoClaw logs now
logrotate -f /etc/logrotate.d/nanoclaw
```

Check current log sizes before deciding whether to rotate:

```bash
du -sh nanoclaw/logs/*
```

### Disk Space

Monitor disk usage — container images and session data accumulate over time:

```bash
# Overall disk usage
df -h /

# Docker image and container space
docker system df

# NanoClaw data directories
du -sh nanoclaw/logs/ nanoclaw/groups/ nanoclaw/store/
```

Prune unused Docker images and stopped containers:

```bash
docker system prune -f
```

### Backup

Back up the SQLite database and session data before upgrades:

```bash
# Back up the message database
cp nanoclaw/store/messages.db nanoclaw/store/messages.db.bak

# Back up all group data (memory, logs, sessions)
tar -czf nanoclaw-groups-$(date +%Y%m%d).tar.gz nanoclaw/groups/

# Back up credentials and config
cp nanoclaw/.env nanoclaw/.env.bak
```

Restore from backup:

```bash
cp nanoclaw/store/messages.db.bak nanoclaw/store/messages.db
tar -xzf nanoclaw-groups-<date>.tar.gz
```

### Service Management

```bash
# Check service status
systemctl --user status nanoclaw

# Restart after config change
systemctl --user restart nanoclaw

# View recent logs
journalctl --user -u nanoclaw -n 50

# Tail live logs
tail -f nanoclaw/logs/nanoclaw.log
```

### Upgrading NanoClaw

```bash
# Pull latest changes from upstream
cd nanoclaw
git fetch upstream
git merge upstream/main

# Rebuild after upgrade
npm install && npm run build

# Rebuild the agent container
./container/build.sh

# Restart the service
systemctl --user restart nanoclaw
```

For large upstream upgrades (new dependencies, breaking changes), use the `/update-nanoclaw` skill on the local machine to preview and selectively apply changes before merging.

### DigitalOcean Firewall

The bootstrap script configures `ufw` to allow SSH only. All NanoClaw channels use outbound WebSocket connections — no inbound ports are needed beyond SSH.

Verify the firewall rules:

```bash
ufw status verbose
```

Expected output: allow SSH (port 22) inbound, deny all other inbound, allow all outbound.

If a channel requires inbound connectivity in the future (e.g. a webhook-based channel), open the specific port:

```bash
ufw allow 443/tcp comment "https webhook"
```
