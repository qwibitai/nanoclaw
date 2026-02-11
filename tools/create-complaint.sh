#!/usr/bin/env bash
set -euo pipefail

# create-complaint.sh — Insert a new complaint and return its tracking ID.
# Usage: create-complaint.sh --phone PHONE --description TEXT --language LANG [--category CAT] [--location LOC]
# Requires: DB_PATH environment variable pointing to SQLite database.

# Escape single quotes for safe SQL interpolation
sql_escape() { echo "${1//\'/\'\'}"; }

PHONE=""
DESCRIPTION=""
LANGUAGE=""
CATEGORY=""
LOCATION=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --phone)    PHONE="$2";       shift 2 ;;
    --description) DESCRIPTION="$2"; shift 2 ;;
    --language) LANGUAGE="$2";    shift 2 ;;
    --category) CATEGORY="$2";   shift 2 ;;
    --location) LOCATION="$2";   shift 2 ;;
    *) echo "Unknown arg: $1" >&2; exit 1 ;;
  esac
done

if [[ -z "$PHONE" ]]; then
  echo "Error: --phone is required" >&2
  exit 1
fi
if [[ -z "$DESCRIPTION" ]]; then
  echo "Error: --description is required" >&2
  exit 1
fi
if [[ -z "$LANGUAGE" ]]; then
  echo "Error: --language is required" >&2
  exit 1
fi
if [[ -z "${DB_PATH:-}" ]]; then
  echo "Error: DB_PATH environment variable is required" >&2
  exit 1
fi

# Sanitize all user-provided inputs
S_PHONE=$(sql_escape "$PHONE")
S_DESC=$(sql_escape "$DESCRIPTION")
S_LANG=$(sql_escape "$LANGUAGE")
S_CAT=$(sql_escape "$CATEGORY")
S_LOC=$(sql_escape "$LOCATION")

# Read tracking ID prefix from tenant_config
PREFIX=$(sqlite3 "$DB_PATH" "SELECT value FROM tenant_config WHERE key = 'complaint_id_prefix';" 2>/dev/null || echo "")
if [[ -z "$PREFIX" ]]; then
  echo "Error: complaint_id_prefix not found in tenant_config" >&2
  exit 1
fi

TODAY=$(date -u +%Y%m%d)
NOW=$(date -u +%Y-%m-%dT%H:%M:%SZ)

# Ensure user exists (upsert)
sqlite3 "$DB_PATH" "INSERT INTO users (phone, language, first_seen, last_seen) VALUES ('${S_PHONE}', '${S_LANG}', '${NOW}', '${NOW}') ON CONFLICT(phone) DO UPDATE SET last_seen = '${NOW}';"

# Compute next sequential counter for today (atomic via single query)
COUNTER=$(sqlite3 "$DB_PATH" "SELECT COALESCE(MAX(CAST(SUBSTR(id, -4) AS INTEGER)), 0) + 1 FROM complaints WHERE id LIKE '${PREFIX}-${TODAY}-%';")

# Pad to 4 digits
COUNTER_PAD=$(printf "%04d" "$COUNTER")
COMPLAINT_ID="${PREFIX}-${TODAY}-${COUNTER_PAD}"

# Insert complaint
sqlite3 "$DB_PATH" <<SQL
INSERT INTO complaints (id, phone, category, subcategory, description, location, language, status, priority, source, created_at, updated_at)
VALUES (
  '${COMPLAINT_ID}',
  '${S_PHONE}',
  $([ -n "$S_CAT" ] && echo "'${S_CAT}'" || echo "NULL"),
  NULL,
  '${S_DESC}',
  $([ -n "$S_LOC" ] && echo "'${S_LOC}'" || echo "NULL"),
  '${S_LANG}',
  'registered',
  'normal',
  'text',
  '${NOW}',
  '${NOW}'
);
UPDATE users SET total_complaints = total_complaints + 1 WHERE phone = '${S_PHONE}';
SQL

echo "$COMPLAINT_ID"
