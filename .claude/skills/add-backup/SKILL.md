---
name: add-backup
description: Add automated backup/restore for NanoClaw state data. Backs up messages.db, groups, sessions, and IPC state to a local git repo with optional remote push. Secrets are always excluded.
---

# Add Backup

Set up automated backups for NanoClaw state data (messages, groups, sessions, IPC). Backups are stored in a separate local git repo with optional push to a private remote.

## What Gets Backed Up

| Path | Contents |
|------|----------|
| `store/messages.db` | SQLite: chats, messages, scheduled tasks |
| `groups/` | Per-group memories, logs (secrets excluded) |
| `data/sessions/` | Claude session data, projects |
| `data/ipc/` | Task state, group metadata |

**Always excluded:** `.env`, `.secrets/`, `*.keys.json`, `*recovery*.txt`, `*password*.txt`

## Phase 1: Pre-flight

### Check for existing setup

```bash
test -d ~/backup-nanoclaw && echo "EXISTS" || echo "NOT_FOUND"
test -f ~/backup-nanoclaw/backup.sh && echo "SCRIPT_EXISTS" || echo "NO_SCRIPT"
crontab -l 2>/dev/null | grep -q "backup.sh" && echo "CRON_EXISTS" || echo "NO_CRON"
```

If all three exist, backup is already configured. Ask the user: "Backup is already set up at `~/backup-nanoclaw`. Would you like to reconfigure?" If no, skip to Phase 4 (Verify) to run a dry-run.

### Detect authentication

Check in order:

1. **SSH**: `ssh -T git@github.com 2>&1` — if output contains "successfully authenticated", SSH works
2. **Token**: `test -n "$GITHUB_TOKEN"` or `test -n "$GH_TOKEN"`
3. **Backup config**: If `~/backup-nanoclaw/.env` exists, source it and check for `GITHUB_TOKEN`
4. **None detected** — will ask user in Phase 2

### Check for sqlite3

```bash
command -v sqlite3 && echo "OK" || echo "MISSING"
```

If missing, install it:
```bash
# Linux
sudo apt-get install -y sqlite3
# macOS
brew install sqlite3
```

## Phase 2: Setup

### Ask user for configuration

Ask these questions (with sensible defaults):

1. **Backup directory** — default `~/backup-nanoclaw`
2. **Remote repository URL** — optional, e.g. `git@github.com:user/nanoclaw-backup.git` (leave blank for local-only)
3. **Branch name** — default `main`
4. **Backup schedule** — default daily at midnight

### Ask about authentication (only if none detected in Phase 1)

Offer three options:

1. **SSH deploy key** — generate a dedicated key, user adds it to GitHub as a deploy key with write access
2. **GitHub PAT** — user generates a token at `https://github.com/settings/tokens` with `repo` scope
3. **Local only** — no remote push, backups stay on disk

### Copy backup script

```bash
mkdir -p ~/backup-nanoclaw
cp "${CLAUDE_SKILL_DIR}/scripts/backup.sh" ~/backup-nanoclaw/backup.sh
chmod +x ~/backup-nanoclaw/backup.sh
```

### Initialize git repo

```bash
cd ~/backup-nanoclaw
git init -q
```

### Configure remote (if user provided URL)

```bash
cd ~/backup-nanoclaw
git remote add origin <user-provided-url>
```

### If SSH deploy key needed

Generate a dedicated key for backup push:

```bash
ssh-keygen -t ed25519 -C "nanoclaw-backup" -f ~/backup-nanoclaw/.ssh/deploy_key -N ""
```

Display the public key and instruct the user to add it as a deploy key with write access on their GitHub repo: **Settings → Deploy keys → Add deploy key → paste public key → check "Allow write access"**.

Configure SSH to use the deploy key by adding to `~/.ssh/config`:

```
Host github-backup
  HostName github.com
  IdentityFile ~/backup-nanoclaw/.ssh/deploy_key
  IdentitiesOnly yes
```

If using a custom SSH config host, set the remote URL accordingly: `git remote set-url origin git@github-backup:user/repo.git`

### Write config file

Create `~/backup-nanoclaw/.env`:

```bash
NANOCLAW_DIR=$HOME/nanoclaw
BRANCH=main
```

If using token auth, also add:
```bash
GITHUB_TOKEN=ghp_...
```

If using SSH deploy key, no token is needed (SSH config handles auth).

### Install pre-commit hook

The script installs this automatically on first run. It blocks secret files from being committed.

## Phase 3: Configure

### Set up cron job

Add to crontab (replacing any existing backup entry to prevent duplicates):

```bash
(crontab -l 2>/dev/null | grep -v "backup.sh"; echo "0 0 * * * $HOME/backup-nanoclaw/backup.sh >> $HOME/backup-nanoclaw/backup.log 2>&1") | crontab -
```

Default: daily at midnight. Adjust the cron expression if user chose a different schedule:
- Every 6 hours: `0 */6 * * *`
- Every 12 hours: `0 */12 * * *`
- Weekly: `0 0 * * 0`

### Verify cron

```bash
crontab -l | grep "backup.sh"
```

## Phase 4: Verify

### Dry-run

```bash
~/backup-nanoclaw/backup.sh --dry-run
```

Expected: `[WOULD]` entries for each data path, no files copied.

### Full run

```bash
~/backup-nanoclaw/backup.sh
```

Expected: files copied, git commit created, checksums generated.

### Verify no secrets leaked

```bash
grep -r "ANTHROPIC_API_KEY\|CLAUDE_CODE_OAUTH_TOKEN\|TELEGRAM_BOT_TOKEN\|SLACK_BOT_TOKEN" ~/backup-nanoclaw/ --include="*.md" --include="*.json" --include="*.ts" || echo "CLEAN"
```

### Verify backup contents

```bash
ls ~/backup-nanoclaw/store/
ls ~/backup-nanoclaw/groups/
ls ~/backup-nanoclaw/data/
```

### Test push (if remote configured)

```bash
cd ~/backup-nanoclaw && git push -u origin main
```

## Usage

```bash
# Run backup manually
~/backup-nanoclaw/backup.sh

# Dry-run (preview only)
~/backup-nanoclaw/backup.sh --dry-run

# Custom backup directory
~/backup-nanoclaw/backup.sh /tmp/test-backup

# Check backup size
du -sh ~/backup-nanoclaw/

# Verify integrity against checksums
cd ~/backup-nanoclaw && sha256sum -c .checksums | tail -1

# View backup history
cd ~/backup-nanoclaw && git log --oneline
```

## Restore

See `${CLAUDE_SKILL_DIR}/docs/guide-backup-restore.md` for the full restore procedure.

Quick restore:
```bash
cp ~/backup-nanoclaw/store/messages.db ~/nanoclaw/store/
rsync -a ~/backup-nanoclaw/groups/ ~/nanoclaw/groups/
rsync -a ~/backup-nanoclaw/data/sessions/ ~/nanoclaw/data/sessions/
rsync -a ~/backup-nanoclaw/data/ipc/ ~/nanoclaw/data/ipc/
# Then recreate .env from secrets manager and restart
```

## Troubleshooting

| Issue | Solution |
|-------|----------|
| `sqlite3 not installed` | `sudo apt-get install -y sqlite3` (Linux) or `brew install sqlite3` (macOS) |
| `Permission denied` on backup.sh | `chmod +x ~/backup-nanoclaw/backup.sh` |
| Push fails with auth error | Check token (`GITHUB_TOKEN` in `.env`) or SSH key (`ssh -T git@github.com`) |
| Push fails with 403 | Token needs `repo` scope — regenerate at GitHub settings |
| `No changes to commit` | Normal — state hasn't changed since last backup |
| Database locked during backup | The `sqlite3` backup API handles concurrent access. If it still fails, stop NanoClaw first |
| Backup too large | Check for accidental large files in `groups/*/` (attachments) |
| Cron not running | Check `crontab -l`, verify systemd cron is active (`systemctl status cron`) |
| Log file too large | Script auto-rotates to 1000 lines. Manual reset: `> ~/backup-nanoclaw/backup.log` |

## Removal

To stop automated backups, remove the cron job:

```bash
(crontab -l 2>/dev/null | grep -v "backup.sh") | crontab -
```

The backup directory (`~/backup-nanoclaw`) is not removed automatically. To delete it, run manually:

```bash
rm -rf ~/backup-nanoclaw
```
```
