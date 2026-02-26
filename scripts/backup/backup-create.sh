#!/bin/bash
set -euo pipefail

# NanoClaw Backup Script
# Creates encrypted backup of databases, groups, and config

TIMESTAMP=$(date +%Y%m%d-%H%M%S)
BACKUP_NAME="nanoclaw-backup-${TIMESTAMP}"
TEMP_DIR="/tmp/${BACKUP_NAME}"
BACKUP_TAR="${TEMP_DIR}.tar.gz"
BACKUP_ENCRYPTED="${BACKUP_TAR}.gpg"

# Directories to backup
PROJECT_ROOT="/workspace/project"
DB_DIR="${PROJECT_ROOT}/store"
GROUPS_DIR="${PROJECT_ROOT}/groups"
CONFIG_DIR="${PROJECT_ROOT}/data"

# GPG passphrase (should be in env var)
GPG_PASSPHRASE="${BACKUP_PASSPHRASE:-changeme}"

# Google Drive folder ID (will be configured)
DRIVE_FOLDER_ID="${BACKUP_GDRIVE_FOLDER:-}"

# Retention: keep last N backups
RETENTION_COUNT=21  # 7 days * 3 backups/day

log() {
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*"
}

cleanup() {
    log "Cleaning up temporary files..."
    rm -rf "${TEMP_DIR}" "${BACKUP_TAR}" "${BACKUP_ENCRYPTED}"
}

trap cleanup EXIT

log "Starting backup: ${BACKUP_NAME}"

# Create temp directory structure
mkdir -p "${TEMP_DIR}/databases"
mkdir -p "${TEMP_DIR}/groups"
mkdir -p "${TEMP_DIR}/config"

# Copy databases
log "Backing up databases..."
find "${DB_DIR}" -type f \( -name "*.db" -o -name "*.sqlite" \) -exec cp {} "${TEMP_DIR}/databases/" \;

# Copy groups
log "Backing up groups..."
cp -r "${GROUPS_DIR}"/* "${TEMP_DIR}/groups/"

# Copy config
log "Backing up config..."
cp "${CONFIG_DIR}/registered_groups.json" "${TEMP_DIR}/config/" 2>/dev/null || true
cp -r "${CONFIG_DIR}/accounts" "${TEMP_DIR}/config/" 2>/dev/null || true

# Find and copy JSONL logs
log "Backing up event logs..."
find "${PROJECT_ROOT}" -type f -name "*.jsonl" -exec cp --parents {} "${TEMP_DIR}/" \; 2>/dev/null || true

# Generate manifest
log "Generating manifest..."
cat > "${TEMP_DIR}/manifest.json" <<EOF
{
  "backup_name": "${BACKUP_NAME}",
  "timestamp": "$(date -Iseconds)",
  "hostname": "$(hostname)",
  "nanoclaw_version": "$(cat ${PROJECT_ROOT}/package.json | grep version | head -1 | awk -F: '{ print $2 }' | sed 's/[",]//g' | tr -d ' ')",
  "files": [
$(find "${TEMP_DIR}" -type f ! -name "manifest.json" ! -name "checksums.sha256" -printf '    "%p",\n' | sed '$ s/,$//')
  ]
}
EOF

# Generate checksums
log "Generating checksums..."
(cd "${TEMP_DIR}" && find . -type f ! -name "checksums.sha256" -exec sha256sum {} \; > checksums.sha256)

# Create TAR
log "Creating TAR archive..."
tar -czf "${BACKUP_TAR}" -C "$(dirname ${TEMP_DIR})" "$(basename ${TEMP_DIR})"

# Encrypt
log "Encrypting backup..."
openssl enc -aes-256-cbc -salt -pbkdf2 -in "${BACKUP_TAR}" -out "${BACKUP_ENCRYPTED}" -pass pass:"${GPG_PASSPHRASE}"

# Get file size
BACKUP_SIZE=$(du -h "${BACKUP_ENCRYPTED}" | cut -f1)
log "Encrypted backup size: ${BACKUP_SIZE}"

# Upload to Google Drive
if [ -n "${DRIVE_FOLDER_ID}" ]; then
    log "Uploading to Google Drive..."
    UPLOAD_RESULT=$(node /home/node/.claude/skills/google-workspace/google-workspace.js drive upload \
        --account google \
        --file "${BACKUP_ENCRYPTED}" \
        --folder "${DRIVE_FOLDER_ID}" \
        --name "$(basename ${BACKUP_ENCRYPTED})")

    UPLOAD_ID=$(node -e "console.log(JSON.parse(process.argv[1]).id)" "$UPLOAD_RESULT")
    log "Upload complete: ${UPLOAD_ID}"

    # Cleanup old backups (keep last RETENTION_COUNT)
    log "Cleaning up old backups..."
    BACKUP_LIST=$(node /home/node/.claude/skills/google-workspace/google-workspace.js drive list \
        --account google \
        --folder "${DRIVE_FOLDER_ID}")

    # Sort by name (timestamp in filename) and delete oldest
    node -e "
        const data = JSON.parse(process.argv[1]);
        const backups = data.files
            .filter(f => f.name.startsWith('nanoclaw-backup-'))
            .map(f => [f.name, f.id])
            .sort((a, b) => b[0].localeCompare(a[0]));
        backups.slice(${RETENTION_COUNT}).forEach(b => console.log(b[1]));
    " "$BACKUP_LIST" | while read file_id; do
        node /home/node/.claude/skills/google-workspace/google-workspace.js drive delete \
            --account google \
            --id "${file_id}"
        log "Deleted old backup: ${file_id}"
    done
else
    log "WARNING: DRIVE_FOLDER_ID not set, backup not uploaded"
    log "Backup saved locally: ${BACKUP_ENCRYPTED}"
fi

log "Backup complete: ${BACKUP_NAME}"
log "Size: ${BACKUP_SIZE}"
