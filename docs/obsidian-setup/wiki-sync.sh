#!/usr/bin/env bash
# Syncs the Obsidian vault with NanoClaw on the Pi.
# Run by launchd every 2 minutes on Mac Mini.
#
# Pull:  Pi wiki pages  → iCloud vault/wiki/   (read wiki in Obsidian)
# Push:  iCloud clippings/ → Pi articles/      (clippings flow into NanoClaw)

PI_USER="snecvb"
PI_HOST="192.168.5.201"
PI_WIKI="$PI_USER@$PI_HOST:/home/snecvb/vbprojects/nanoclaw/groups/global/wiki/"
PI_ARTICLES="$PI_USER@$PI_HOST:/home/snecvb/vbprojects/nanoclaw/groups/global/articles/"

VAULT="$HOME/Library/Mobile Documents/iCloud~md~obsidian/Documents/VBWiki"
CLIPPINGS="$VAULT/clippings/"
LOCAL_WIKI="$VAULT/wiki/"

mkdir -p "$CLIPPINGS" "$LOCAL_WIKI"

# Pull wiki from Pi (Pi is authoritative — delete local pages that no longer exist)
rsync -az --delete \
  -e "ssh -o StrictHostKeyChecking=no -o ConnectTimeout=5" \
  "$PI_WIKI" "$LOCAL_WIKI" \
  >> /tmp/nanoclaw-wiki-sync.log 2>&1

# Push new clippings to Pi (no --delete — Pi accumulates for ingestion)
rsync -az \
  -e "ssh -o StrictHostKeyChecking=no -o ConnectTimeout=5" \
  "$CLIPPINGS" "$PI_ARTICLES" \
  >> /tmp/nanoclaw-wiki-sync.log 2>&1
