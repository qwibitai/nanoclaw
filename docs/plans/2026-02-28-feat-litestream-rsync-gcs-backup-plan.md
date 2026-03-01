---
title: "feat: Add Litestream and rsync backup to GCS"
type: feat
status: active
date: 2026-02-28
---

# Add Litestream and rsync Backup to GCS

## Enhancement Summary

**Deepened on:** 2026-02-28
**Sections enhanced:** 8
**Research agents used:** security-sentinel, deployment-verification-agent, architecture-strategist, performance-oracle, data-integrity-guardian, code-simplicity-reviewer, kieran-typescript-reviewer, pattern-recognition-specialist, best-practices-researcher (x2)

### Key Improvements

1. **Security hardening**: Bucket name validation, lock file relocation, `.env` exclusion from rsync, Prometheus endpoint removal
2. **Architectural simplification**: Remove retry loop (gcloud retries internally + timer retries every 15 min), remove flock (systemd oneshot prevents overlap), use include-list rsync instead of exclude-list
3. **Critical bug fixes**: Litestream doesn't expand `${SHELL_VARS}` in YAML -- use `envsubst` or hardcode; `LITESTREAM_ENABLED` must be on `nanoclaw.service` not `litestream.service`; restore.sh must backup DB before deletion
4. **Pattern consistency**: Move `LITESTREAM_ENABLED` to `config.ts` following existing env var patterns; generate systemd units via `setup/service.ts` instead of static files
5. **Data integrity**: Add WAL size watchdog with passive checkpoint fallback; export `db.close()` for graceful shutdown; document WhatsApp re-auth requirement after restore
6. **Multi-tenant infrastructure**: Pulumi-managed per-tenant GCS buckets in `stix/infra/` with `{project}-nanoclaw-{tenant}` naming convention, config-driven tenant list

### New Considerations Discovered

- `--exclude-name-pattern` uses Python `fnmatch` on filename only -- cannot match directory paths, reinforcing the need to sync specific directories
- `ExecStartPre` time counts against `TimeoutStartSec` (default 90s) -- large DB restores will timeout; set to 300s
- User-level systemd on GCE requires `loginctl enable-linger` or services stop when SSH session ends
- `Requires=` causes cascading failure if Litestream crashes -- `Wants=` is safer (NanoClaw keeps running, just without backup)
- `OnUnitInactiveSec=15min` is better than `OnCalendar=*:0/15` for backup timers -- measures from last completion, not wall clock
- Integrity check in restore.sh that deletes the DB on failure is dangerous -- you're deleting your only copy; better to warn and proceed

---

## Overview

Add continuous SQLite replication via Litestream and periodic file sync via `gcloud storage rsync` to back up all NanoClaw data to a GCS bucket. This ensures near-zero data loss for the database (~1 second RPO) and periodic backup of group files, auth tokens, and session data (~15 minute RPO).

## Problem Statement / Motivation

NanoClaw runs on a single GCE VM. If the VM dies, all data is lost -- messages, group memory (CLAUDE.md), WhatsApp auth tokens, scheduled tasks, and session state. There is no backup or disaster recovery mechanism today.

The goal is:
- **SQLite** (`store/messages.db`): Real-time WAL streaming to GCS via Litestream
- **Everything else** (`groups/`, `store/auth/`, `data/sessions/`): Periodic sync to GCS via `gcloud storage rsync`
- **Recovery**: Automated restore on VM provisioning or failure

## Proposed Solution

### Architecture

```
GCE VM
├── store/
│   ├── messages.db          ← Litestream → gs://bucket/litestream/messages.db
│   └── auth/                ← rsync → gs://bucket/rsync/store/auth/
├── groups/
│   ├── CLAUDE.md            ← rsync → gs://bucket/rsync/groups/
│   ├── main/
│   └── {group-name}/
└── data/
    └── sessions/            ← rsync → gs://bucket/rsync/data/sessions/
```

### Systemd Service Graph

```
                    litestream.service
                    (ExecStartPre: restore -if-db-not-exists -if-replica-exists)
                    (ExecStart: litestream replicate)
                           │
                    After= │
                           ▼
                    nanoclaw.service
                    (After=litestream.service, Wants=litestream.service)
                    (Environment=LITESTREAM_ENABLED=true)
                    (ExecStart: node dist/index.js)

                    nanoclaw-rsync.timer  ──triggers──▶  nanoclaw-rsync.service
                    (OnBootSec=5min, OnUnitInactiveSec=15min)  (Type=oneshot)
```

### Research Insights (Architecture)

**Best Practices:**
- Use `Wants=` instead of `Requires=` for the Litestream dependency. `Requires=` causes NanoClaw to stop if Litestream crashes, which is unnecessary -- NanoClaw can keep running without backup. `Wants=` ensures Litestream starts but doesn't cascade failure.
- `LITESTREAM_ENABLED=true` must be on `nanoclaw.service` (where the app reads it), not on `litestream.service` (which doesn't use it).
- Two-tier backup (Litestream for SQLite + rsync for files) is architecturally correct. SQLite requires WAL-aware replication; naive file copy of a live DB causes corruption.

**Simplification:**
- Remove `flock` from rsync script -- systemd `Type=oneshot` already prevents concurrent runs.
- Remove retry loop from rsync script -- `gcloud storage rsync` has built-in retry logic, and the timer retries every 15 minutes anyway. Two layers of retry are redundant.
- Remove Prometheus metrics endpoint (`addr: ":9090"`) from Litestream config -- no monitoring stack exists to consume it.

**Pattern Consistency:**
- Deploy files with hardcoded paths (`/home/nanoclaw/nanoclaw/...`) break the dynamic generation pattern in `setup/service.ts`. Consider generating these files from `setup/service.ts` using the same `projectRoot` variable, or at minimum use the static files as templates with documented path expectations.

## Technical Considerations

### 1. SQLite PRAGMA for Litestream Compatibility

Litestream requires `wal_autocheckpoint = 0` to prevent the application from checkpointing the WAL independently. However, this PRAGMA must be **conditional** -- on macOS (local dev) without Litestream, disabling autocheckpoint causes unbounded WAL growth.

**Decision**: Gate behind `LITESTREAM_ENABLED=true` environment variable, loaded via `config.ts` following the `ASSISTANT_HAS_OWN_NUMBER` pattern.

```typescript
// src/config.ts (add to readEnvFile keys and export)
export const LITESTREAM_ENABLED =
  (process.env.LITESTREAM_ENABLED || envConfig.LITESTREAM_ENABLED) === 'true';

// src/db.ts (after existing pragmas)
import { LITESTREAM_ENABLED } from './config.js';

if (LITESTREAM_ENABLED) {
  db.pragma('wal_autocheckpoint = 0');
  logger.info('Disabled WAL autocheckpoint (Litestream manages checkpointing)');
}
```

Existing PRAGMAs already set (`db.ts:184-186`):
- `journal_mode = WAL` -- required by Litestream
- `synchronous = NORMAL` -- recommended, already set
- `busy_timeout = 5000` -- prevents SQLITE_BUSY during checkpoints, already set

#### Research Insights (PRAGMA)

**Best Practices:**
- Import `LITESTREAM_ENABLED` from `config.ts` instead of reading `process.env` inline. This follows the existing pattern for `ASSISTANT_HAS_OWN_NUMBER` and centralizes env var handling.
- Add `logger.info()` when the PRAGMA is set, so operators can confirm Litestream integration is active in logs.

**Data Integrity:**
- When `wal_autocheckpoint = 0`, the application will never checkpoint the WAL. If Litestream stops (crash, misconfiguration), the WAL grows unbounded. Add a WAL size watchdog that triggers a `PASSIVE` checkpoint if the WAL exceeds a threshold (e.g., 100MB) -- this is safe because `PASSIVE` doesn't block concurrent readers.
- Export a `closeDatabase()` function and call it in the process shutdown handler. `better-sqlite3` does an implicit checkpoint on `db.close()`, which ensures the WAL is flushed before Litestream's final sync.

```typescript
// src/db.ts -- add WAL watchdog and shutdown export
export function closeDatabase(): void {
  if (db) {
    db.close();
    logger.info('Database closed');
  }
}

// Call from shutdown handler in src/index.ts
```

**Edge Cases:**
- If the process crashes (SIGKILL, OOM), `db.close()` is never called. This is fine -- Litestream will replicate the WAL as-is, and the next restore will replay it. No data loss occurs.

### 2. Litestream Configuration

**File**: `deploy/litestream.yml` (shipped in repo, deployed to `/etc/litestream.yml`)

```yaml
dbs:
  - path: /home/nanoclaw/nanoclaw/store/messages.db
    replicas:
      - type: gcs
        bucket: nanoclaw-backup
        path: litestream/messages.db
        sync-interval: 10s
        snapshot-interval: 1h
```

**GCS Authentication**: Use the GCE VM's attached service account (no key files). The service account needs `roles/storage.objectAdmin` on the backup bucket.

#### Research Insights (Litestream Config)

**Critical Bug Fix:**
- Litestream does **not** expand shell variables like `${GCS_BACKUP_BUCKET}` in its YAML config. The original plan used `${GCS_BACKUP_BUCKET}` which would be treated as a literal string. Options:
  1. Hardcode the bucket name (simplest -- it rarely changes)
  2. Use `envsubst` at deploy time to template the file
  3. Generate the file from `setup/service.ts`
- **Decision**: Generate per-tenant from `setup/service.ts`. Each tenant gets their own `litestream.yml` with their bucket name (`{project}-nanoclaw-{username}`) baked in. The bucket name is a deploy-time constant derived from `INSTANCE_ID`.

**Performance:**
- `sync-interval: 10s` instead of `1s`. At 1s, Litestream generates ~86,400 WAL segment uploads per day. At 10s, it's ~8,640. For a personal assistant with low write volume, 10s provides ample durability while reducing GCS API costs (~$12/month savings in Class A operations).
- Add `snapshot-interval: 1h` to create periodic full snapshots, which speeds up restore (fewer WAL segments to replay).

**Simplification:**
- Remove `addr: ":9090"` (Prometheus metrics endpoint). There is no monitoring stack to consume metrics, and binding to all interfaces is a security risk. If monitoring is needed later, bind to `127.0.0.1:9090`.

**Retention:**
- Do NOT configure Litestream's built-in retention. Instead, use GCS Object Lifecycle Management rules on the bucket to automatically delete objects older than N days. This is more reliable and doesn't require Litestream to be running.

### 3. rsync Script

**File**: `deploy/gcs-backup.sh`

Syncs specific data directories to GCS every 15 minutes. Key design decisions:

- **Uses `gcloud storage rsync`** (not `gsutil` -- deprecated)
- **Include-list approach**: Sync only `groups/`, `store/auth/`, and `data/sessions/` instead of excluding from the whole project. This is safer and more explicit.
- **`--checksums-only`**: More reliable change detection than mtime
- **`--continue-on-error`**: One failed file doesn't abort the sync
- **No `--delete-unmatched-destination-objects`**: Safer; local deletions don't propagate to backup
- **No retry loop**: `gcloud storage rsync` has built-in retry; systemd timer provides macro-level retry every 15 min
- **No flock**: systemd `Type=oneshot` prevents concurrent runs

#### Research Insights (rsync)

**Security:**
- The original plan synced the entire project directory (`${PROJECT_DIR}/`), which would upload `.env` files (containing API keys), source code, `node_modules`, and `dist/`. The include-list approach eliminates this risk entirely -- only `groups/`, `store/auth/`, and `data/sessions/` are synced.
- Validate the `GCS_BACKUP_BUCKET` value with a regex (`^[a-z0-9][a-z0-9._-]{1,61}[a-z0-9]$`) to prevent shell injection. The bucket name comes from an env var and is interpolated into a command.

**Simplification:**
- Remove the retry loop with exponential backoff. `gcloud storage rsync` already retries transient failures internally (with configurable `--num-retries`). The systemd timer provides a 15-minute macro retry. Two layers of retry add complexity without benefit.
- Remove `flock`. Systemd's `Type=oneshot` guarantees that only one instance of the service runs at a time. The timer won't fire the service while a previous run is still active.

**`--exclude-name-pattern` Limitation:**
- This flag uses Python `fnmatch` on the **filename only**, not the full path. Patterns like `ipc/` or `agent-runner-src/` match any file or directory with that exact name at any level. This is another reason to use the include-list approach (sync specific directories) rather than exclude-list (sync everything and exclude).

**Sentinel File:**
- Move the `LAST_SYNC` sentinel write to **after** the success check. In the original script, the sentinel was written before the error check, meaning a failed sync would still update the "last successful sync" timestamp.

### 4. Service Ordering (Critical)

The boot sequence must be:
1. `litestream.service` starts -> `ExecStartPre` restores DB from GCS if missing -> `ExecStart` begins continuous replication
2. `nanoclaw.service` starts **after** Litestream -> `initDatabase()` opens the restored DB

If NanoClaw starts before Litestream finishes restoring, `initDatabase()` creates a fresh empty DB (`db.ts:178-181`), and all historical data is lost.

**Solution**: `nanoclaw.service` specifies `After=litestream.service` and `Wants=litestream.service`.

#### Research Insights (Service Ordering)

**Best Practices:**
- Use `Wants=` not `Requires=`. With `Requires=`, if Litestream crashes at runtime, systemd will also stop NanoClaw. This is undesirable -- NanoClaw should keep running (just without backup). `Wants=` ensures Litestream starts at boot but doesn't enforce a runtime dependency.
- `ExecStartPre` time counts against `TimeoutStartSec`. The default is 90 seconds, which may be too short for restoring a large database from GCS. Set `TimeoutStartSec=300` on the Litestream service.
- Add `-parallelism 16` to the `litestream restore` command to speed up multi-segment restores.

**GCE-Specific:**
- User-level systemd services (`systemctl --user`) require `loginctl enable-linger <username>` on GCE. Without linger, user services stop when the SSH session ends. This must be part of the setup script.

### 5. Recovery Workflow

**File**: `deploy/restore.sh`

```bash
# 1. Stop services (with wait for full stop)
# 2. Backup existing DB (if present) before deletion
# 3. Remove stale DB files (*.db, *-wal, *-shm, *-litestream/)
# 4. Litestream restore from GCS
# 5. Log integrity check result (don't delete on failure)
# 6. rsync restore from GCS (groups/, auth/, sessions/)
# 7. Start services
```

The script is idempotent -- safe to re-run after partial failure.

#### Research Insights (Recovery)

**Critical Safety Fix:**
- The original script deletes the DB files **before** attempting restore. If the restore fails (network issue, empty bucket), the DB is gone with no fallback. **Always backup the existing DB first** (e.g., `cp messages.db messages.db.pre-restore`) before deletion.

**Integrity Check:**
- The original script deletes the restored DB if `PRAGMA integrity_check` fails and exits with error. This is dangerous -- you're deleting your only copy of the data. Better to **log the warning and proceed**. A DB with minor corruption is better than no DB at all.

**Ownership:**
- Remove `chown -R nanoclaw:nanoclaw` from restore.sh. If the script runs as the `nanoclaw` user (which it should, since it uses `systemctl --user`), chown will fail (no permission) and is unnecessary. If it runs as root, the `systemctl --user` commands need `XDG_RUNTIME_DIR` set. Keep it simple: run as `nanoclaw`, no chown needed.

**Post-Restore:**
- WhatsApp auth tokens (`store/auth/`) may be stale after restore. Document that WhatsApp re-authentication (QR code scan) may be required after a restore.
- Validate that restored `groups/` directories contain expected structure (at minimum a `main/` folder).
- Add `systemctl --user status litestream nanoclaw` at the end to confirm services started successfully.

### 6. Diagnostics Integration

Update `sup` script to show backup status:
- Litestream service status (`systemctl --user is-active litestream`)
- WAL file size (`stat -c%s store/messages.db-wal 2>/dev/null`)
- rsync timer status (`systemctl --user list-timers nanoclaw-rsync.timer`)
- Last sync timestamp (`gcloud storage cat gs://$BUCKET/rsync/LAST_SYNC`)

## System-Wide Impact

- **Interaction graph**: `initDatabase()` -> `db.pragma('wal_autocheckpoint = 0')` (conditional) -> Litestream manages WAL checkpointing. No impact on message writes, container operations, or IPC.
- **Error propagation**: If Litestream crashes, NanoClaw keeps running but WAL grows (no checkpointing when `wal_autocheckpoint = 0`). Litestream's systemd `Restart=always` handles this. WAL watchdog provides a safety net. If rsync fails, data is stale but the app is unaffected.
- **State lifecycle risks**: Partial restore could leave orphaned session IDs. Claude SDK sessions may or may not be portable -- if not, restored sessions are harmless (agent just starts a new session). WhatsApp auth tokens may require re-authentication after restore.
- **Local dev impact**: None -- PRAGMA is conditional, no Litestream/rsync on macOS.
- **Temporal divergence**: Litestream and rsync backups are not atomic. The SQLite backup may be seconds old while file backups are up to 15 minutes old. This is acceptable -- the data types are independent (messages vs. config files).

### Research Insights (System-Wide)

**Data Integrity:**
- Add `closeDatabase()` call to the process shutdown handler (`SIGTERM`, `SIGINT`). This ensures `better-sqlite3` does a final WAL checkpoint before the process exits, giving Litestream a clean state to replicate.
- Consider wrapping `saveState()` (in the message processing pipeline) in an explicit transaction if it isn't already. This ensures related writes are atomic, which Litestream replicates as a unit.

**Performance:**
- WAL size monitoring is important. If the WAL grows past ~100MB, it indicates Litestream is not checkpointing (crashed or misconfigured). The WAL watchdog should trigger a `PASSIVE` checkpoint in this case, which is safe under concurrent reads.

## Acceptance Criteria

- [x] `src/config.ts` exports `LITESTREAM_ENABLED` following `ASSISTANT_HAS_OWN_NUMBER` pattern
- [x] `src/db.ts` adds `wal_autocheckpoint = 0` when `LITESTREAM_ENABLED` is true, with `logger.info`
- [x] `src/db.ts` exports `closeDatabase()` for shutdown handler
- [x] `deploy/litestream.yml` configures GCS replication with `sync-interval: 10s`, `snapshot-interval: 1h`, no Prometheus endpoint
- [x] `deploy/litestream.service` systemd unit with `ExecStartPre` restore, `TimeoutStartSec=300`
- [x] `deploy/gcs-backup.sh` rsync script using include-list (specific dirs), no retry loop, no flock, bucket name validation
- [x] `deploy/nanoclaw-rsync.service` + `deploy/nanoclaw-rsync.timer` using `OnUnitInactiveSec=15min`
- [x] `deploy/restore.sh` disaster recovery with pre-deletion backup, no destructive integrity check, no chown
- [x] `nanoclaw.service` updated with `After=litestream.service`, `Wants=litestream.service`, `Environment=LITESTREAM_ENABLED=true`
- [x] `sup` shows Litestream status, WAL size, and rsync last-run time
- [x] `.env.example` documents `LITESTREAM_ENABLED`, `GCS_BACKUP_BUCKET` variables
- [x] `setup/service.ts` updated to optionally install Litestream units on Linux and run `loginctl enable-linger`
- [x] `stix/infra/nanoclaw-tenants.ts` defines tenant list (single source of truth)
- [x] `stix/infra/nanoclaw-backup.ts` creates per-tenant GCS buckets via Pulumi
- [x] Bucket naming follows `{project}-nanoclaw-{tenant}` convention

## Success Metrics

- Litestream replication lag < 10 seconds during normal operation (relaxed from 2s given 10s sync-interval)
- rsync completes within 5 minutes for typical data volume
- Full restore from GCS takes < 5 minutes
- Zero data loss on graceful shutdown; < 10 seconds data loss on VM crash (SQLite)

## Dependencies & Risks

| Risk | Mitigation |
|------|------------|
| Litestream crashes silently | `Restart=always` + WAL size watchdog with PASSIVE checkpoint fallback |
| rsync copies partially-written files | Eventual consistency -- next rsync captures final state |
| GCS quota/permission errors | Service account validation during setup; `sup` shows errors |
| WAL grows unbounded if Litestream stops | WAL watchdog triggers PASSIVE checkpoint at 100MB threshold |
| Restore creates empty DB if ordering is wrong | Strict systemd `After=` + `Wants=` dependency |
| Bucket name injection | Regex validation in gcs-backup.sh (`^[a-z0-9][a-z0-9._-]{1,61}[a-z0-9]$`) |
| User-level systemd stops on SSH disconnect | `loginctl enable-linger` in setup script |
| WhatsApp auth stale after restore | Document re-auth requirement in restore output |
| Litestream YAML doesn't expand shell vars | Hardcode bucket name (deploy-time constant) |
| ExecStartPre timeout on large DB restore | `TimeoutStartSec=300` on litestream.service |

## File Changes

### New files

| File | Purpose |
|------|---------|
| `deploy/litestream.yml` | Litestream configuration for GCS replication |
| `deploy/litestream.service` | Systemd unit for Litestream (restore + replicate) |
| `deploy/gcs-backup.sh` | rsync script syncing specific data directories |
| `deploy/nanoclaw-rsync.service` | Systemd oneshot unit for rsync |
| `deploy/nanoclaw-rsync.timer` | Systemd timer (every 15 min after last completion) |
| `deploy/restore.sh` | Full disaster recovery script |

### Modified files

| File | Change |
|------|--------|
| `src/config.ts` | Add `LITESTREAM_ENABLED` to readEnvFile keys and export |
| `src/db.ts:187` | Add conditional `wal_autocheckpoint = 0` PRAGMA with logging |
| `src/db.ts` | Export `closeDatabase()` for shutdown handler |
| `setup/service.ts` | Add Litestream service setup on Linux, `loginctl enable-linger` |
| `sup` | Add backup status checks (Litestream, WAL size, rsync timer) |
| `.env.example` | Document `LITESTREAM_ENABLED`, `GCS_BACKUP_BUCKET` |

## MVP

### `src/config.ts` (add LITESTREAM_ENABLED)

```typescript
// Add to readEnvFile keys array:
'LITESTREAM_ENABLED',

// Add export:
export const LITESTREAM_ENABLED =
  (process.env.LITESTREAM_ENABLED || envConfig.LITESTREAM_ENABLED) === 'true';
```

### `src/db.ts` (conditional PRAGMA + shutdown export)

```typescript
import { LITESTREAM_ENABLED, STORE_DIR } from './config.js';
import { logger } from './logger.js';

export function initDatabase(): void {
  const dbPath = path.join(STORE_DIR, 'messages.db');
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });

  db = new Database(dbPath);

  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('busy_timeout = 5000');

  // Litestream manages WAL checkpointing -- disable app-side checkpointing
  // Only when Litestream is running (GCE), not on local dev (macOS)
  if (LITESTREAM_ENABLED) {
    db.pragma('wal_autocheckpoint = 0');
    logger.info('Disabled WAL autocheckpoint (Litestream manages checkpointing)');
  }

  createSchema(db);
  migrateJsonState();
}

export function closeDatabase(): void {
  if (db) {
    db.close();
    logger.info('Database closed');
  }
}
```

### `deploy/litestream.yml`

Generated per-tenant by `setup/service.ts` with the correct bucket name. Template:

```yaml
dbs:
  - path: /home/{username}/nanoclaw/store/messages.db
    replicas:
      - type: gcs
        bucket: {project}-nanoclaw-{username}
        path: litestream/messages.db
        sync-interval: 10s
        snapshot-interval: 1h
```

### `deploy/litestream.service`

```ini
[Unit]
Description=Litestream replication for NanoClaw
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=nanoclaw
Restart=always
RestartSec=5
TimeoutStartSec=300

ExecStartPre=/usr/bin/litestream restore -if-db-not-exists -if-replica-exists -parallelism 16 -config /etc/litestream.yml /home/nanoclaw/nanoclaw/store/messages.db

ExecStart=/usr/bin/litestream replicate -config /etc/litestream.yml

[Install]
WantedBy=default.target
```

### `deploy/gcs-backup.sh`

```bash
#!/usr/bin/env bash
set -euo pipefail

BUCKET="${GCS_BACKUP_BUCKET:?GCS_BACKUP_BUCKET not set}"
PROJECT_DIR="/home/nanoclaw/nanoclaw"
LOG_TAG="nanoclaw-rsync"

log() { logger -t "$LOG_TAG" "$1"; }

# Validate bucket name to prevent injection
if [[ ! "$BUCKET" =~ ^[a-z0-9][a-z0-9._-]{1,61}[a-z0-9]$ ]]; then
  log "ERROR: Invalid bucket name: $BUCKET"
  exit 1
fi

log "=== GCS rsync starting ==="

FAILED=0

# Sync each data directory explicitly (include-list approach)
for dir_pair in \
  "groups/:groups/" \
  "store/auth/:store/auth/" \
  "data/sessions/:data/sessions/"; do

  SRC="${dir_pair%%:*}"
  DST="${dir_pair##*:}"

  if [ ! -d "${PROJECT_DIR}/${SRC}" ]; then
    log "Skipping ${SRC} (does not exist)"
    continue
  fi

  log "Syncing ${SRC}..."
  gcloud storage rsync \
    "${PROJECT_DIR}/${SRC}" \
    "gs://${BUCKET}/rsync/${DST}" \
    --recursive \
    --checksums-only \
    --continue-on-error \
    2>&1 | logger -t "$LOG_TAG" || FAILED=1
done

# Write sentinel for monitoring (only on success)
if [ "$FAILED" -eq 0 ]; then
  echo "$(date -u +%Y-%m-%dT%H:%M:%SZ)" | \
    gcloud storage cp - "gs://${BUCKET}/rsync/LAST_SYNC" 2>&1 | logger -t "$LOG_TAG"
  log "=== GCS rsync complete ==="
else
  log "=== GCS rsync completed with errors ==="
  exit 1
fi
```

### `deploy/nanoclaw-rsync.timer`

```ini
[Unit]
Description=NanoClaw GCS backup sync timer

[Timer]
OnBootSec=5min
OnUnitInactiveSec=15min

[Install]
WantedBy=timers.target
```

### `deploy/nanoclaw-rsync.service`

```ini
[Unit]
Description=Sync NanoClaw data to GCS
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
User=nanoclaw
ExecStart=/home/nanoclaw/nanoclaw/deploy/gcs-backup.sh
TimeoutStartSec=1800
Environment=GCS_BACKUP_BUCKET={project}-nanoclaw-{username}
```

### `deploy/restore.sh`

```bash
#!/usr/bin/env bash
set -euo pipefail

BUCKET="${GCS_BACKUP_BUCKET:?GCS_BACKUP_BUCKET not set}"
PROJECT_DIR="/home/nanoclaw/nanoclaw"
DB_PATH="${PROJECT_DIR}/store/messages.db"

echo "1. Stopping services..."
systemctl --user stop nanoclaw 2>/dev/null || true
systemctl --user stop nanoclaw-rsync.timer 2>/dev/null || true
systemctl --user stop litestream 2>/dev/null || true
sleep 2  # Wait for processes to fully exit

echo "2. Backing up existing DB (if present)..."
if [ -f "$DB_PATH" ]; then
  cp "$DB_PATH" "${DB_PATH}.pre-restore" 2>/dev/null || true
fi

echo "3. Restoring SQLite from Litestream..."
rm -f "$DB_PATH" "${DB_PATH}-wal" "${DB_PATH}-shm"
rm -rf "${DB_PATH}-litestream"
litestream restore -parallelism 16 -config /etc/litestream.yml "$DB_PATH" || {
  echo "WARNING: Litestream restore failed (fresh deploy?)"
}

if [ -f "$DB_PATH" ]; then
  echo "4. Checking database integrity..."
  INTEGRITY=$(sqlite3 "$DB_PATH" "PRAGMA integrity_check;" 2>&1)
  if [ "$INTEGRITY" != "ok" ]; then
    echo "WARNING: Database integrity check returned: $INTEGRITY"
    echo "         Proceeding anyway -- check manually if issues arise."
  else
    echo "   Database integrity OK."
  fi
fi

echo "5. Restoring files from rsync backup..."
mkdir -p "${PROJECT_DIR}/groups" "${PROJECT_DIR}/store/auth" "${PROJECT_DIR}/data/sessions"

gcloud storage rsync \
  "gs://${BUCKET}/rsync/groups/" \
  "${PROJECT_DIR}/groups/" \
  --recursive || echo "WARNING: groups restore failed"

gcloud storage rsync \
  "gs://${BUCKET}/rsync/store/auth/" \
  "${PROJECT_DIR}/store/auth/" \
  --recursive || echo "WARNING: auth restore failed"

gcloud storage rsync \
  "gs://${BUCKET}/rsync/data/sessions/" \
  "${PROJECT_DIR}/data/sessions/" \
  --recursive || echo "WARNING: sessions restore failed"

echo "6. Starting services..."
systemctl --user start litestream
systemctl --user start nanoclaw
systemctl --user start nanoclaw-rsync.timer

echo ""
echo "7. Verifying services..."
systemctl --user status litestream nanoclaw --no-pager || true

echo ""
echo "Restore complete."
echo ""
echo "NOTE: WhatsApp auth tokens may be stale. If the bot does not connect,"
echo "      re-authenticate by scanning the QR code (npm run setup)."
```

## Infrastructure (Pulumi)

GCS buckets, IAM, and lifecycle rules are managed in Pulumi alongside existing stix infrastructure at `~/workspace/dalab/stix/infra/`. Each NanoClaw tenant gets its own bucket.

### Bucket Naming Convention

```
{gcp-project}-nanoclaw-{tenant}
```

Examples:
- `stix-dev-13dd5-nanoclaw-alice`
- `stix-dev-13dd5-nanoclaw-bob`
- `stix-prod-nanoclaw-lamson`

This follows the stix pattern of project-scoped naming and ensures global uniqueness.

### Tenant Configuration

**File**: `stix/infra/nanoclaw-tenants.ts`

Tenants are defined in a standalone TypeScript config file that can be imported by both Pulumi and provisioning scripts.

```typescript
// stix/infra/nanoclaw-tenants.ts

export interface NanoClawTenant {
  /** OS username on the VM (also used as INSTANCE_ID) */
  username: string;
  /** Human-readable label */
  displayName?: string;
}

/**
 * NanoClaw tenants — each gets a GCS backup bucket.
 * Add new tenants here, then run `pulumi up`.
 *
 * The username must match the OS user on the GCE VM.
 * It is also used as the INSTANCE_ID for container name prefixing.
 */
export const NANOCLAW_TENANTS: NanoClawTenant[] = [
  { username: 'lamson', displayName: 'Lamson' },
  // { username: 'alice', displayName: 'Alice' },
];
```

### Pulumi Module

**File**: `stix/infra/nanoclaw-backup.ts`

Creates per-tenant GCS buckets with lifecycle rules and IAM bindings.

```typescript
// stix/infra/nanoclaw-backup.ts

import * as gcp from '@pulumi/gcp';
import * as pulumi from '@pulumi/pulumi';
import { projectId, region, environment } from './config';
import { NANOCLAW_TENANTS } from './nanoclaw-tenants';
import { enabledApis } from './apis';

// Per-tenant backup buckets
export const nanoclawBackupBuckets = NANOCLAW_TENANTS.map((tenant) => {
  const bucketName = `${projectId}-nanoclaw-${tenant.username}`;

  const bucket = new gcp.storage.Bucket(
    `nanoclaw-backup-${tenant.username}`,
    {
      name: bucketName,
      location: region,
      project: projectId,
      uniformBucketLevelAccess: true,
      forceDestroy: environment !== 'prod',

      lifecycleRules: [
        {
          action: { type: 'SetStorageClass', storageClass: 'NEARLINE' },
          condition: { age: 30 },
        },
        {
          action: { type: 'Delete' },
          condition: { age: 365 },
        },
      ],

      versioning: {
        enabled: environment === 'prod',
      },
    },
    { dependsOn: enabledApis },
  );

  return { tenant, bucket, bucketName };
});
```

**IAM**: The VM's attached service account already has project-level permissions. For tighter scoping, add per-bucket `storage.objectAdmin` bindings to the VM service account (or per-user service accounts if rootless Docker isolation warrants it).

### Integration with index.ts

```typescript
// stix/infra/index.ts (add)
import { nanoclawBackupBuckets } from './nanoclaw-backup';

export const nanoclawBackupBucketNames = nanoclawBackupBuckets.map(
  ({ tenant, bucket }) => ({
    tenant: tenant.username,
    bucket: bucket.name,
  }),
);
```

### How Bucket Name Reaches the VM

Each tenant's systemd environment needs `GCS_BACKUP_BUCKET={project}-nanoclaw-{username}`. Since the username = INSTANCE_ID, and the project ID is a deploy-time constant, the bucket name can be derived:

1. **In Litestream config** (`/etc/litestream.yml`): Generated per-tenant at deploy time by `setup/service.ts` or a provisioning script, hardcoding the bucket name.
2. **In systemd units**: `Environment=GCS_BACKUP_BUCKET={project}-nanoclaw-{username}` set by `setup/service.ts` which already knows the project root and can read `INSTANCE_ID` from `.env`.

### Provisioning a New Tenant

1. Add tenant to `stix/infra/nanoclaw-tenants.ts`
2. Run `cd stix/infra && pulumi up` (creates bucket)
3. On the VM: `sudo useradd -m tenant-name && sudo -u tenant-name bash -c '...'` (per `docs/MULTI_TENANT.md`)
4. Tenant's `setup/service.ts` generates Litestream config with the correct bucket name

### New Files (in stix/infra/)

| File | Purpose |
|------|---------|
| `nanoclaw-tenants.ts` | Tenant config (username list) -- single source of truth |
| `nanoclaw-backup.ts` | Per-tenant GCS bucket creation with lifecycle rules |

### Modified Files (in stix/infra/)

| File | Change |
|------|--------|
| `index.ts` | Import and export `nanoclawBackupBuckets` |

## Deployment Checklist (Go/No-Go)

Before deploying:
- [ ] Tenant added to `stix/infra/nanoclaw-tenants.ts`
- [ ] `pulumi up` run to create GCS bucket (`{project}-nanoclaw-{tenant}`)
- [ ] GCS Object Lifecycle rule applied (auto via Pulumi: Nearline at 30d, delete at 1y)
- [ ] VM service account has `storage.objectAdmin` on the tenant's bucket
- [ ] Litestream binary installed on VM (`/usr/bin/litestream`)
- [ ] `loginctl enable-linger {username}` run on VM
- [ ] Tenant's `litestream.yml` deployed with correct bucket name
- [ ] `deploy/gcs-backup.sh` is executable (`chmod +x`)
- [ ] Test restore from empty bucket (should create fresh DB, not fail)
- [ ] Test restore from populated bucket (should restore all data)

After deploying:
- [ ] `sup` shows Litestream active and replicating
- [ ] `sup` shows rsync timer scheduled
- [ ] WAL file exists and is < 10MB
- [ ] GCS bucket contains `litestream/` and `rsync/` prefixes

## Sources

- [Litestream GCS Guide](https://litestream.io/guides/gcs/)
- [Litestream Tips (autocheckpoint)](https://litestream.io/tips/)
- [Litestream Systemd Guide](https://litestream.io/guides/systemd/)
- [Litestream Restore Reference](https://litestream.io/reference/restore/)
- [gcloud storage rsync Reference](https://docs.google.com/sdk/gcloud/reference/storage/rsync)
- Similar pattern: `src/db.ts:177-192` (existing PRAGMA setup)
- Service setup: `setup/service.ts:204-306` (existing systemd unit generation)
- Diagnostics: `sup` (existing backup status hooks for GCP)
- Config pattern: `src/config.ts:20-22` (`ASSISTANT_HAS_OWN_NUMBER` env var pattern)
