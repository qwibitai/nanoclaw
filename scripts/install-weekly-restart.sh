#!/bin/bash
# Run this once with sudo to install the weekly Sunday 3am restart daemon.
# Usage: sudo bash ~/NanoClaw/scripts/install-weekly-restart.sh

set -e
PLIST_SRC="$HOME/NanoClaw/scripts/com.gabrielratner.weekly-restart.plist"
PLIST_DST="/Library/LaunchDaemons/com.gabrielratner.weekly-restart.plist"

cp "$PLIST_SRC" "$PLIST_DST"
chown root:wheel "$PLIST_DST"
chmod 644 "$PLIST_DST"
launchctl load "$PLIST_DST"
echo "Weekly restart daemon installed. Will restart every Sunday at 3:00am."
launchctl list | grep weekly-restart
