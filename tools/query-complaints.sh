#!/usr/bin/env bash
set -euo pipefail

# query-complaints.sh — Lookup complaints by phone number or complaint ID.
# Usage: query-complaints.sh --phone PHONE | --id COMPLAINT_ID
# Requires: DB_PATH environment variable pointing to SQLite database.

# Escape single quotes for safe SQL interpolation
sql_escape() { echo "${1//\'/\'\'}"; }

PHONE=""
ID=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --phone) PHONE="$2"; shift 2 ;;
    --id)    ID="$2";    shift 2 ;;
    *) echo "Unknown arg: $1" >&2; exit 1 ;;
  esac
done

if [[ -z "$PHONE" && -z "$ID" ]]; then
  echo "Error: --phone or --id is required" >&2
  exit 1
fi
if [[ -z "${DB_PATH:-}" ]]; then
  echo "Error: DB_PATH environment variable is required" >&2
  exit 1
fi

if [[ -n "$ID" ]]; then
  S_ID=$(sql_escape "$ID")
  RESULT=$(sqlite3 -json "$DB_PATH" "SELECT id, phone, category, description, location, language, status, priority, created_at, updated_at, resolved_at, days_open_live AS days_open FROM complaints_view WHERE id = '${S_ID}';")
else
  S_PHONE=$(sql_escape "$PHONE")
  RESULT=$(sqlite3 -json "$DB_PATH" "SELECT id, phone, category, description, location, language, status, priority, created_at, updated_at, resolved_at, days_open_live AS days_open FROM complaints_view WHERE phone = '${S_PHONE}' ORDER BY created_at DESC;")
fi

# sqlite3 -json outputs empty string for no results; normalize to []
if [[ -z "$RESULT" ]]; then
  echo "[]"
else
  echo "$RESULT"
fi
