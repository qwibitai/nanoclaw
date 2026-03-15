#!/usr/bin/env bash
# migration-revert.sh — Switch back to OpenClaw from NanoClaw
#
# Run this to revert the production migration if something goes wrong.
# This stops NanoClaw, starts OpenClaw's gateway, and switches bridge routing.

set -e

echo "Reverting to OpenClaw..."

# Stop NanoClaw
systemctl --user stop nanoclaw

# Start OpenClaw gateway
systemctl --user start openclaw-gateway

# Switch bridge routing back to OpenClaw
curl -X PUT http://localhost:3099/admin/targets \
  -H "Content-Type: application/json" \
  -d '{"target":"openclaw"}'

echo "Done. OpenClaw is now active."
