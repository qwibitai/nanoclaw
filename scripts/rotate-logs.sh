#!/bin/bash
# Size-based log rotation for nanoclaw logs.
#
# launchd's StandardOutPath/StandardErrorPath opens the log files in append
# mode and keeps the FD open for the lifetime of the process. Append mode
# atomically seeks-to-end on every write, so truncating the file in place
# (: > file) makes subsequent writes start at position 0 — no sparse file,
# no FD surgery, no nanoclaw restart.
#
# Rotation rule: if a log exceeds MAX_SIZE_MB, snapshot it to .1, truncate
# the live file, gzip the snapshot, and shift older archives. Keeps at most
# three compressed archives per log.

set -e

LOGDIR="/Users/gabrielratner/projects/nanoclaw/logs"
MAX_SIZE_MB=50

rotate_if_big() {
  local f="$1"
  [ -f "$f" ] || return 0
  local size_mb
  size_mb=$(du -m "$f" | cut -f1)
  if [ "$size_mb" -le "$MAX_SIZE_MB" ]; then
    return 0
  fi

  echo "Rotating $f (${size_mb}MB > ${MAX_SIZE_MB}MB)"

  # Shift existing archives
  [ -f "${f}.2.gz" ] && mv "${f}.2.gz" "${f}.3.gz"
  [ -f "${f}.1.gz" ] && mv "${f}.1.gz" "${f}.2.gz"

  # Snapshot + truncate (nanoclaw keeps writing in append mode, safe)
  cp "$f" "${f}.1"
  : > "$f"

  gzip -f "${f}.1"
}

rotate_if_big "$LOGDIR/nanoclaw.log"
rotate_if_big "$LOGDIR/nanoclaw.error.log"
