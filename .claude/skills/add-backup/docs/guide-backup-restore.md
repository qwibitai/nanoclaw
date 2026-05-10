# NanoClaw State Backup & Restore Guide

Guide for backing up and restoring NanoClaw state data while keeping secrets secure.

## Overview

NanoClaw state consists of:
- **Database** — Messages, chats, scheduled tasks
- **Groups** — Per-group memories, attachments, conversation logs
- **Sessions** — Claude session data and projects
- **IPC State** — Current task state

**Important:** Secrets (API keys, tokens) are NOT backed up. Store them separately in a secrets manager.

## What to Backup

### Include (State Data)

| Path | Contents |
|------|----------|
| `store/messages.db` | SQLite: chats, messages, scheduled tasks |
| `groups/` | Per-group CLAUDE.md memories, attachments, logs |
| `data/sessions/` | Claude session data, projects, subagents |
| `data/ipc/` | Current task state, group metadata |

### Exclude (Secrets & Sensitive)

| Pattern | Why |
|---------|-----|
| `.env` | Contains API keys, tokens |
| `.secrets/` | Secret directories |
| `*.keys.json` | Key files |
| `*recovery*.txt` | Recovery codes |
| `*password*.txt` | Password files |

### Exclude (Rebuildable)

| Path | Why |
|------|-----|
| `node_modules/` | Rebuilt from package.json |
| `dist/` | Rebuilt from source |

## Restore Procedure

### 1. Verify Backup Integrity

```bash
cd $BACKUP_DIR
sha256sum -c .checksums
```

### 2. Fresh NanoClaw Installation

```bash
git clone https://github.com/qwibitai/nanoclaw.git
cd nanoclaw
npm install
npm run build
```

### 3. Restore State Data

```bash
NANOCLAW_DIR="$HOME/nanoclaw"
BACKUP_DIR="$HOME/backup-nanoclaw"

# Restore database
cp "$BACKUP_DIR/store/messages.db" "$NANOCLAW_DIR/store/"

# Restore groups
rsync -a "$BACKUP_DIR/groups/" "$NANOCLAW_DIR/groups/"

# Restore sessions
rsync -a "$BACKUP_DIR/data/sessions/" "$NANOCLAW_DIR/data/sessions/"

# Restore IPC state
rsync -a "$BACKUP_DIR/data/ipc/" "$NANOCLAW_DIR/data/ipc/"
```

### 4. Recreate Secrets

Create `.env` file with your credentials:

```bash
cp .env.example .env
# Edit .env with your secrets manager values
```

Required values:
- `ANTHROPIC_API_KEY` or `CLAUDE_CODE_OAUTH_TOKEN`
- `ANTHROPIC_BASE_URL` (if using custom endpoint)
- Channel tokens (`TELEGRAM_BOT_TOKEN`, `SLACK_BOT_TOKEN`, etc.)

### 5. Sync env to data

```bash
cp .env data/env/env
```

### 6. Restart Service

```bash
# Linux
systemctl --user restart nanoclaw

# macOS
launchctl kickstart -k gui/$(id -u)/com.nanoclaw
```

## Checklist

### After Backup
- [ ] Verify backup size is reasonable
- [ ] Check `git log` for commit
- [ ] Confirm no secrets in backup (`grep -r "API_KEY\|TOKEN"`)

### After Restore
- [ ] `.env` recreated with correct values
- [ ] `data/env/env` synced from `.env`
- [ ] Service starts successfully
- [ ] Groups and history accessible
