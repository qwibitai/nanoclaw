# NanoClaw OS — Operating Model

## Service Management

```bash
npm run dev          # Development with hot reload
npm run start        # Production
npm run ops:status   # Operational metrics (JSON)
npm run ops:backup   # Create backup
npm run ops:restore  # Restore from backup
```

## Monitoring

### Key Metrics (`npm run ops:status`)

| Metric | Alert Threshold | Action |
|--------|----------------|--------|
| WIP load per group | > 3 DOING | Investigate capacity |
| Failed dispatches | > 0 | Check gov_dispatches for errors |
| L3 calls (24h) | Unusual spike | Review ext_calls audit |
| Tasks in BLOCKED | > 2 | Triage blockers |

### Logs

Structured logging via pino. Key log levels:
- `WARN`: Policy denials, auth failures, version conflicts
- `INFO`: State transitions, dispatches, ext_call execution
- `DEBUG`: Idempotency hits, no-op transitions

## Backup & Restore

**RPO:** Last backup (manual or scheduled)
**RTO:** ~5 minutes (restore + restart)

### Schedule

Run `npm run ops:backup` before:
- Any policy change
- Production deployments
- Sprint boundaries

Backups stored in `backups/os-backup-YYYYMMDD-HHMM.tar.gz` with SHA256 hash.

See [OS_BACKUP_AND_RESTORE.md](OS_BACKUP_AND_RESTORE.md) for procedures.

## Incident Response

1. **BLOCKED tasks**: Check `gov_activities` for reason, triage via `gov_transition` back to appropriate state
2. **Failed dispatches**: Check `gov_dispatches` table, verify container health, re-dispatch
3. **Ext call failures**: Check `ext_calls` audit, verify provider secrets, check backpressure
4. **Version conflicts**: Normal under concurrency — agent retries with fresh snapshot

## Change Management

All governance policy changes follow the formal process in [POLICY_CHANGE_PROCESS.md](POLICY_CHANGE_PROCESS.md).

Current policy version tracked in `src/governance/policy-version.ts` and stored on every task and ext_call for forensic audit.

## Capacity Planning

| Resource | Default Limit | Config |
|----------|--------------|--------|
| Concurrent containers | 3 | `MAX_CONCURRENT_CONTAINERS` |
| WIP per group | Soft limit (alerts) | Monitor via ops:status |
| Pending ext_calls | 5 per group | `EXT_MAX_PENDING_PER_GROUP` |
| Ext call timeout | 30s | `EXT_CALL_TIMEOUT` |
