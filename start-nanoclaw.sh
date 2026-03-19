#!/bin/bash
# start-nanoclaw.sh — Start NanoClaw with docker group active
# Needed because systemd user session may not inherit docker group from /etc/group
exec sg docker -c "/usr/bin/node /home/jkeyser/nanoclaw/dist/index.js"
