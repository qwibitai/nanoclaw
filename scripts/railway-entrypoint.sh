#!/bin/bash
# Railway entrypoint: starts the NanoClaw Node.js app directly.
# No Docker daemon needed — agents run as child processes.

set -e

echo "[entrypoint] Starting NanoClaw..."
cd /app
exec node dist/index.js
