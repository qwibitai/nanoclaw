# add-backup

Automated backup and restore for NanoClaw state data.

## What's Backed Up

| Path | Contents |
|------|----------|
| `store/messages.db` | SQLite: chats, messages, scheduled tasks |
| `groups/` | Per-group memories, logs (secrets excluded) |
| `data/sessions/` | Claude session data, projects |
| `data/ipc/` | Task state, group metadata |

Secrets (`.env`, `.secrets/`, `*.keys.json`, etc.) are always excluded.

## Files

```
add-backup/
├── SKILL.md              # Setup wizard (4 phases), usage, troubleshooting
├── README.md             # This file
├── scripts/
│   └── backup.sh         # Backup script (copied to ~/backup-nanoclaw during setup)
└── docs/
    └── guide-backup-restore.md  # Step-by-step restore guide
```

## Features

- **Safe SQLite backups** — uses `sqlite3` backup API, no corruption from concurrent writes
- **Log rotation** — auto-truncates to 1000 lines
- **Integrity verification** — SHA-256 checksums generated after each backup
- **Multiple auth methods** — SSH deploy key, GitHub PAT, or local-only (no remote)
- **Secret protection** — `.gitignore`, pre-commit hook, and rsync exclusion patterns
- **Channel-agnostic** — works with any NanoClaw channel configuration
- **Configurable** — custom backup directory, branch, and cron schedule

## Usage

Set up via the `/add-backup` skill, then run manually or via cron:

```bash
~/backup-nanoclaw/backup.sh          # Run backup
~/backup-nanoclaw/backup.sh --dry-run  # Preview only
```

See `SKILL.md` for the full setup wizard.
