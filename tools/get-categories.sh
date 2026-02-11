#!/usr/bin/env bash
set -euo pipefail

# get-categories.sh — List active categories from the categories table.
# Usage: get-categories.sh
# Requires: DB_PATH environment variable pointing to SQLite database.

if [[ -z "${DB_PATH:-}" ]]; then
  echo "Error: DB_PATH environment variable is required" >&2
  exit 1
fi

RESULT=$(sqlite3 -json "$DB_PATH" "SELECT name, display_name_en, display_name_mr, display_name_hi, complaint_count FROM categories WHERE is_active = 1 ORDER BY name;")

if [[ -z "$RESULT" ]]; then
  echo "[]"
else
  echo "$RESULT"
fi
