#!/bin/bash
# Daily Discord digest — run via launchd at 9 AM
# Token loaded from nanoclaw .env file
set -a
source /Users/topcoder1/dev/nanoclaw/.env
set +a
exec /usr/bin/python3 /Users/topcoder1/dev/nanoclaw/scripts/discord-digest.py >> /tmp/discord-digest.log 2>&1
