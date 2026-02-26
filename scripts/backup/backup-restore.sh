#!/bin/bash
set -euo pipefail

# NanoClaw Backup Restore Script
# Restores encrypted backup from Google Drive

MODE="${1:-}"
BACKUP_ID="${2:-}"

GPG_PASSPHRASE="${BACKUP_PASSPHRASE:-changeme}"
DRIVE_FOLDER_ID="${BACKUP_GDRIVE_FOLDER:-}"
PROJECT_ROOT="/workspace/project"

log() {
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*"
}

usage() {
    cat <<EOF
Usage: $0 <mode> [backup_id]

Modes:
  --list              List available backups
  --preview <id>      Preview what would be restored
  --restore <id>      Restore backup (interactive)
  --force <id>        Restore backup (no confirmation)

Examples:
  $0 --list
  $0 --preview nanoclaw-backup-20260225-060000
  $0 --restore nanoclaw-backup-20260225-060000
  $0 --force nanoclaw-backup-20260225-060000
EOF
    exit 1
}

list_backups() {
    log "Listing available backups..."
    if [ -z "${DRIVE_FOLDER_ID}" ]; then
        log "ERROR: DRIVE_FOLDER_ID not set"
        exit 1
    fi

    BACKUP_LIST=$(node /home/node/.claude/skills/google-workspace/google-workspace.js drive list \
        --account google \
        --folder "${DRIVE_FOLDER_ID}")

    node -e "const d=JSON.parse(process.argv[1]);d.files.filter(f=>f.name.startsWith('nanoclaw-backup-')).forEach(f=>console.log(`${f.name} - ${f.size} bytes - ${f.modifiedTime}`))" "$BACKUP_LIST" | sort -r
}

preview_backup() {
    local backup_name="$1"
    log "Previewing backup: ${backup_name}"

    local temp_encrypted="/tmp/${backup_name}"
    local temp_tar="/tmp/${backup_name%.tar.gz.gpg}.zip"
    local temp_dir="/tmp/${backup_name%.tar.gz.gpg}"

    # Get file ID from Drive
    BACKUP_LIST=$(node /home/node/.claude/skills/google-workspace/google-workspace.js drive list \
        --account google \
        --folder "${DRIVE_FOLDER_ID}")

    BACKUP_ID=$(node -e "console.log(JSON.parse(process.argv[1]).files.find(f=>f.name===process.argv[2])?.id||'')" "$BACKUP_LIST" "${backup_name}")
    if [ -z "$BACKUP_ID" ]; then
        log "ERROR: Backup not found: ${backup_name}"
        exit 1
    fi

    # Download
    log "Downloading backup..."
    node /home/node/.claude/skills/google-workspace/google-workspace.js drive download \
        --account google \
        --id "${BACKUP_ID}" \
        --output "${temp_encrypted}"

    # Decrypt
    log "Decrypting backup..."
    openssl enc -aes-256-cbc -d -pbkdf2 -in "${temp_encrypted}" -out "${temp_tar}" -pass pass:"${GPG_PASSPHRASE}"

    # Extract
    log "Extracting backup..."
    tar -xzf "${temp_tar}" --directory=/tmp/

    # Show manifest
    log "Backup contents:"
    cat "${temp_dir}/manifest.json"

    # Cleanup
    rm -rf "${temp_encrypted}" "${temp_tar}" "${temp_dir}" 2>/dev/null || true
}

restore_backup() {
    local backup_name="$1"
    local force="${2:-no}"

    log "Restoring backup: ${backup_name}"

    if [ "${force}" != "yes" ]; then
        read -p "This will overwrite current data. Continue? [y/N] " -n 1 -r
        echo
        if [[ ! $REPLY =~ ^[Yy]$ ]]; then
            log "Restore cancelled"
            exit 0
        fi
    fi

    local temp_encrypted="/tmp/${backup_name}.tar.gz.gpg"
    local temp_tar="/tmp/${backup_name}.zip"
    local temp_dir="/tmp/${backup_name}"

    cleanup_temp() {
        rm -rf "${temp_encrypted}" "${temp_tar}" "${temp_dir}"
    }
    trap cleanup_temp EXIT

    # Get file ID from Drive
    BACKUP_LIST=$(node /home/node/.claude/skills/google-workspace/google-workspace.js drive list \
        --account google \
        --folder "${DRIVE_FOLDER_ID}")

    BACKUP_ID=$(node -e "console.log(JSON.parse(process.argv[1]).files.find(f=>f.name===process.argv[2])?.id||'')" "$BACKUP_LIST" "${backup_name}")
    if [ -z "$BACKUP_ID" ]; then
        log "ERROR: Backup not found: ${backup_name}"
        exit 1
    fi

    # Download
    log "Downloading backup from Google Drive..."
    node /home/node/.claude/skills/google-workspace/google-workspace.js drive download \
        --account google \
        --id "${BACKUP_ID}" \
        --output "${temp_encrypted}"

    # Decrypt
    log "Decrypting backup..."
    openssl enc -aes-256-cbc -d -pbkdf2 -in "${temp_encrypted}" -out "${temp_tar}" -pass pass:"${GPG_PASSPHRASE}"

    # Extract
    log "Extracting backup..."
    tar -xzf "${temp_tar}" --directory=/tmp/

    # Verify checksums
    log "Verifying integrity..."
    (cd "${temp_dir}" && sha256sum -c checksums.sha256 --quiet)
    log "Integrity check passed"

    # Read manifest
    log "Reading manifest..."
    cat "${temp_dir}/manifest.json"

    # Restore databases
    log "Restoring databases..."
    cp -v "${temp_dir}/databases"/* "${PROJECT_ROOT}/store/"

    # Restore groups
    log "Restoring groups..."
    cp -rv "${temp_dir}/groups"/* "${PROJECT_ROOT}/groups/"

    # Restore config
    log "Restoring config..."
    cp -v "${temp_dir}/config/registered_groups.json" "${PROJECT_ROOT}/data/" 2>/dev/null || true
    cp -rv "${temp_dir}/config/accounts" "${PROJECT_ROOT}/data/" 2>/dev/null || true

    log "Restore complete!"
    log "IMPORTANT: Restart NanoClaw to apply restored data"
}

case "${MODE}" in
    --list)
        list_backups
        ;;
    --preview)
        if [ -z "${BACKUP_ID}" ]; then
            usage
        fi
        preview_backup "${BACKUP_ID}"
        ;;
    --restore)
        if [ -z "${BACKUP_ID}" ]; then
            usage
        fi
        restore_backup "${BACKUP_ID}" "no"
        ;;
    --force)
        if [ -z "${BACKUP_ID}" ]; then
            usage
        fi
        restore_backup "${BACKUP_ID}" "yes"
        ;;
    *)
        usage
        ;;
esac
