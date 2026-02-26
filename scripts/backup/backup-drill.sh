#!/bin/bash
set -euo pipefail

# NanoClaw Backup Integrity Drill
# Validates latest backup without modifying filesystem

GPG_PASSPHRASE="${NANOCLAW_BACKUP_PASSPHRASE:-changeme}"
DRIVE_FOLDER_ID="${NANOCLAW_BACKUP_DRIVE_FOLDER:-}"

log() {
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*"
}

drill_log="/workspace/group/tasks/nanoclaw-backup/drill.log"

{
    log "========================================="
    log "Starting backup integrity drill"
    log "========================================="

    if [ -z "${DRIVE_FOLDER_ID}" ]; then
        log "ERROR: DRIVE_FOLDER_ID not set"
        exit 1
    fi

    # Get latest backup
    log "Finding latest backup..."
    BACKUP_LIST=$(node /home/node/.claude/skills/google-workspace/google-workspace.js drive list \
        --account google \
        --folder "${DRIVE_FOLDER_ID}")

    latest_backup=$(node -e "console.log(JSON.parse(process.argv[1]).files.filter(f=>f.name.startsWith('nanoclaw-backup-')).sort((a,b)=>b.name.localeCompare(a.name))[0]?.name||'')" "$BACKUP_LIST")
    backup_id=$(node -e "console.log(JSON.parse(process.argv[1]).files.find(f=>f.name===process.argv[2])?.id||'')" "$BACKUP_LIST" "${latest_backup}")

    if [ -z "${latest_backup}" ]; then
        log "ERROR: No backups found"
        exit 1
    fi

    log "Latest backup: ${latest_backup}"

    temp_encrypted="/tmp/${latest_backup}"
    temp_tar="${temp_encrypted%.gpg}"
    temp_dir="/tmp/drill-$(date +%s)"

    cleanup() {
        rm -rf "${temp_encrypted}" "${temp_tar}" "${temp_dir}"
    }
    trap cleanup EXIT

    # Download
    log "Test 1/5: Download from Google Drive..."
    node /home/node/.claude/skills/google-workspace/google-workspace.js drive download \
        --account google \
        --id "${backup_id}" \
        --output "${temp_encrypted}" > /dev/null
    log "PASS: Downloaded ${latest_backup}"

    # Decrypt
    log "Test 2/5: GPG decryption..."
    openssl enc -aes-256-cbc -d -pbkdf2 -in "${temp_encrypted}" -out "${temp_tar}" -pass pass:"${GPG_PASSPHRASE}"
    log "PASS: Decryption successful"

    # Extract
    log "Test 3/5: TAR extraction..."
    tar -xzf "${temp_tar}" -C /tmp
    # Get extracted directory name from backup name
    extracted_dir=$(basename "${latest_backup}" .tar.gz.gpg)
    log "PASS: Extraction successful"

    # Verify checksums
    log "Test 4/5: Checksum verification..."
    (cd "/tmp/${extracted_dir}" && sha256sum -c checksums.sha256 --quiet)
    log "PASS: All checksums valid"

    # Parse manifest
    log "Test 5/5: Manifest parsing..."
    manifest_json=$(cat "/tmp/${extracted_dir}/manifest.json")
    backup_timestamp=$(node -e "console.log(JSON.parse(process.argv[1]).timestamp)" "$manifest_json")
    file_count=$(node -e "console.log(JSON.parse(process.argv[1]).files.length)" "$manifest_json")
    log "PASS: Manifest valid - ${file_count} files, timestamp ${backup_timestamp}"

    log "========================================="
    log "Drill complete - ALL TESTS PASSED"
    log "Status: OK"
    log "========================================="

} | tee -a "${drill_log}"
