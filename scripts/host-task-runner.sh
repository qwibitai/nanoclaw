#!/bin/bash
# Host Task Runner — cron 每分钟跑一次
# crontab: * * * * * flock -n /tmp/nc-task-runner.lock ~/nanoclaw/scripts/host-task-runner.sh
#
# 职责：
# 1. 扫描 host-tasks/ 目录
# 2. 每次只执行一个任务（先到先做）
# 3. 用 Claude Code 执行
# 4. 写结果到 host-tasks-done/
# 5. IPC 通知香奈惠审核

export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:$PATH"

# Claude Code 认证（cron 环境没有 shell 的环境变量）
[ -f "$HOME/nanoclaw/.claude-env" ] && source "$HOME/nanoclaw/.claude-env" && export CLAUDE_CODE_OAUTH_TOKEN

LOCKFILE="/tmp/nc-task-runner.lock"
if ! shlock -f "$LOCKFILE" -p $$; then exit 0; fi
trap 'rm -f "$LOCKFILE"' EXIT

NC_DIR="$HOME/nanoclaw"
TASKS_DIR="$NC_DIR/store/host-tasks"
DONE_DIR="$NC_DIR/store/host-tasks-done"
LOG="$NC_DIR/logs/task-runner.log"
BOT_TOKEN="8621132320:AAFcHZbPW-C3qROHKqww_K3_lHpXzoysNK4"
OWNER_CHAT_ID="8656923396"
KANAE_JID="tg:-1003746091450"

mkdir -p "$TASKS_DIR" "$DONE_DIR"

notify() {
  curl -s -X POST "https://api.telegram.org/bot${BOT_TOKEN}/sendMessage" \
    -H "Content-Type: application/json" \
    -d "{\"chat_id\":${OWNER_CHAT_ID},\"text\":$(printf '%s' "$1" | python3 -c 'import sys,json; print(json.dumps(sys.stdin.read()))')}" \
    >/dev/null 2>&1
}

notify_kanae() {
  local MSG_DIR="$NC_DIR/data/ipc/kanae/messages"
  mkdir -p "$MSG_DIR"
  local TS=$(date +%s%3N)
  local ESCAPED=$(printf '%s' "$1" | python3 -c 'import sys,json; print(json.dumps(sys.stdin.read()))')
  cat > "$MSG_DIR/kanae-task-${TS}.json" <<ENDJSON
{"type":"message","chatJid":"${KANAE_JID}","text":${ESCAPED},"sender":"task-runner"}
ENDJSON
}

# 找第一个 .md 文件（按文件名排序，最早的先执行）
TASK_FILE=$(ls -1 "$TASKS_DIR"/*.md 2>/dev/null | head -1)
[ -z "$TASK_FILE" ] && exit 0

FILENAME=$(basename "$TASK_FILE")
TASK_ID="${FILENAME%.md}"
TITLE=$(head -1 "$TASK_FILE" | sed 's/^#\s*//')
CONTENT=$(cat "$TASK_FILE")
START_TIME=$(date +%s)

echo "$(date): Starting task: $FILENAME ($TITLE)" >> "$LOG"
notify "⚙️ host-task: $TITLE"

# 构建 Claude Code prompt
CONTEXT="你是 NanoClaw 的 host 执行 bot。你在 host 上运行，可以执行任何系统命令。
你的任务由 Kanae（维护监督者 Agent）委派。认真完成任务，输出清晰的结果。

## NanoClaw 系统架构
- 项目目录: $NC_DIR
- 源码: $NC_DIR/src/ (TypeScript)
- 编译: cd $NC_DIR && npx tsc
- 重启: $NC_DIR/scripts/maintain.sh restart
- DB: $NC_DIR/store/messages.db (SQLite, better-sqlite3)
- .env: $NC_DIR/.env (TELEGRAM_BOTS 配置)
- 日志: $NC_DIR/logs/nanoclaw.log
- Agent 配置: $NC_DIR/groups/<folder>/CLAUDE.md
- 容器入口: $NC_DIR/container/agent-runner/src/index.ts (容器内编译，不要在 host 编译)
- mount 白名单: ~/.config/nanoclaw/mount-allowlist.json
- Credential proxy: port 3001
- Paper-search MCP: port 3002

## 注意事项
- registered_groups 表的 requires_trigger 默认 1，新增行后必须 UPDATE 为 0
- Telegram supergroup JID 格式: tg:-100XXXXXXXXXX
- 修改 src/ 后需要 npx tsc 编译再重启（用 maintain.sh restart）
- 不要修改 container/agent-runner/ 内的文件（容器启动时自己编译）

Kanae（维护监督者）委派了一个任务:

$CONTENT

请认真执行这个任务。完成后：
1. 简要说明做了什么
2. 验证结果是否正确（比如检查日志、确认进程运行等）
3. 如果执行失败，说明失败原因和可能的解决方向"

# 执行（最多 10 分钟）
OUTPUT=$(echo "$CONTEXT" | claude -p - --max-turns 20 --dangerously-skip-permissions 2>&1) || true
EXIT_CODE=$?
END_TIME=$(date +%s)
DURATION=$((END_TIME - START_TIME))

# 写结果
STATUS_TEXT="成功"
STATUS_EMOJI="✅"
if [ $EXIT_CODE -ne 0 ]; then
  STATUS_TEXT="失败"
  STATUS_EMOJI="⚠️"
fi

cat > "$DONE_DIR/$FILENAME" <<ENDRESULT
$CONTENT

---
## 执行结果
- **状态**: $STATUS_EMOJI $STATUS_TEXT
- **退出码**: $EXIT_CODE
- **耗时**: ${DURATION}s
- **时间**: $(date -u +"%Y-%m-%dT%H:%M:%SZ")

### 输出
$OUTPUT
ENDRESULT

# 删除原任务文件
rm -f "$TASK_FILE"

# 通知香奈惠审核
SUMMARY=$(echo "$OUTPUT" | tail -20 | head -500)
notify_kanae "📋 host-task 执行完毕
任务: $FILENAME
标题: $TITLE
状态: $STATUS_EMOJI $STATUS_TEXT
耗时: ${DURATION}s

摘要:
$SUMMARY

请读取 /workspace/extra/host-tasks-done/$FILENAME 查看完整结果并审核。"

echo "$(date): Finished task: $FILENAME ($STATUS_TEXT, ${DURATION}s)" >> "$LOG"
