# Multi-Tenant NanoClaw

Run multiple NanoClaw instances on a single VM with full container isolation.

## Architecture

Each tenant gets:
- A unique `INSTANCE_ID` that prefixes all container names
- Scoped orphan cleanup (one tenant's restart doesn't kill another's containers)
- Optional per-tenant resource limits (CPU, memory, PIDs)
- Rootless Docker auto-detection for filesystem isolation

## Configuration

### INSTANCE_ID (required for multi-tenant)

Each instance **must** have a unique `INSTANCE_ID`. If unset, defaults to the OS username.

```bash
# In each tenant's .env or systemd environment
INSTANCE_ID=tenant-alice
```

Container names become: `nanoclaw-tenant-alice-{group}-{timestamp}`

The ID is sanitized: non-alphanumeric characters (except `-` and `_`) are stripped, and it's capped at 32 characters.

### Resource Limits (optional)

Constrain how much of the host each tenant's containers can consume:

```bash
CONTAINER_CPUS=1          # Max CPU cores (e.g., "0.5", "2")
CONTAINER_MEMORY=512m     # Max memory (e.g., "256m", "1g")
CONTAINER_PIDS_LIMIT=256  # Max processes inside container
```

All default to empty (no limit), preserving current behavior.

### Rootless Docker

When Docker is running in rootless mode, NanoClaw automatically:
- Detects the per-user Docker socket (`$XDG_RUNTIME_DIR/docker.sock` or `/run/user/{uid}/docker.sock`)
- Maps it to `/var/run/docker.sock` inside the container (agent code works unchanged)
- Skips `--group-add` (unnecessary in rootless mode since the socket is user-owned)

No configuration needed — detection is automatic.

## Tenant Provisioning

### 1. Create OS user (recommended)

Separate OS users provide filesystem isolation beyond Docker:

```bash
sudo useradd -m -s /bin/bash tenant-alice
```

### 2. Clone NanoClaw

```bash
sudo -u tenant-alice bash -c '
  cd ~
  git clone https://github.com/your-fork/nanoclaw.git
  cd nanoclaw
  npm install
  npm run build
  ./container/build.sh
'
```

### 3. Configure environment

```bash
sudo -u tenant-alice bash -c '
  cd ~/nanoclaw
  cat > .env << EOF
INSTANCE_ID=tenant-alice
CONTAINER_CPUS=1
CONTAINER_MEMORY=512m
CONTAINER_PIDS_LIMIT=256
ANTHROPIC_API_KEY=sk-ant-...
EOF
'
```

### 4. Set up systemd service

Create `/etc/systemd/system/nanoclaw@.service` (template unit):

```ini
[Unit]
Description=NanoClaw instance for %i
After=network.target docker.service

[Service]
Type=simple
User=%i
WorkingDirectory=/home/%i/nanoclaw
ExecStart=/usr/bin/node dist/index.js
Restart=on-failure
RestartSec=10
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
```

Enable and start:

```bash
sudo systemctl enable nanoclaw@tenant-alice
sudo systemctl start nanoclaw@tenant-alice
```

### 5. Rootless Docker per tenant (recommended)

For full isolation, install rootless Docker for each tenant:

```bash
sudo -u tenant-alice bash -c 'dockerd-rootless-setuptool.sh install'
sudo loginctl enable-linger tenant-alice
```

## Monitoring

### List containers for a specific tenant

```bash
docker ps --filter name=nanoclaw-tenant-alice-
```

### List all NanoClaw containers across tenants

```bash
docker ps --filter name=nanoclaw-
```

The `sup` diagnostics script shows all instances' containers.

### Startup logs

Each instance logs its identity at startup:

```
{"instanceId":"tenant-alice","containerPrefix":"nanoclaw-tenant-alice","msg":"Instance identity"}
```

## Security Notes

- **Same INSTANCE_ID = shared containers**: Two instances with the same ID will kill each other's containers on startup. Always use unique IDs.
- **Separate OS users**: Without separate users, tenants share the same filesystem. Use per-user home directories for true isolation.
- **Mount allowlists**: Each tenant's `~/.config/nanoclaw/mount-allowlist.json` controls what host paths their containers can access.
- **Rootless Docker**: Eliminates Docker-group-equals-root escalation. Each tenant's Docker daemon runs as their own user.
