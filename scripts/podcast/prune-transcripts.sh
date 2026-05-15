#!/bin/bash
# Manual / scheduled prune of the transcript library.
# Default retention: 365 days. Override with PODCAST_TRANSCRIPT_RETENTION_DAYS.
#
# This is a safety net for explicit housekeeping. The ingest pipeline keeps
# transcripts by default because the library is meant to be reused.

set -eu

REPO=/Users/ilansolot/nanoclaw-v2
RETENTION_DAYS=${PODCAST_TRANSCRIPT_RETENTION_DAYS:-365}

# Find every podcast/library/transcripts directory across all agent groups
shopt -s nullglob
for libroot in "${REPO}"/groups/*/podcast/library/transcripts; do
  [ -d "${libroot}" ] || continue

  echo "[prune-transcripts] ${libroot} (retention: ${RETENTION_DAYS}d)"
  before=$(find "${libroot}" -type d -mindepth 3 -maxdepth 3 2>/dev/null | wc -l | tr -d ' ')

  # Episode dirs sit at depth 3: <feed>/<source>/<episode-id>/
  # Use mtime as the prune signal — matches ingest-transcripts.mjs createdAt
  # within minutes, and survives without metadata.json being present.
  find "${libroot}" -mindepth 3 -maxdepth 3 -type d -mtime "+${RETENTION_DAYS}" -print -exec rm -rf {} + 2>/dev/null \
    | sed 's|^|  pruned: |'

  # Drop empty source / feed dirs left behind
  find "${libroot}" -mindepth 1 -maxdepth 2 -type d -empty -delete 2>/dev/null

  after=$(find "${libroot}" -type d -mindepth 3 -maxdepth 3 2>/dev/null | wc -l | tr -d ' ')
  removed=$((before - after))
  echo "[prune-transcripts] ${removed} episode dir(s) removed (${after} remaining)"
done
