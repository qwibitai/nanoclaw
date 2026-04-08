#!/bin/bash
# supabase-localhost-daily-backup.sh
# Full backup of local Supabase project → /Volumes/caponesafe/longbow-backups
# Retains the last 5 archives. Run via supabase-localhost-daily-backup.ts

set -euo pipefail

BACKUP_DIR="$HOME/Downloads/longbow-backups"
ARCHIVE_DIR="/Volumes/caponesafe/longbow-backups"
TIMESTAMP=$(date +%s)
ARCHIVE_NAME="longbow-localhost-archive-${TIMESTAMP}.zip"

mkdir -p "$BACKUP_DIR"
mkdir -p "$ARCHIVE_DIR"

# Local Supabase DB URL
DB_URL="postgresql://postgres:postgres@127.0.0.1:54322/postgres"

# Dump roles, schema, and data
supabase db dump --db-url "$DB_URL" -f "${BACKUP_DIR}/roles.sql"  --role-only
supabase db dump --db-url "$DB_URL" -f "${BACKUP_DIR}/schema.sql"
supabase db dump --db-url "$DB_URL" -f "${BACKUP_DIR}/data.sql"   --use-copy --data-only

# Zip and move to external volume
cd "$BACKUP_DIR"
zip "$ARCHIVE_NAME" roles.sql schema.sql data.sql
mv "$ARCHIVE_NAME" "$ARCHIVE_DIR/"

# Retention: keep only the 5 most recent archives
cd "$ARCHIVE_DIR"
ls -1t longbow-localhost-archive-*.zip 2>/dev/null | tail -n +6 | xargs -I {} rm -- {}

# Cleanup temp SQL files
rm -f "$BACKUP_DIR/roles.sql" "$BACKUP_DIR/schema.sql" "$BACKUP_DIR/data.sql"

# Summary output (parsed by the TS wrapper)
ARCHIVE_SIZE=$(stat -f%z "$ARCHIVE_DIR/$ARCHIVE_NAME")
echo "Backup archive created: $ARCHIVE_NAME"
echo "File size: $ARCHIVE_SIZE bytes"
echo "Backup directory: $ARCHIVE_DIR"
echo "Timestamp: $TIMESTAMP"
