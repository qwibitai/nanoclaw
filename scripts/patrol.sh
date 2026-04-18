#!/bin/bash
# 巡检脚本：读取各群状态，生成 JSON 供定时任务 agent 使用
# 输出格式：最后一行是 JSON { "wakeAgent": true/false, "data": {...} }

STORE_DIR="${NANOCLAW_STORE_DIR:-/Users/dajay/AI_Workspace/nanoclaw/store}"
GROUPS_DIR="${NANOCLAW_GROUPS_DIR:-/Users/dajay/AI_Workspace/nanoclaw/groups}"
DB="$STORE_DIR/messages.db"
export TMP_DIR=$(mktemp -d)
trap "rm -rf $TMP_DIR" EXIT

if [ ! -f "$DB" ]; then
  echo '{"wakeAgent": false, "data": {"error": "messages.db not found"}}'
  exit 0
fi

# 导出群基础信息到临时文件
sqlite3 -json "$DB" "
  SELECT
    c.jid,
    c.name,
    c.last_message_time
  FROM chats c
  WHERE c.is_group = 1
  ORDER BY c.last_message_time DESC;
" > "$TMP_DIR/chats.json" 2>/dev/null

# 导出每个群的最近消息
sqlite3 -json "$DB" "
  SELECT chat_jid, sender_name, substr(content, 1, 200) as content, timestamp
  FROM messages
  WHERE rowid IN (
    SELECT MAX(rowid) FROM messages
    WHERE chat_jid IN (SELECT jid FROM chats WHERE is_group = 1)
    GROUP BY chat_jid
  );
" > "$TMP_DIR/last_messages.json" 2>/dev/null

# 统计各群消息量
sqlite3 -json "$DB" "
  SELECT
    chat_jid,
    SUM(CASE WHEN timestamp > datetime('now', '-1 hour') THEN 1 ELSE 0 END) as msgs_1h,
    SUM(CASE WHEN timestamp > datetime('now', '-24 hours') THEN 1 ELSE 0 END) as msgs_24h
  FROM messages
  WHERE chat_jid IN (SELECT jid FROM chats WHERE is_group = 1)
  GROUP BY chat_jid;
" > "$TMP_DIR/stats.json" 2>/dev/null

# 判断"谁在等谁"：最后一条消息是用户发的还是 agent 发的
sqlite3 -json "$DB" "
  SELECT
    m.chat_jid,
    m.is_from_me OR m.is_bot_message as last_is_bot,
    m.sender_name as last_sender,
    m.timestamp as last_msg_time,
    ROUND((julianday('now') - julianday(m.timestamp)) * 24, 1) as hours_since_last
  FROM messages m
  INNER JOIN (
    SELECT chat_jid, MAX(timestamp) as max_ts
    FROM messages
    WHERE chat_jid IN (SELECT jid FROM chats WHERE is_group = 1)
    GROUP BY chat_jid
  ) latest ON m.chat_jid = latest.chat_jid AND m.timestamp = latest.max_ts;
" > "$TMP_DIR/turn.json" 2>/dev/null

# 收集各群的文件系统状态
echo "[]" > "$TMP_DIR/fs_info.json"
for folder_path in "$GROUPS_DIR"/fs_oc_*; do
  [ -d "$folder_path" ] || continue
  folder=$(basename "$folder_path")
  jid="fs:${folder/fs_/}"

  latest_conv=""
  if [ -d "$folder_path/conversations" ]; then
    latest_conv=$(ls -t "$folder_path/conversations/" 2>/dev/null | head -1)
  fi

  openspec_changes=""
  if [ -d "$folder_path/.openspec/changes" ]; then
    openspec_changes=$(ls "$folder_path/.openspec/changes/" 2>/dev/null | tr '\n' ',' | sed 's/,$//')
  fi

  python3 -c "
import json
with open('$TMP_DIR/fs_info.json') as f:
    arr = json.load(f)
arr.append({'jid': '$jid', 'folder': '$folder', 'latest_conv': '$latest_conv', 'openspec': '$openspec_changes'})
with open('$TMP_DIR/fs_info.json', 'w') as f:
    json.dump(arr, f)
"
done

# 合并所有数据输出最终 JSON
python3 << 'PYEOF'
import json, os

tmp = os.environ.get('TMP_DIR', '/tmp')

def load(name):
    path = f"{tmp}/{name}"
    if os.path.exists(path):
        with open(path) as f:
            try:
                return json.load(f)
            except:
                return []
    return []

chats = load("chats.json")
last_msgs = {m["chat_jid"]: m for m in load("last_messages.json")}
stats = {s["chat_jid"]: s for s in load("stats.json")}
turn = {t["chat_jid"]: t for t in load("turn.json")}
fs_info = {f["jid"]: f for f in load("fs_info.json")}

groups = []
for c in chats:
    jid = c["jid"]
    g = {
        "jid": jid,
        "name": c.get("name", jid),
        "last_active": c.get("last_message_time", ""),
    }
    if jid in last_msgs:
        lm = last_msgs[jid]
        g["last_message"] = lm.get("content", "")[:200]
        g["last_sender"] = lm.get("sender_name", "")
    if jid in stats:
        g["msgs_1h"] = stats[jid].get("msgs_1h", 0)
        g["msgs_24h"] = stats[jid].get("msgs_24h", 0)
    if jid in turn:
        t = turn[jid]
        # waiting_for: "bot"=用户发了消息等agent回, "user"=agent回了等用户
        g["waiting_for"] = "user" if t.get("last_is_bot") else "bot"
        g["hours_idle"] = t.get("hours_since_last", 0)
    if jid in fs_info:
        fi = fs_info[jid]
        g["folder"] = fi.get("folder", "")
        g["latest_conv"] = fi.get("latest_conv", "")
        g["openspec"] = fi.get("openspec", "")
    groups.append(g)

from datetime import datetime, timezone
result = {
    "wakeAgent": len(groups) > 0,
    "data": {
        "groups": groups,
        "total": len(groups),
        "timestamp": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    }
}
print(json.dumps(result, ensure_ascii=False))
PYEOF
