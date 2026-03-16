#!/bin/bash
# NanoClaw Watchdog — cron 每分钟跑一次
# crontab: * * * * * flock -n /tmp/nc-watchdog.lock ~/nanoclaw/scripts/maintain-watchdog.sh
#
# 职责：
# 1. NanoClaw 自愈（进程+端口检查）
# 2. 重复容器清理
# 3. 维护 bot 保活（Telegram DM → host-task relay）
# 4. 通知（curl → Telegram）

export PATH="/opt/homebrew/bin:/opt/homebrew/opt/node@22/bin:/usr/local/bin:/usr/bin:/usr/sbin:/bin:$PATH"
[ -f "$HOME/nanoclaw/.env" ] && export $(grep -E '^MAINTAIN_BOT_TOKEN=' "$HOME/nanoclaw/.env" | xargs)

LOCKFILE="/tmp/nc-watchdog.lock"
if ! shlock -f "$LOCKFILE" -p $$; then exit 0; fi
trap 'rm -f "$LOCKFILE"' EXIT

NC_DIR="$HOME/nanoclaw"
LOG="$NC_DIR/logs/watchdog.log"
NC_LOG="$NC_DIR/logs/nanoclaw.log"
NC_ERR="$NC_DIR/logs/nanoclaw.error.log"
DB="$NC_DIR/store/messages.db"
PORT=3001
BOT_TOKEN="${MAINTAIN_BOT_TOKEN:-}"
OWNER_CHAT_ID="8656923396"
KANAE_JID="tg:-1003746091450"

# 连续失败计数（用文件持久化，cron 每次是新进程）
FAIL_COUNT_FILE="/tmp/nc-watchdog-fails"

notify() {
  curl -s -X POST "https://api.telegram.org/bot${BOT_TOKEN}/sendMessage" \
    -H "Content-Type: application/json" \
    -d "{\"chat_id\":${OWNER_CHAT_ID},\"text\":$(printf '%s' "$1" | python3 -c 'import sys,json; print(json.dumps(sys.stdin.read()))')}" \
    >/dev/null 2>&1
}

# 通知香奈惠（写 IPC 消息到 NanoClaw）
notify_kanae() {
  local MSG_DIR="$NC_DIR/ipc/messages"
  mkdir -p "$MSG_DIR"
  local TS=$(date +%s%3N)
  local ESCAPED=$(printf '%s' "$1" | python3 -c 'import sys,json; print(json.dumps(sys.stdin.read()))')
  cat > "$MSG_DIR/watchdog-${TS}.json" <<ENDJSON
{"type":"message","chatJid":"${KANAE_JID}","text":${ESCAPED},"sender":"watchdog"}
ENDJSON
}

stop_nanoclaw() {
  local PID=$(pgrep -f "nanoclaw/dist/index.js")
  [ -z "$PID" ] && return 0
  kill $PID 2>/dev/null
  for i in $(seq 1 10); do
    kill -0 $PID 2>/dev/null || return 0
    sleep 1
  done
  kill -9 $PID 2>/dev/null
  sleep 1
}

clear_port() {
  local PORT_PID=$(lsof -ti:$PORT 2>/dev/null)
  [ -z "$PORT_PID" ] && return 0
  kill $PORT_PID 2>/dev/null
  sleep 2
  PORT_PID=$(lsof -ti:$PORT 2>/dev/null)
  [ -n "$PORT_PID" ] && kill -9 $PORT_PID 2>/dev/null && sleep 1
}

get_fail_count() {
  [ -f "$FAIL_COUNT_FILE" ] && cat "$FAIL_COUNT_FILE" || echo 0
}

set_fail_count() {
  echo "$1" > "$FAIL_COUNT_FILE"
}

# ── 1. NanoClaw 自愈 ──

NC_PID=$(pgrep -f "nanoclaw/dist/index.js")
PORT_OK=$(lsof -ti:$PORT 2>/dev/null)

if [ -z "$NC_PID" ] || [ -z "$PORT_OK" ]; then
  FAILS=$(get_fail_count)
  FAILS=$((FAILS + 1))
  set_fail_count $FAILS

  if [ $FAILS -le 5 ]; then
    echo "$(date): NanoClaw down (pid=${NC_PID:-none}, port=${PORT_OK:-free}), attempt $FAILS..." >> "$LOG"
    stop_nanoclaw
    clear_port
    cd "$NC_DIR" && node dist/index.js >> "$NC_LOG" 2>> "$NC_ERR" &
    sleep 3
    NEW_PID=$(pgrep -f "nanoclaw/dist/index.js")
    if [ -n "$NEW_PID" ]; then
      echo "$(date): Restarted (PID: $NEW_PID)" >> "$LOG"
      set_fail_count 0
      notify "🔧 NanoClaw was down → auto-restarted (PID: ${NEW_PID})"
      notify_kanae "【watchdog】NanoClaw 刚才挂了，已自动重启 (PID: ${NEW_PID})。请检查是否有未完成的任务需要重试。"
    else
      echo "$(date): FAILED to restart (attempt $FAILS)" >> "$LOG"
    fi
  elif [ $FAILS -eq 6 ]; then
    echo "$(date): Crash loop detected, stopping retries" >> "$LOG"
    notify "🚨 NanoClaw crash loop（连续 5 次重启失败），需要人工介入"
  fi
  # >6 次静默，不刷屏
else
  # 正常运行，重置计数
  [ "$(get_fail_count)" -gt 0 ] 2>/dev/null && set_fail_count 0
fi

# ── 2. 重复容器清理 ──

CONTAINER_LIST=$(docker ps --filter "name=nanoclaw-" --format "{{.Names}}" 2>/dev/null)
if [ -n "$CONTAINER_LIST" ]; then
  # 按 group 分组，每组只留最新的（名字末尾是时间戳，sort 后最后一个最新）
  echo "$CONTAINER_LIST" | sed 's/-[0-9]*$//' | sort -u | while read GROUP_PREFIX; do
    CONTAINERS=$(echo "$CONTAINER_LIST" | grep "^${GROUP_PREFIX}-" | sort)
    COUNT=$(echo "$CONTAINERS" | wc -l | tr -d ' ')
    if [ "$COUNT" -gt 1 ]; then
      # 保留最后一个（最新），杀其余
      TO_KILL=$(echo "$CONTAINERS" | head -n $((COUNT - 1)))
      echo "$TO_KILL" | while read C; do
        docker kill "$C" >/dev/null 2>&1
        echo "$(date): Killed duplicate container $C" >> "$LOG"
      done
      KEPT=$(echo "$CONTAINERS" | tail -1)
      GROUP=$(echo "$GROUP_PREFIX" | sed 's/^nanoclaw-//')
      notify "🔧 ${GROUP}: killed $((COUNT-1)) duplicate container(s), kept $KEPT"
    fi
  done
fi

# ── 3. 维护 bot 保活 ──

BOT_LOCK="/tmp/nc-maintain-bot.lock"
BOT_SCRIPT="$NC_DIR/scripts/tg-maintain-bot.mjs"
if [ -f "$BOT_SCRIPT" ]; then
  BOT_ALIVE=false
  if [ -f "$BOT_LOCK" ]; then
    BOT_PID=$(cat "$BOT_LOCK" 2>/dev/null)
    if [ -n "$BOT_PID" ] && kill -0 "$BOT_PID" 2>/dev/null; then
      BOT_ALIVE=true
    fi
  fi
  if [ "$BOT_ALIVE" = false ]; then
    rm -f "$BOT_LOCK"
    cd "$NC_DIR" && MAINTAIN_BOT_TOKEN="$BOT_TOKEN" nohup node "$BOT_SCRIPT" >> "$NC_DIR/logs/maintain-bot.log" 2>&1 &
    echo "$(date): Started maintain bot (PID: $!)" >> "$LOG"
  fi
fi
