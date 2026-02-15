# NanoClaw OS — Backup & Restore

## What Is Backed Up

| Item | Location | Purpose |
|------|----------|---------|
| SQLite DB | `store/messages.db` | All governance state (7 tables) |
| Sanitized .env | `.env` (values redacted) | Config structure reference |
| version.json | Generated | OS version + git commit SHA |
| manifest.json | Generated | File list with sizes |

**Not backed up:** Container runtime state, group session data (ephemeral), raw secrets.

## Backup Procedure

```bash
npm run ops:backup
```

Creates: `backups/os-backup-YYYYMMDD-HHMM.tar.gz` + `.sha256` hash file.

**How it works:**
1. Atomic SQLite snapshot via `VACUUM INTO` (consistent point-in-time)
2. `.env` sanitized (all values replaced with `***REDACTED***`)
3. `version.json` written with OS version and git commit SHA
4. `manifest.json` lists all files with sizes
5. Archived as `.tar.gz`
6. SHA256 hash computed and written alongside

## Restore Procedure

```bash
# Preview (will refuse if DB exists)
npm run ops:restore -- backups/os-backup-20260215-1200.tar.gz

# Force overwrite
npm run ops:restore -- backups/os-backup-20260215-1200.tar.gz --force
```

**How it works:**
1. Verifies SHA256 hash if `.sha256` file exists
2. Refuses to overwrite existing DB without `--force`
3. Extracts to temp directory, validates manifest + DB presence
4. Copies DB to `store/messages.db`
5. Prints version info from backup

## Verification

After restore, verify:
```bash
npm run ops:status   # Check task counts, products, ext_calls
npm run test         # Run full test suite (uses :memory: DB, won't affect restored data)
```

## Disaster Recovery Drill

1. Create a backup: `npm run ops:backup`
2. Note current task counts from `npm run ops:status`
3. Stop the service
4. Delete `store/messages.db`
5. Restore: `npm run ops:restore -- backups/<latest>.tar.gz`
6. Start the service
7. Verify task counts match pre-backup state
8. Verify dispatch loop resumes without duplicates
