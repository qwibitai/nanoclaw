#!/bin/bash
# Sync iMessage database to nanoclaw staging area
# Uses WAL checkpoint + copy to get a consistent snapshot
SRC=~/Library/Messages/chat.db
DST=/Users/gabrielratner/projects/nanoclaw/data/imessage-staging/chat.db

# Only copy if source is newer than destination
if [ "$SRC" -nt "$DST" ]; then
  cp "$SRC" "$DST"
  cp "${SRC}-shm" "${DST}-shm" 2>/dev/null
  cp "${SRC}-wal" "${DST}-wal" 2>/dev/null
fi
