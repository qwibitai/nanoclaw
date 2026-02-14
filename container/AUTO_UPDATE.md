# NanoClaw Auto-Update

This document describes how NanoClaw instances can automatically update themselves with the latest code.

## Overview

The auto-update system allows running NanoClaw instances to:
1. Pull the latest code from the repository
2. Rebuild the container image
3. Restart the service with the new code

## Manual Update

Run the auto-update script on the host machine:

```bash
cd /path/to/nanoclaw
./container/auto-update.sh
```

The script will:
- Check for updates on the current branch
- Pull latest changes if available
- Rebuild the Docker container
- Restart the service (docker-compose or systemd)

## Automated Updates

### Option 1: Cron Job (Recommended)

Add a cron job to check for updates periodically:

```bash
# Edit crontab
crontab -e

# Add entry to check for updates every 6 hours
0 */6 * * * /path/to/nanoclaw/container/auto-update.sh >> /var/log/nanoclaw-update.log 2>&1
```

### Option 2: Systemd Timer

Create a systemd timer unit:

```ini
# /etc/systemd/system/nanoclaw-update.timer
[Unit]
Description=NanoClaw Auto-Update Timer
Requires=nanoclaw-update.service

[Timer]
OnCalendar=*-*-* 00,06,12,18:00:00
Persistent=true

[Install]
WantedBy=timers.target
```

```ini
# /etc/systemd/system/nanoclaw-update.service
[Unit]
Description=NanoClaw Auto-Update Service
After=network.target

[Service]
Type=oneshot
ExecStart=/path/to/nanoclaw/container/auto-update.sh
User=your-user
StandardOutput=journal
StandardError=journal
```

Enable the timer:

```bash
sudo systemctl daemon-reload
sudo systemctl enable nanoclaw-update.timer
sudo systemctl start nanoclaw-update.timer
```

### Option 3: From Within Container

NanoClaw agents can trigger updates by running:

```bash
# On the host (via SSH or API)
ssh host-machine "/path/to/nanoclaw/container/auto-update.sh"
```

Or using the `delegate_task` MCP tool to request updates from the local agent.

## Environment Variables

The auto-update script supports these environment variables:

- `NANOCLAW_SERVICE`: Name of the systemd service (default: `nanoclaw`)

## Safety Features

The script includes several safety features:

1. **Stash Protection**: Local changes are automatically stashed before update
2. **Version Check**: Only updates if remote has newer commits
3. **Error Handling**: Exits on any error (set -e)
4. **Container Check**: Prevents running inside container

## Go Installation

The updated Dockerfile now includes Go (version 1.25.0) with the following setup:

- **Go binary**: `/usr/local/go/bin/go`
- **GOPATH**: `/home/bun/go`
- **Go modules**: Enabled by default

### Using Go in Agents

Agents can now use Go for:
- Building Go projects (`go build`, `go run`)
- Installing Go tools (`go install`)
- Running Go programs

Example:
```bash
# Check Go version
go version

# Build a Go project
cd /workspace/group/my-go-project
go build -o myapp

# Install a Go tool
go install github.com/some/tool@latest
```

## Rollback

If an update causes issues, rollback to the previous version:

```bash
cd /path/to/nanoclaw

# Find the previous working commit
git log --oneline -5

# Revert to previous commit
git reset --hard <previous-commit>

# Rebuild container with rolled-back code
cd container
./build.sh latest

# Or use auto-update.sh (will detect "no updates" but rebuild anyway)
# cd ..
# ./container/auto-update.sh

# Restart instances manually or via docker-compose/systemd
```

The auto-update script will detect that there are no remote updates (since you've
rolled back locally), but the container will still be rebuilt with the current
(rolled-back) code state.

## Monitoring

Check update logs:

```bash
# If using cron
tail -f /var/log/nanoclaw-update.log

# If using systemd
journalctl -u nanoclaw-update.service -f
```

## Troubleshooting

### Update Script Fails

1. Check Git status: `git status`
2. Check Docker status: `docker ps`
3. Check logs: `docker logs <container-name>`

### Service Not Restarting

1. Verify service name: `systemctl list-units | grep nanoclaw`
2. Check service status: `systemctl status nanoclaw`
3. Manually restart: `docker-compose restart` or `systemctl restart nanoclaw`

### Container Build Fails

1. Check Dockerfile syntax
2. Ensure internet connection for package downloads
3. Check disk space: `df -h`

## Security Considerations

- The auto-update script requires host access (cannot run in container)
- Uses the current branch (doesn't switch branches automatically)
- Requires appropriate permissions for Docker and Git operations
- Consider using signed commits for production deployments
