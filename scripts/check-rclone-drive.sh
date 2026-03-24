#!/bin/bash
# Check if Proton Drive rclone access has been unblocked.
# Sends a Signal notification when it works, then removes itself from cron.

export XDG_RUNTIME_DIR="/run/user/$(id -u)"
export DBUS_SESSION_BUS_ADDRESS="unix:path=$XDG_RUNTIME_DIR/bus"

SIGNAL_RPC_HOST="127.0.0.1"
SIGNAL_RPC_PORT="7583"
SCOTT_JID="198c1cdb-8856-4ac7-9b84-a504a0017c79"

if rclone lsd protondrive: >/dev/null 2>&1; then
  # It works! Notify Scott and remove this cron job
  payload=$(printf '{"jsonrpc":"2.0","method":"send","id":%d,"params":{"recipients":["%s"],"message":"%s"}}' \
    "$(date +%s)" "$SCOTT_JID" "✅ Proton Drive rclone access is unblocked. Jorgenclaw can now set up nightly backups.")
  echo "$payload" | timeout 5 nc -q1 "$SIGNAL_RPC_HOST" "$SIGNAL_RPC_PORT" >/dev/null 2>&1
  # Remove this job from cron
  crontab -l | grep -v 'check-rclone-drive' | crontab -
fi
