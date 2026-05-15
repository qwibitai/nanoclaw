#!/bin/bash
# Daily NanoClaw v2 backup — packages everything needed for a from-scratch
# restore on a new Mac into a single timestamped zip, mirrors to iCloud Drive,
# and rotates older backups.
#
# Three backup tiers:
#   1. Git in groups/ — fine-grained "undo a memory mistake" (already wired).
#   2. THIS SCRIPT, daily — full-state restore tarball, iCloud + optional external drive.
#   3. backup-weekly.sh — same tarball, uploaded to Cloudflare R2 for offsite.
#
# What's in the zip:
#   - groups/                     all per-agent memory + briefs + .git history
#   - data/v2.db                  central host DB (agent_groups, messaging_groups, OneCLI agent IDs)
#   - data/v2-sessions/           per-session inbound.db + outbound.db (scheduled tasks survive)
#   - data/env, .env              credentials
#   - .claude-shared/projects/    Claude Code conversation transcripts
#   - container.json files        agent container configs
#   - container/CLAUDE.md         shared agent base instructions
#
# Restore: see scripts/restore-from-backup.sh

set -eu
shopt -s nullglob

REPO=/Users/ilansolot/nanoclaw-v2
GDRIVE_DAILY="/Users/ilansolot/Library/CloudStorage/GoogleDrive-isolot@gmail.com/My Drive/NanoClaw-Backups/daily"
EXTERNAL_DRIVE=/Volumes/NanoClawBackup     # written if mounted, skipped otherwise
RETAIN_LOCAL_DAYS=14
RETAIN_GDRIVE_DAYS=30
RETAIN_EXTERNAL_DAYS=90

DATE=$(date +%Y-%m-%d)
TIME=$(date +%H%M)
HOST=$(hostname -s)
NAME="nanoclaw-v2-${DATE}-${TIME}-${HOST}.zip"

LOCAL_DIR="${REPO}/backups"
mkdir -p "${LOCAL_DIR}"

cd "${REPO}"

echo "[backup-daily] building ${NAME}"

# Build the archive with predictable, restore-friendly paths. Excludes anything
# regenerated on spawn or noisy.
zip -r -q "${LOCAL_DIR}/${NAME}" \
  groups/ \
  data/v2.db \
  data/v2-sessions/ \
  data/env \
  .env \
  container/CLAUDE.md \
  -x \
  'groups/*/podcast/output/*.mp3' \
  'groups/*/podcast/output/*.txt' \
  'groups/*/podcast/node_modules/*' \
  'groups/*/podcast/package-lock.json' \
  'groups/*/podcast/.venv/*' \
  'groups/*/podcast/.pycache/*' \
  'groups/*/podcast/__pycache__/*' \
  'groups/*/.pnpm-store/*' \
  'groups/*/CLAUDE.md' \
  'groups/*/.claude-shared.md' \
  'groups/*/.claude-fragments/*' \
  'data/v2-sessions/*/sess-*/v2-sessions/*' \
  'data/v2-sessions/*/sess-*/.heartbeat' \
  '*.tmp-*' \
  '.DS_Store' \
  2>&1 | tail -5

# Conversation transcripts live outside the project root in v1's location, but in v2
# they're under data/ already. If a separate .claude-shared exists, fold it in.
if [ -d "${REPO}/.claude-shared" ]; then
  zip -r -q -g "${LOCAL_DIR}/${NAME}" .claude-shared/ \
    -x '.claude-shared/*.tmp-*' '.claude-shared/.DS_Store' 2>&1 | tail -3
fi

LOCAL_SIZE=$(du -h "${LOCAL_DIR}/${NAME}" | awk '{print $1}')
echo "[backup-daily] local: ${LOCAL_DIR}/${NAME} (${LOCAL_SIZE})"

# Mirror to Google Drive (auto-syncs to Google's servers)
mkdir -p "${GDRIVE_DAILY}"
cp "${LOCAL_DIR}/${NAME}" "${GDRIVE_DAILY}/${NAME}"
echo "[backup-daily] Google Drive: ${GDRIVE_DAILY}/${NAME}"

# Mirror to external drive if mounted
if [ -d "${EXTERNAL_DRIVE}" ]; then
  cp "${LOCAL_DIR}/${NAME}" "${EXTERNAL_DRIVE}/${NAME}"
  echo "[backup-daily] external: ${EXTERNAL_DRIVE}/${NAME}"
else
  echo "[backup-daily] external drive not mounted — skipping"
fi

# Rotate
echo "[backup-daily] rotating older zips"
find "${LOCAL_DIR}" -maxdepth 1 -name 'nanoclaw-v2-*.zip' -mtime "+${RETAIN_LOCAL_DAYS}" -print -delete | sed 's/^/  local-pruned: /' || true
find "${GDRIVE_DAILY}" -maxdepth 1 -name 'nanoclaw-v2-*.zip' -mtime "+${RETAIN_GDRIVE_DAYS}" -print -delete 2>/dev/null | sed 's/^/  gdrive-pruned: /' || true
if [ -d "${EXTERNAL_DRIVE}" ]; then
  find "${EXTERNAL_DRIVE}" -maxdepth 1 -name 'nanoclaw-v2-*.zip' -mtime "+${RETAIN_EXTERNAL_DAYS}" -print -delete 2>/dev/null | sed 's/^/  external-pruned: /' || true
fi

echo "[backup-daily] done"
