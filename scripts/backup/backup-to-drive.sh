#!/bin/bash
# Nightly backup of NanoClaw critical data to personal Google Drive.
# Creates a timestamped tar.gz archive and uploads via the Gmail MCP OAuth credentials.

set -e

PROJECT_DIR="/Users/gabrielratner/projects/nanoclaw"
STAGING_DIR="/tmp/nanoclaw-backup"
TIMESTAMP=$(date +%Y-%m-%d_%H%M%S)
ARCHIVE_NAME="nanoclaw-backup-${TIMESTAMP}.tar.gz"
LOG_FILE="${PROJECT_DIR}/logs/backup/backup.log"

exec >> "$LOG_FILE" 2>&1
echo ""
echo "=== Backup run: $(date) ==="

rm -rf "$STAGING_DIR"
mkdir -p "$STAGING_DIR"

# Integrity-check source before backing up. A corrupt DB should fail loudly,
# not get silently mirrored off-site for 14 days until the local copy is gone too.
SOURCE_CHECK=$(sqlite3 "${PROJECT_DIR}/store/messages.db" "PRAGMA integrity_check;" 2>&1 | head -1)
if [ "$SOURCE_CHECK" != "ok" ]; then
  echo "ERROR: source DB integrity_check failed: $SOURCE_CHECK"
  echo "Aborting off-site backup. Run .recover manually and inspect."
  exit 2
fi

# Use SQLite .backup to get a consistent snapshot of the live database
sqlite3 "${PROJECT_DIR}/store/messages.db" ".backup '${STAGING_DIR}/messages.db'"
echo "SQLite snapshot: $(ls -lh ${STAGING_DIR}/messages.db | awk '{print $5}')"

# Verify the snapshot before shipping it to Drive
SNAPSHOT_CHECK=$(sqlite3 "${STAGING_DIR}/messages.db" "PRAGMA integrity_check;" 2>&1 | head -1)
if [ "$SNAPSHOT_CHECK" != "ok" ]; then
  echo "ERROR: snapshot failed integrity_check: $SNAPSHOT_CHECK"
  exit 3
fi

# Copy critical configuration files
cp "${PROJECT_DIR}/.env" "${STAGING_DIR}/.env" 2>/dev/null || echo "WARN: .env not found"
cp "${PROJECT_DIR}/nanoclawrules.md" "${STAGING_DIR}/nanoclawrules.md" 2>/dev/null || true

# Copy all group CLAUDE.md files
mkdir -p "${STAGING_DIR}/groups"
for group_dir in "${PROJECT_DIR}/groups/"*/; do
    group_name=$(basename "$group_dir")
    if [ -f "${group_dir}CLAUDE.md" ]; then
        mkdir -p "${STAGING_DIR}/groups/${group_name}"
        cp "${group_dir}CLAUDE.md" "${STAGING_DIR}/groups/${group_name}/CLAUDE.md"
    fi
done

# Copy LaunchAgent plists
mkdir -p "${STAGING_DIR}/launchagents"
for plist in com.nanoclaw.plist com.nanoclaw-dashboard.plist com.nanoclaw.token-sync.plist com.nanoclaw.imessage-sync.plist com.nanoclaw.contacts-sync.plist com.docker.desktop.plist com.outlook.token-refresh.plist; do
    src="${HOME}/Library/LaunchAgents/${plist}"
    if [ -f "$src" ]; then
        cp "$src" "${STAGING_DIR}/launchagents/${plist}"
    fi
done

# Copy Gmail and Outlook OAuth credentials (required to restore)
mkdir -p "${STAGING_DIR}/credentials"
cp -r "${HOME}/.gmail-mcp/" "${STAGING_DIR}/credentials/gmail-mcp/" 2>/dev/null || true
cp -r "${HOME}/.outlook-mcp/" "${STAGING_DIR}/credentials/outlook-mcp/" 2>/dev/null || true

# Archive and compress
cd /tmp
tar -czf "${ARCHIVE_NAME}" -C "${STAGING_DIR}" .
ARCHIVE_SIZE=$(ls -lh "${ARCHIVE_NAME}" | awk '{print $5}')
echo "Archive created: ${ARCHIVE_NAME} (${ARCHIVE_SIZE})"

# Upload to Google Drive using the existing gmail-mcp OAuth credentials.
# We use a small Python helper that calls the Google Drive API directly
# with the refresh token from credentials.json. This avoids needing gog or
# any additional CLI tool, and reuses the tokens already in place.
python3 - <<PYEOF
import json, os, sys, urllib.request, urllib.parse

CREDS_PATH = os.path.expanduser('~/.gmail-mcp/credentials.json')
KEYS_PATH = os.path.expanduser('~/.gmail-mcp/gcp-oauth.keys.json')
ARCHIVE = '/tmp/${ARCHIVE_NAME}'
BACKUP_FOLDER_NAME = 'NanoClaw Backups'

with open(CREDS_PATH) as f:
    creds = json.load(f)
with open(KEYS_PATH) as f:
    keys = json.load(f)

client = keys.get('installed') or keys.get('web') or {}
client_id = client['client_id']
client_secret = client['client_secret']
refresh_token = creds['refresh_token']

# Refresh access token
token_req = urllib.request.Request(
    'https://oauth2.googleapis.com/token',
    data=urllib.parse.urlencode({
        'client_id': client_id,
        'client_secret': client_secret,
        'refresh_token': refresh_token,
        'grant_type': 'refresh_token',
    }).encode(),
    method='POST',
)
with urllib.request.urlopen(token_req) as resp:
    access_token = json.loads(resp.read())['access_token']

auth_header = {'Authorization': f'Bearer {access_token}'}

# Find or create the backup folder
search_q = urllib.parse.quote(f"mimeType='application/vnd.google-apps.folder' and name='{BACKUP_FOLDER_NAME}' and trashed=false")
search_req = urllib.request.Request(
    f'https://www.googleapis.com/drive/v3/files?q={search_q}&fields=files(id,name)',
    headers=auth_header,
)
with urllib.request.urlopen(search_req) as resp:
    folders = json.loads(resp.read()).get('files', [])

if folders:
    folder_id = folders[0]['id']
    print(f'Using existing backup folder: {folder_id}')
else:
    create_req = urllib.request.Request(
        'https://www.googleapis.com/drive/v3/files',
        data=json.dumps({
            'name': BACKUP_FOLDER_NAME,
            'mimeType': 'application/vnd.google-apps.folder',
        }).encode(),
        headers={**auth_header, 'Content-Type': 'application/json'},
        method='POST',
    )
    with urllib.request.urlopen(create_req) as resp:
        folder_id = json.loads(resp.read())['id']
    print(f'Created backup folder: {folder_id}')

# Upload the archive
with open(ARCHIVE, 'rb') as f:
    data = f.read()

metadata = {'name': os.path.basename(ARCHIVE), 'parents': [folder_id]}
boundary = '----nanoclawbackup'
body = (
    f'--{boundary}\r\n'
    'Content-Type: application/json; charset=UTF-8\r\n\r\n'
    f'{json.dumps(metadata)}\r\n'
    f'--{boundary}\r\n'
    'Content-Type: application/gzip\r\n\r\n'
).encode() + data + f'\r\n--{boundary}--\r\n'.encode()

upload_req = urllib.request.Request(
    'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart',
    data=body,
    headers={
        **auth_header,
        'Content-Type': f'multipart/related; boundary={boundary}',
        'Content-Length': str(len(body)),
    },
    method='POST',
)
with urllib.request.urlopen(upload_req) as resp:
    result = json.loads(resp.read())
    print(f'Uploaded: {result.get("id")}')

# Retention: keep the last 14 backups, delete older ones
list_params = urllib.parse.urlencode({
    'q': f"'{folder_id}' in parents and trashed=false",
    'fields': 'files(id,name,createdTime)',
    'orderBy': 'createdTime desc',
})
list_req = urllib.request.Request(
    f'https://www.googleapis.com/drive/v3/files?{list_params}',
    headers=auth_header,
)
with urllib.request.urlopen(list_req) as resp:
    files = json.loads(resp.read()).get('files', [])

to_delete = files[14:]  # keep newest 14
for old in to_delete:
    del_req = urllib.request.Request(
        f'https://www.googleapis.com/drive/v3/files/{old["id"]}',
        headers=auth_header,
        method='DELETE',
    )
    try:
        urllib.request.urlopen(del_req).read()
        print(f'Deleted old backup: {old["name"]}')
    except Exception as e:
        print(f'WARN: failed to delete {old["name"]}: {e}')

print('Backup complete.')
PYEOF

# Clean up staging
rm -rf "$STAGING_DIR"
rm -f "/tmp/${ARCHIVE_NAME}"

echo "=== Backup run finished: $(date) ==="
