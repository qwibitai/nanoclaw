#!/bin/bash
# Weekly NanoClaw v2 backup — promotes the most recent daily zip into Google
# Drive's weekly/ folder for long-term retention.
#
# This is the "long-tail" backup. backup-daily.sh keeps 30 days of dailies in
# Google Drive's daily/ folder; this script keeps 12 weeks of weekly snapshots
# in Drive's weekly/ folder so older state is recoverable beyond the 30-day
# daily window.
#
# Both folders live under the same Google Drive — Drive itself is the offsite
# tier. We rely on Drive's sync to Google's servers for "another data centre"
# redundancy, same way iCloud syncs to Apple's servers.

set -eu

REPO=/Users/ilansolot/nanoclaw-v2
LOCAL_DIR="${REPO}/backups"
GDRIVE_WEEKLY="/Users/ilansolot/Library/CloudStorage/GoogleDrive-isolot@gmail.com/My Drive/NanoClaw-Backups/weekly"
RETAIN_WEEKLY_DAYS=90    # 12-13 weeks of weekly snapshots

# Find the most recent daily zip
LATEST=$(ls -t "${LOCAL_DIR}"/nanoclaw-v2-*.zip 2>/dev/null | head -n1 || true)
if [ -z "${LATEST}" ]; then
  echo "[backup-weekly] no daily zip in ${LOCAL_DIR} — run backup-daily.sh first" >&2
  exit 0
fi

NAME=$(basename "${LATEST}")
mkdir -p "${GDRIVE_WEEKLY}"
cp "${LATEST}" "${GDRIVE_WEEKLY}/${NAME}"
echo "[backup-weekly] promoted ${NAME} → ${GDRIVE_WEEKLY}/"

# Rotate
find "${GDRIVE_WEEKLY}" -maxdepth 1 -name 'nanoclaw-v2-*.zip' -mtime "+${RETAIN_WEEKLY_DAYS}" -print -delete 2>/dev/null \
  | sed 's/^/  pruned: /' || true

echo "[backup-weekly] done"
