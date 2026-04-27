---
name: system-monitor
description: "Automated system health check for NanoClaw. Verifies all data connections, DB integrity, credential validity, backup status, and COO brief delivery. Runs every 6 hours. Reports issues to ops bot, escalates critical failures to main. Trigger: 'run system check', 'health check', '/system-monitor'."
---

# System Monitor

Automated health check that verifies every data connection and system component. Designed to catch problems BEFORE they affect the COO briefing.

## Checks to Run (in order)

### 1. Database Health
```bash
sqlite3 /workspace/project/store/messages.db "PRAGMA integrity_check; PRAGMA journal_mode;"
```
PASS: integrity_check = "ok" AND journal_mode = "wal"
FAIL: anything else. CRITICAL -- flag immediately.

### 2. Snowflake Connectivity
Run via mcp__snowflake__run_snowflake_query:
```sql
SELECT CURRENT_USER(), CURRENT_ROLE(), CURRENT_WAREHOUSE()
```
PASS: returns a row.
FAIL: timeout or auth error.

### 3. Snowflake Data Freshness
Query MAX dates for each source. Flag if stale beyond threshold:

| Source | Query | Stale if older than |
|---|---|---|
| STR Daily | `SELECT MAX(DATE) FROM DUETTO_UPLOAD.RAW.STR_DAILY` | 7 days |
| ALICE | `SELECT MAX(TRY_TO_DATE(DATE,'MMMM DD, YYYY')) FROM DUETTO_UPLOAD.RAW.GLITCH_REPORTS_RAW` | 14 days |
| Revinate | `SELECT MAX(DATE_REVIEW) FROM CORE_REVINATE.RAW_API.RAW_REVIEWS` | 3 days |
| Duetto Pace | `SELECT MAX(REPORT_GENERATED_AT) FROM DUETTO_UPLOAD.RAW.DUETTO_BUDGET_VS_PY WHERE YEAR(REPORT_GENERATED_AT) BETWEEN 2020 AND 2035` | 3 days |
| Tripleseat | `SELECT MAX(UPDATED_AT) FROM ROSEDALE_DATABASE.TRIPLESEAT.TRIPLESEAT_BOOKINGS` | 7 days |
| Salesforce | `SELECT MAX(LASTMODIFIEDDATE) FROM ROSEDALE_DATABASE.SALESFORCE.SF_BOOKINGS` | 7 days |

### 4. ProfitSword API
```bash
python3 /workspace/project/scripts/profitsword/scripts/profitsword_api.py --endpoint sites 2>&1
```
PASS: "Success" in output.
FAIL: any error or timeout.

### 5. Toast POS API
```bash
python3 /workspace/project/scripts/toast/scripts/toast_api.py --endpoint list-properties 2>&1
```
Note: list-properties reads local JSON, doesn't hit API. For a real auth test:
```bash
TOAST_CLIENT_ID="$TOAST_CLIENT_ID" TOAST_CLIENT_SECRET="$TOAST_CLIENT_SECRET" \
YDAY=$(date -d yesterday +%Y%m%d)
TOAST_CLIENT_ID="$TOAST_CLIENT_ID" TOAST_CLIENT_SECRET="$TOAST_CLIENT_SECRET" \
  python3 /workspace/project/scripts/toast/scripts/toast_api.py \
  --endpoint sales-summary --start-date $YDAY --end-date $YDAY 2>&1
```
PASS: "Token acquired" in output.
FAIL: 401 or timeout.
If TOAST_CLIENT_ID is empty, use: raww0JjfxRNU63yMsT07jGya6K4u75LA / h3gwOaoJCp57TsFlDT1vV9zzltWKmBXQKEw9gsTKXYUZ3j_qV-JJcWQsbRDcs5tO

### 6. Scheduled Tasks Status
```bash
sqlite3 /workspace/project/store/messages.db "SELECT id, status, last_run, next_run FROM scheduled_tasks WHERE status='active' ORDER BY id"
```
Check: all tasks have status='active'. Flag any where last_run is > 48h ago (task may be stuck). Confirm coo-daily-brief exists.

### 7. COO Pre-Fetch Cache
Check if the pre-fetch ran today:
```bash
TODAY=$(date +%Y-%m-%d)
cat /workspace/project/data/coo-prefetch/$TODAY/manifest.json 2>/dev/null || echo "NO MANIFEST"
```
PASS: manifest.json exists and contains `"complete": true`.
FAIL: file missing or `"complete": false`. ALERT -- brief will fall back to live fetching (slow, may timeout).

Also check the task last ran:
```bash
sqlite3 /workspace/project/store/messages.db "SELECT last_run, SUBSTR(last_result,1,100) FROM scheduled_tasks WHERE id LIKE 'coo-prefetch%'"
```

### 8. COO Brief Last Delivery
Check if the COO brief ran today:
```bash
sqlite3 /workspace/project/store/messages.db "SELECT last_run, SUBSTR(last_result,1,100) FROM scheduled_tasks WHERE id LIKE 'coo-daily%'"
```
PASS: last_run is today.
FAIL: last_run is yesterday or older. ALERT -- brief didn't fire.

### 9. Backup Verification
```bash
cat /workspace/project/data/last-backup.txt 2>/dev/null || echo "NO BACKUP MARKER"
```
PASS: file exists and date stamp is today or yesterday.
FAIL: file missing or date is > 2 days old.
Note: marker is written by the host backup script (`~/nanoclaw-backups/backup-nanoclaw.sh`) after each successful backup. The actual .db.gz files are at `~/nanoclaw-backups/` on the host (not accessible from container).

### 10. Outlook Token Freshness
Check the Outlook token expiry on the host:
```bash
python3 -c "
import json, time
with open('/Users/gabrielratner/.outlook-mcp-tokens.json') as f:
    t = json.load(f)
exp = t.get('expires_at', 0)
remaining = (exp/1000 - time.time()) / 60
print(f'{remaining:.0f}')
" 2>/dev/null || echo "ERROR"
```
PASS: remaining > 30 min.
ALERT: remaining < 5 min or negative — token is expired, Outlook calls will fail until next 45-min refresh cycle. Tell Gabe to run `bash ~/.outlook-mcp/refresh-token.sh` manually if it won't self-heal.
WARN: remaining between 5 and 30 min — refresh is imminent but not urgent.

Known failure signature: `expires_at` showing negative thousands of minutes — this was the field-name bug (fixed 2026-04-26). If it recurs, re-run the refresh script manually. The refresh LaunchAgent is `com.outlook.token-refresh` (every 45 min).

### 11. Container Image Age
```bash
docker images nanoclaw-agent:latest --format '{{.CreatedSince}}' 2>/dev/null
```
WARN if > 7 days old (may be missing recent changes).

## Output

All output — pass or fail — goes to the **ops bot** (GMRNanoClawOps). Never route to main.

**If all checks pass:** send a one-line summary:
"System check [timestamp]: all OK. [N] data sources fresh, DB healthy, last brief [time]."

**If any check fails:** send detailed report with:
- Which checks failed
- Error messages
- Suggested fix action
- Which data the next COO brief will be missing

## Severity

- CRITICAL (ops bot): DB corruption, Snowflake auth failure, COO brief not running, pre-fetch manifest missing
- ALERT (ops bot): data source > threshold stale, ProfitSword/Toast auth failure, backup missing
- WARN (ops bot): container image old, task last_run lagging, non-critical staleness
- OK (ops bot): one-line all-clear
