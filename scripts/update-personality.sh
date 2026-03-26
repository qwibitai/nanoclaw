#!/bin/bash
# Update a group's CLAUDE.md personality on production
# Usage: ./scripts/update-personality.sh <group-folder>
# Example: ./scripts/update-personality.sh whatsapp_nanoprueba
#
# Copies the local groups/<folder>/CLAUDE.md to prod.
# No restart needed — takes effect on next agent spawn.

set -euo pipefail

GROUP="${1:-}"
if [ -z "$GROUP" ]; then
  echo "Usage: $0 <group-folder>"
  echo ""
  echo "Available groups with CLAUDE.md:"
  ls -1 groups/*/CLAUDE.md 2>/dev/null | sed 's|groups/||;s|/CLAUDE.md||' | while read g; do
    echo "  $g"
  done
  exit 1
fi

LOCAL="groups/${GROUP}/CLAUDE.md"
if [ ! -f "$LOCAL" ]; then
  echo "Error: $LOCAL not found"
  exit 1
fi

PROD_IP="134.199.239.173"
REMOTE="/home/nanoclaw/app/groups/${GROUP}/CLAUDE.md"

scp "$LOCAL" "root@${PROD_IP}:${REMOTE}"
ssh "root@${PROD_IP}" "chown nanoclaw:nanoclaw ${REMOTE}"

echo "✓ Updated ${GROUP} personality on prod"
echo "  No restart needed — active on next message"
