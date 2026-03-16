#!/bin/bash
# NanoClaw 维护脚本
# Usage: ~/nanoclaw/scripts/maintain.sh [command]

NC_DIR="$HOME/nanoclaw"
DB="$NC_DIR/store/messages.db"
LOG="$NC_DIR/logs/nanoclaw.log"
ERR_LOG="$NC_DIR/logs/nanoclaw.error.log"
PORT=3001

# 杀掉 NanoClaw 进程并等待退出，超时 kill -9
stop_nanoclaw() {
  local PID=$(pgrep -f "nanoclaw/dist/index.js")
  if [ -z "$PID" ]; then return 0; fi
  kill $PID 2>/dev/null
  for i in $(seq 1 10); do
    if ! kill -0 $PID 2>/dev/null; then return 0; fi
    sleep 1
  done
  echo "Force killing PID $PID..."
  kill -9 $PID 2>/dev/null
  sleep 1
}

# 确保端口没被占用
clear_port() {
  local PORT_PID=$(lsof -ti:$PORT 2>/dev/null)
  if [ -n "$PORT_PID" ]; then
    echo "Port $PORT in use by PID $PORT_PID, killing..."
    kill $PORT_PID 2>/dev/null
    sleep 2
    # 如果还在就 kill -9
    PORT_PID=$(lsof -ti:$PORT 2>/dev/null)
    if [ -n "$PORT_PID" ]; then
      kill -9 $PORT_PID 2>/dev/null
      sleep 1
    fi
  fi
}

case "${1:-status}" in
  status)
    echo "=== NanoClaw Status ==="
    PID=$(pgrep -f "nanoclaw/dist/index.js")
    if [ -n "$PID" ]; then
      echo "✅ Running (PID: $PID)"
    else
      echo "❌ Not running"
    fi
    echo ""
    echo "=== Containers ==="
    docker ps --filter "name=nanoclaw" --format "  {{.Names}} — {{.Status}}" 2>/dev/null || echo "  No containers"
    echo ""
    echo "=== Registered Groups ==="
    sqlite3 "$DB" "SELECT folder, jid, requires_trigger FROM registered_groups;" 2>/dev/null | while IFS='|' read -r folder jid trigger; do
      echo "  $folder → $jid (trigger: $trigger)"
    done
    echo ""
    echo "=== Recent Errors ==="
    grep -i "error\|ERROR" "$LOG" 2>/dev/null | tail -5
    ;;

  restart)
    echo "Stopping NanoClaw..."
    stop_nanoclaw
    clear_port
    echo "Starting NanoClaw..."
    cd "$NC_DIR" && node dist/index.js >> "$LOG" 2>> "$ERR_LOG" &
    sleep 3
    PID=$(pgrep -f "nanoclaw/dist/index.js")
    if [ -n "$PID" ]; then
      echo "✅ Restarted (PID: $PID)"
    else
      echo "❌ Failed to start"
    fi
    ;;

  logs)
    tail -${2:-50} "$LOG"
    ;;

  errors)
    grep -i "error\|ERROR\|WARN" "$LOG" | tail -${2:-20}
    ;;

  update-jid)
    if [ -z "$2" ] || [ -z "$3" ]; then
      echo "Usage: maintain.sh update-jid <folder> <new-jid>"
      echo "Example: maintain.sh update-jid kanae tg:-1003746091450"
      exit 1
    fi
    sqlite3 "$DB" "UPDATE registered_groups SET jid = '$3' WHERE folder = '$2';"
    echo "Updated $2 → $3"
    echo "Run 'maintain.sh restart' to apply"
    ;;

  groups)
    sqlite3 "$DB" "SELECT folder, jid, name, requires_trigger FROM registered_groups;" 2>/dev/null | \
      column -t -s'|' --table-columns "Folder,JID,Name,Trigger"
    ;;

  watchdog)
    # Run as cron: */5 * * * * ~/nanoclaw/scripts/maintain.sh watchdog
    PID=$(pgrep -f "nanoclaw/dist/index.js")
    PORT_OK=$(lsof -ti:$PORT 2>/dev/null)
    if [ -z "$PID" ] || [ -z "$PORT_OK" ]; then
      echo "$(date): NanoClaw down (pid=$PID, port=$PORT_OK), restarting..." >> "$NC_DIR/logs/watchdog.log"
      stop_nanoclaw
      clear_port
      cd "$NC_DIR" && node dist/index.js >> "$LOG" 2>> "$ERR_LOG" &
      sleep 3
      NEW_PID=$(pgrep -f "nanoclaw/dist/index.js")
      if [ -n "$NEW_PID" ]; then
        echo "$(date): Restarted (PID: $NEW_PID)" >> "$NC_DIR/logs/watchdog.log"
      else
        echo "$(date): FAILED to restart" >> "$NC_DIR/logs/watchdog.log"
      fi
    fi
    ;;

  *)
    echo "NanoClaw Maintenance Script"
    echo ""
    echo "Commands:"
    echo "  status      — Show system status (default)"
    echo "  restart     — Restart NanoClaw"
    echo "  logs [n]    — Show last n lines of log (default 50)"
    echo "  errors [n]  — Show recent errors (default 20)"
    echo "  groups      — List registered groups"
    echo "  update-jid <folder> <jid> — Update group JID"
    echo "  watchdog    — Auto-restart if down (for cron)"
    ;;
esac
