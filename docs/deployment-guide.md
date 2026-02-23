# NanoClaw — Deployment Guide

## Overview

NanoClaw runs as a single Node.js background process (`src/index.ts`) managed by:
- **macOS**: `launchd` (via `~/Library/LaunchAgents/com.nanoclaw.plist`)
- **Linux**: `systemd` (user service `nanoclaw.service`)
- **WSL** (fallback): `nohup` via generated `start-nanoclaw.sh`

The container agent runs as a Docker (or Apple Container) subprocess spawned on demand — no persistent daemon.

---

## Prerequisites

| Component | Requirement |
|-----------|-------------|
| Node.js | ≥ 20 (22 recommended) |
| Docker | Latest stable (or Apple Container on macOS) |
| SQLite | Bundled via `better-sqlite3` (no separate install) |
| WhatsApp auth | `store/auth/` — obtained via `npm run auth` |
| `.env` | `ANTHROPIC_API_KEY` or `CLAUDE_CODE_OAUTH_TOKEN` |

---

## Initial Deployment

Use the setup wizard for first-time deployment:

```bash
npm run setup
# or: /setup skill in Claude Code
```

The setup wizard handles:
1. Node.js and dependency verification
2. Container runtime check (Docker / Apple Container)
3. Claude API key configuration
4. WhatsApp authentication
5. Group registration
6. Mount allowlist configuration
7. Service installation and start

---

## Service Management

### macOS (launchd)

```bash
# Install and start
launchctl load ~/Library/LaunchAgents/com.nanoclaw.plist

# Stop
launchctl unload ~/Library/LaunchAgents/com.nanoclaw.plist

# Restart
launchctl kickstart -k gui/$(id -u)/com.nanoclaw

# Check status
launchctl list | grep nanoclaw
```

Logs:
- `logs/nanoclaw.log` — application output
- `logs/nanoclaw.error.log` — stderr

### Linux (systemd user service)

```bash
# Start
systemctl --user start nanoclaw

# Stop
systemctl --user stop nanoclaw

# Restart
systemctl --user restart nanoclaw

# Status
systemctl --user status nanoclaw

# Enable on login
systemctl --user enable nanoclaw

# View logs
journalctl --user -u nanoclaw -f
```

### WSL (fallback)

If systemd is not available, use the generated wrapper:

```bash
bash start-nanoclaw.sh
```

To enable systemd in WSL (persistent solution):
```bash
echo -e "[boot]\nsystemd=true" | sudo tee /etc/wsl.conf
# Then restart WSL
```

---

## Environment Configuration

### `.env` file (project root)

```bash
# Required: one of these
ANTHROPIC_API_KEY=sk-ant-...
CLAUDE_CODE_OAUTH_TOKEN=...

# Optional
ASSISTANT_NAME=Andy          # Trigger name (default: Andy)
```

### Mount allowlist

Location: `~/.config/nanoclaw/mount-allowlist.json`

This file lives **outside** the project root for tamper safety. It controls which host directories containers can mount (read-only or read-write).

```json
{
  "allowedRoots": [
    { "path": "/home/user/documents", "permission": "readonly" },
    { "path": "/home/user/projects", "permission": "readwrite" }
  ],
  "blockedPatterns": [".ssh", ".gnupg", ".aws", ".env"],
  "nonMainReadOnly": true
}
```

Default blocked patterns: `.ssh`, `.gnupg`, `.aws`, `.netrc`, `.npmrc`, `.pypirc`, `.docker`, `.kube`, `.azure`, `.gcloud`.

---

## Container Runtime

### Docker (default)

```bash
# Verify running
docker info

# Build image
./container/build.sh

# View running containers
docker ps --filter name=nanoclaw

# Cleanup orphaned containers
# (handled automatically by cleanupOrphans() on startup)
```

### Apple Container (macOS only)

Switch runtime using the `/convert-to-apple-container` skill. This modifies `src/container-runtime.ts` to use the `container` binary instead of `docker`.

```bash
# Verify running
container system status

# Start if stopped
container system start
```

---

## File System Layout (Production)

```
/project-root/
├── dist/                    # Compiled orchestrator (npm run build)
├── store/
│   ├── messages.db          # SQLite database (all state)
│   └── auth/                # WhatsApp auth (do NOT delete)
├── groups/
│   └── {name}/              # Per-group isolated filesystems
│       ├── CLAUDE.md        # Agent memory (editable)
│       └── logs/            # Container run logs
├── data/
│   └── ipc/                 # IPC bridge files (volatile)
├── logs/
│   ├── nanoclaw.log         # Application logs
│   └── nanoclaw.error.log   # Error logs
└── .env                     # Secrets (never commit)
```

---

## Updating

Use the `/update` skill to pull upstream changes:

```bash
# In Claude Code
/update
```

This:
1. Fetches upstream NanoClaw changes
2. Merges with your customizations
3. Runs any schema migrations
4. Rebuilds the container image

Manual update:
```bash
git pull upstream main
npm install
npm run build
./container/build.sh
# Then restart the service
```

---

## Backup and Recovery

### Backup

Critical files to back up:
```bash
store/auth/        # WhatsApp session — losing this requires re-auth
store/messages.db  # All messages and task state
.env               # API keys
groups/*/CLAUDE.md # Agent memories
~/.config/nanoclaw/mount-allowlist.json
```

### Restore WhatsApp session

If `store/auth/` is lost, re-run:
```bash
npm run auth
```

The bot will appear online from a new browser session. No impact on registered groups or tasks (stored in SQLite).

### Database reset

```bash
# Full reset (lose all messages and tasks)
rm store/messages.db
# Re-register groups via /setup
```

---

## Troubleshooting

| Symptom | Check |
|---------|-------|
| Service not starting | `logs/nanoclaw.error.log` — wrong Node path or missing `.env` |
| Container fails (exit code 1) | Container runtime not running — start Docker/Apple Container |
| No response to messages | Check trigger pattern; check `logs/nanoclaw.log`; run `npm run setup -- --step verify` |
| WhatsApp disconnected | `npm run auth`, then rebuild + restart |
| Docker group permissions (Linux) | `sudo setfacl -m u:$(whoami):rw /var/run/docker.sock` |

Full debug guide: `/debug` skill in Claude Code.
