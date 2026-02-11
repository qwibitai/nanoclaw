#!/usr/bin/env bash
set -euo pipefail

# update-complaint.sh — Change complaint status and create audit record.
# Usage: update-complaint.sh --id COMPLAINT_ID --status STATUS [--note TEXT] [--updated-by WHO]
# Requires: DB_PATH environment variable pointing to SQLite database.

# Escape single quotes for safe SQL interpolation
sql_escape() { echo "${1//\'/\'\'}"; }

ID=""
STATUS=""
NOTE=""
UPDATED_BY="system"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --id)         ID="$2";         shift 2 ;;
    --status)     STATUS="$2";     shift 2 ;;
    --note)       NOTE="$2";       shift 2 ;;
    --updated-by) UPDATED_BY="$2"; shift 2 ;;
    *) echo "Unknown arg: $1" >&2; exit 1 ;;
  esac
done

if [[ -z "$ID" ]]; then
  echo "Error: --id is required" >&2
  exit 1
fi
if [[ -z "$STATUS" ]]; then
  echo "Error: --status is required" >&2
  exit 1
fi
if [[ -z "${DB_PATH:-}" ]]; then
  echo "Error: DB_PATH environment variable is required" >&2
  exit 1
fi

# Validate status
VALID_STATUSES="registered acknowledged in_progress action_taken resolved on_hold escalated"
if ! echo "$VALID_STATUSES" | grep -qw "$STATUS"; then
  echo "Error: invalid status '$STATUS'. Valid: $VALID_STATUSES" >&2
  exit 1
fi

# Sanitize inputs
S_ID=$(sql_escape "$ID")
S_STATUS=$(sql_escape "$STATUS")
S_NOTE=$(sql_escape "$NOTE")
S_UPDATED_BY=$(sql_escape "$UPDATED_BY")

# Get current status (also verifies complaint exists)
OLD_STATUS=$(sqlite3 "$DB_PATH" "SELECT status FROM complaints WHERE id = '${S_ID}';" 2>/dev/null || echo "")
if [[ -z "$OLD_STATUS" ]]; then
  echo "Error: complaint '$ID' not found" >&2
  exit 1
fi

NOW=$(date -u +%Y-%m-%dT%H:%M:%SZ)

# Build resolved_at clause
RESOLVED_CLAUSE=""
if [[ "$STATUS" == "resolved" ]]; then
  RESOLVED_CLAUSE=", resolved_at = '${NOW}'"
fi

# Update complaint status
sqlite3 "$DB_PATH" "UPDATE complaints SET status = '${S_STATUS}', updated_at = '${NOW}'${RESOLVED_CLAUSE} WHERE id = '${S_ID}';"

# Insert audit record
sqlite3 "$DB_PATH" "INSERT INTO complaint_updates (complaint_id, old_status, new_status, note, updated_by, created_at) VALUES ('${S_ID}', '${OLD_STATUS}', '${S_STATUS}', $([ -n "$S_NOTE" ] && echo "'${S_NOTE}'" || echo "NULL"), '${S_UPDATED_BY}', '${NOW}');"

echo "OK"
