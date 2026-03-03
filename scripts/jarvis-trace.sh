#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

DB_PATH="${DB_PATH:-$ROOT_DIR/store/messages.db}"
LOG_PATH="${LOG_PATH:-$ROOT_DIR/logs/nanoclaw.log}"
LANE=""
CHAT_JID=""
RUN_ID=""
SINCE=""
UNTIL=""
WINDOW_MINUTES="120"
LOG_LINES="2500"
JSON_MODE=0
JSON_OUT=""

usage() {
  cat <<'USAGE'
Usage: scripts/jarvis-trace.sh [options]

Options:
  --lane <folder>           Lane folder (e.g. andy-developer, jarvis-worker-1)
  --chat-jid <jid>          Chat JID override
  --run-id <id>             Worker run_id filter
  --since <iso>             ISO timestamp lower bound
  --until <iso>             ISO timestamp upper bound (default: now UTC)
  --window-minutes <n>      If --since omitted, use now-minus-window (default: 120)
  --log-lines <n>           Log tail lines to scan (default: 2500)
  --db <path>               SQLite DB path (default: store/messages.db)
  --log <path>              Runtime log path (default: logs/nanoclaw.log)
  --json                    Emit JSON timeline to stdout
  --json-out <path>         Write JSON timeline to file
  -h, --help                Show help
USAGE
}

is_pos_int() {
  [[ "$1" =~ ^[0-9]+$ ]] && [ "$1" -gt 0 ]
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --lane) LANE="$2"; shift 2 ;;
    --chat-jid) CHAT_JID="$2"; shift 2 ;;
    --run-id) RUN_ID="$2"; shift 2 ;;
    --since) SINCE="$2"; shift 2 ;;
    --until) UNTIL="$2"; shift 2 ;;
    --window-minutes) WINDOW_MINUTES="$2"; shift 2 ;;
    --log-lines) LOG_LINES="$2"; shift 2 ;;
    --db) DB_PATH="$2"; shift 2 ;;
    --log) LOG_PATH="$2"; shift 2 ;;
    --json) JSON_MODE=1; shift ;;
    --json-out) JSON_OUT="$2"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown option: $1"; usage; exit 1 ;;
  esac
done

if ! is_pos_int "$WINDOW_MINUTES"; then
  echo "Invalid --window-minutes: $WINDOW_MINUTES"
  exit 1
fi
if ! is_pos_int "$LOG_LINES"; then
  echo "Invalid --log-lines: $LOG_LINES"
  exit 1
fi

if [ ! -f "$DB_PATH" ]; then
  echo "DB not found: $DB_PATH"
  exit 1
fi

if [ -z "$LANE" ] && [ -z "$CHAT_JID" ] && [ -z "$RUN_ID" ]; then
  echo "At least one of --lane, --chat-jid, or --run-id is required"
  exit 1
fi

if [ -z "$SINCE" ]; then
  SINCE="$(python3 - "$WINDOW_MINUTES" <<'PY'
import datetime
import sys
mins = int(sys.argv[1])
print((datetime.datetime.now(datetime.timezone.utc) - datetime.timedelta(minutes=mins)).isoformat())
PY
)"
fi

if [ -z "$UNTIL" ]; then
  UNTIL="$(python3 <<'PY'
import datetime
print(datetime.datetime.now(datetime.timezone.utc).isoformat())
PY
)"
fi

trace_json="$(python3 - "$DB_PATH" "$LOG_PATH" "$LANE" "$CHAT_JID" "$RUN_ID" "$SINCE" "$UNTIL" "$LOG_LINES" "$ROOT_DIR/data/ipc/errors" <<'PY'
import datetime
import glob
import json
import os
import re
import sqlite3
import sys
from collections import Counter

(db_path, log_path, lane, chat_jid, run_id, since_raw, until_raw, log_lines, errors_dir) = sys.argv[1:10]
log_lines = int(log_lines)

def parse_iso(value):
    if not value:
        return None
    try:
        dt = datetime.datetime.fromisoformat(value.replace("Z", "+00:00"))
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=datetime.timezone.utc)
        return dt
    except Exception:
        return None

def in_window(dt, start, end):
    if dt is None:
        return False
    return start <= dt <= end

def parse_json_obj(raw):
    text = (raw or "").strip()
    if not text:
        return None
    fenced = re.match(r"^```(?:json)?\s*([\s\S]*?)\s*```$", text, flags=re.IGNORECASE)
    if fenced:
        text = fenced.group(1).strip()
    if text.startswith("{") and text.endswith("}"):
        try:
            obj = json.loads(text)
            return obj if isinstance(obj, dict) else None
        except Exception:
            return None
    start = text.find("{")
    end = text.rfind("}")
    if start == -1 or end == -1 or end <= start:
        return None
    try:
        obj = json.loads(text[start:end + 1])
        return obj if isinstance(obj, dict) else None
    except Exception:
        return None

def looks_like_dispatch(payload):
    return isinstance(payload, dict) and ("run_id" in payload or "task_type" in payload)

def is_valid_dispatch(payload):
    required = ["run_id", "task_type", "input", "repo", "branch", "acceptance_tests"]
    if not isinstance(payload, dict):
        return False
    for k in required:
        if k not in payload:
            return False
    if not isinstance(payload.get("acceptance_tests"), list) or len(payload.get("acceptance_tests") or []) == 0:
        return False
    if not isinstance(payload.get("run_id"), str) or not payload["run_id"].strip():
        return False
    if not isinstance(payload.get("repo"), str) or "/" not in payload["repo"]:
        return False
    if not isinstance(payload.get("branch"), str) or not payload["branch"].strip():
        return False
    return True

def parse_error_reason(error_details):
    if not error_details:
        return None
    try:
        parsed = json.loads(error_details)
        if isinstance(parsed, dict):
            reason = parsed.get("reason")
            if isinstance(reason, str) and reason:
                return reason
    except Exception:
        return None
    return None

since_dt = parse_iso(since_raw)
until_dt = parse_iso(until_raw)
now_utc = datetime.datetime.now(datetime.timezone.utc)
if since_dt is None:
    since_dt = now_utc - datetime.timedelta(hours=2)
if until_dt is None:
    until_dt = now_utc
if until_dt < since_dt:
    since_dt, until_dt = until_dt, since_dt

conn = sqlite3.connect(db_path)
conn.row_factory = sqlite3.Row
cur = conn.cursor()

resolved_chat = chat_jid
if lane and not resolved_chat:
    cur.execute("SELECT jid FROM registered_groups WHERE folder = ? LIMIT 1", (lane,))
    row = cur.fetchone()
    if row:
        resolved_chat = row["jid"]

resolved_lane = lane
if run_id and not resolved_lane:
    cur.execute("SELECT group_folder FROM worker_runs WHERE run_id = ? LIMIT 1", (run_id,))
    row = cur.fetchone()
    if row:
        resolved_lane = row["group_folder"]

if resolved_chat and not resolved_lane:
    cur.execute("SELECT folder FROM registered_groups WHERE jid = ? LIMIT 1", (resolved_chat,))
    row = cur.fetchone()
    if row:
        resolved_lane = row["folder"]

msg_rows = []
if resolved_chat:
    cur.execute(
        """
        SELECT id, chat_jid, sender, content, timestamp, is_bot_message
        FROM messages
        WHERE chat_jid = ?
          AND timestamp >= ?
          AND timestamp <= ?
        ORDER BY timestamp ASC
        LIMIT 400
        """,
        (resolved_chat, since_dt.isoformat(), until_dt.isoformat()),
    )
    msg_rows = [dict(r) for r in cur.fetchall()]

run_rows = []
if run_id:
    cur.execute(
        """
        SELECT run_id, group_folder, status, started_at, completed_at, result_summary,
               error_details, dispatch_repo, dispatch_branch, context_intent,
               dispatch_session_id, selected_session_id, effective_session_id,
               session_resume_status
        FROM worker_runs
        WHERE run_id = ?
          AND started_at >= ?
          AND started_at <= ?
        ORDER BY started_at ASC
        """,
        (run_id, since_dt.isoformat(), until_dt.isoformat()),
    )
    run_rows = [dict(r) for r in cur.fetchall()]
elif resolved_lane:
    cur.execute(
        """
        SELECT run_id, group_folder, status, started_at, completed_at, result_summary,
               error_details, dispatch_repo, dispatch_branch, context_intent,
               dispatch_session_id, selected_session_id, effective_session_id,
               session_resume_status
        FROM worker_runs
        WHERE group_folder = ?
          AND started_at >= ?
          AND started_at <= ?
        ORDER BY started_at DESC
        LIMIT 120
        """,
        (resolved_lane, since_dt.isoformat(), until_dt.isoformat()),
    )
    run_rows = [dict(r) for r in cur.fetchall()]

blocks = []
if os.path.isdir(errors_dir):
    for path in sorted(glob.glob(os.path.join(errors_dir, "dispatch-block-*.json"))):
        try:
            with open(path, "r", encoding="utf-8") as f:
                data = json.load(f)
        except Exception:
            continue
        ts = parse_iso(data.get("timestamp", ""))
        if ts and not in_window(ts, since_dt, until_dt):
            continue
        if run_id and data.get("run_id") != run_id:
            continue
        if resolved_lane and data.get("target_folder") != resolved_lane and data.get("source_group") != resolved_lane:
            continue
        blocks.append(data)

log_tail = []
if os.path.isfile(log_path):
    with open(log_path, "r", encoding="utf-8", errors="ignore") as f:
        lines = f.readlines()
        log_tail = lines[-log_lines:]

log_matches = []
for line in log_tail:
    keep = False
    if run_id and run_id in line:
        keep = True
    if resolved_lane and resolved_lane in line:
        keep = True
    if resolved_chat and resolved_chat in line:
        keep = True
    if not (run_id or resolved_lane or resolved_chat):
        keep = True
    if keep:
        log_matches.append(line.rstrip("\n"))

wa_conflicts = sum(1 for l in log_tail if "conflict" in l.lower() and ("replaced" in l.lower() or "stream errored" in l.lower()))
schema_errors = sum(1 for l in log_tail if "SqliteError" in l or "no such column: dispatch_repo" in l)
container_errors = sum(1 for l in log_tail if "Container exited with error" in l or "Container agent error" in l)

log_time_re = re.compile(r"^\[(\d{2}):(\d{2}):(\d{2})\.(\d{3})\]")
log_events = []
for idx, raw_line in enumerate(log_tail):
    text = raw_line.rstrip("\n")
    m = log_time_re.match(text)
    event_sec = None
    if m:
        hh, mm, ss, ms = [int(g) for g in m.groups()]
        event_sec = hh * 3600 + mm * 60 + ss + (ms / 1000.0)
    log_events.append({"idx": idx, "text": text, "sec": event_sec})

no_output_events = [e for e in log_events if "Container timed out with no output" in e["text"]]
wa_close_events = [e for e in log_events if "Connection closed" in e["text"]]
no_output_with_wa_close = 0
for evt in no_output_events:
    if evt.get("sec") is None:
        continue
    matched = any(
        close.get("sec") is not None and abs(close["sec"] - evt["sec"]) <= 120
        for close in wa_close_events
    )
    if matched:
        no_output_with_wa_close += 1

dispatch_payload_messages = 0
valid_dispatch_payload_messages = 0
suppressed_reasons = Counter()
for msg in msg_rows:
    if msg.get("is_bot_message"):
        continue
    payload = parse_json_obj(msg.get("content"))
    if looks_like_dispatch(payload):
        dispatch_payload_messages += 1
        if is_valid_dispatch(payload):
            valid_dispatch_payload_messages += 1

for run in run_rows:
    reason = parse_error_reason(run.get("error_details"))
    if reason:
        suppressed_reasons[reason] += 1

if dispatch_payload_messages > valid_dispatch_payload_messages:
    suppressed_reasons["invalid_dispatch_payload"] += dispatch_payload_messages - valid_dispatch_payload_messages

dispatch_enqueued_runs = len({r.get("run_id") for r in run_rows if r.get("run_id")})

root_cause = "unknown"
if resolved_chat and len(msg_rows) == 0:
    root_cause = "no_ingest"
if blocks:
    root_cause = "dispatch_blocked"
if any((r.get("status") == "failed_runtime" and "running_without_container" in (r.get("error_details") or "")) for r in run_rows):
    root_cause = "container_stale"
if no_output_events:
    root_cause = "andy_no_output_timeout"
if wa_conflicts > 8:
    root_cause = "wa_conflict_churn"
if schema_errors > 0:
    root_cause = "schema_drift"

# Build simple timeline
timeline = []
for m in msg_rows[-40:]:
    timeline.append({
        "ts": m.get("timestamp"),
        "stage": "message_ingest",
        "detail": {
            "id": m.get("id"),
            "sender": m.get("sender"),
            "is_bot_message": m.get("is_bot_message"),
            "content_preview": (m.get("content") or "")[:160],
        },
    })
for r in run_rows[:40]:
    timeline.append({
        "ts": r.get("started_at"),
        "stage": "worker_run",
        "detail": {
            "run_id": r.get("run_id"),
            "status": r.get("status"),
            "dispatch_branch": r.get("dispatch_branch"),
            "context_intent": r.get("context_intent"),
            "effective_session_id": r.get("effective_session_id"),
            "session_resume_status": r.get("session_resume_status"),
        },
    })
for b in blocks[-40:]:
    timeline.append({
        "ts": b.get("timestamp"),
        "stage": "dispatch_block",
        "detail": b,
    })

timeline = sorted(timeline, key=lambda x: x.get("ts") or "")

payload = {
    "script": "jarvis-trace",
    "timestamp": datetime.datetime.now(datetime.timezone.utc).isoformat(),
    "inputs": {
        "lane": lane or None,
        "chat_jid": chat_jid or None,
        "run_id": run_id or None,
        "since": since_dt.isoformat(),
        "until": until_dt.isoformat(),
    },
    "resolved": {
        "lane": resolved_lane,
        "chat_jid": resolved_chat,
    },
    "metrics": {
        "messages": len(msg_rows),
        "worker_runs": len(run_rows),
        "dispatch_blocks": len(blocks),
        "log_matches": len(log_matches),
        "wa_conflicts_in_tail": wa_conflicts,
        "schema_errors_in_tail": schema_errors,
        "container_errors_in_tail": container_errors,
        "dispatch_payload_messages": dispatch_payload_messages,
        "valid_dispatch_payload_messages": valid_dispatch_payload_messages,
        "dispatch_enqueued_runs": dispatch_enqueued_runs,
        "dispatch_suppressed_reasons": dict(suppressed_reasons),
        "no_output_events_in_tail": len(no_output_events),
        "no_output_events_with_wa_close_within_120s": no_output_with_wa_close,
    },
    "root_cause": root_cause,
    "timeline": timeline,
    "log_excerpt": log_matches[-80:],
}

print(json.dumps(payload, ensure_ascii=True))
PY
)"

echo "== Jarvis Trace =="
echo "since: $SINCE"
echo "until: $UNTIL"
python3 - "$trace_json" <<'PY'
import json
import sys
obj = json.loads(sys.argv[1])
metrics = obj["metrics"]
print(f"resolved lane: {obj['resolved'].get('lane')}")
print(f"resolved chat_jid: {obj['resolved'].get('chat_jid')}")
print(f"messages: {metrics['messages']}")
print(f"worker runs: {metrics['worker_runs']}")
print(f"dispatch blocks: {metrics['dispatch_blocks']}")
print(f"dispatch payload messages: {metrics['dispatch_payload_messages']}")
print(f"valid dispatch payload messages: {metrics['valid_dispatch_payload_messages']}")
print(f"dispatch enqueued runs: {metrics['dispatch_enqueued_runs']}")
print(f"no-output events in tail: {metrics['no_output_events_in_tail']}")
print(f"no-output with WA close <=120s: {metrics['no_output_events_with_wa_close_within_120s']}")
print(f"log matches: {metrics['log_matches']}")
print(f"root cause: {obj.get('root_cause')}")
reasons = metrics.get('dispatch_suppressed_reasons') or {}
if reasons:
    print('dispatch suppressed reasons:')
    for key, val in sorted(reasons.items()):
        print(f"  - {key}: {val}")
print("timeline (latest 12 events):")
for ev in obj.get('timeline', [])[-12:]:
    stage = ev.get('stage')
    ts = ev.get('ts')
    detail = ev.get('detail', {})
    if stage == 'worker_run':
        print(f"  - {ts} | {stage} | run_id={detail.get('run_id')} status={detail.get('status')}")
    elif stage == 'dispatch_block':
        print(f"  - {ts} | {stage} | reason={detail.get('reason_text')}")
    else:
        print(f"  - {ts} | {stage}")
PY

if [ "$JSON_MODE" -eq 1 ]; then
  echo
  python3 - "$trace_json" <<'PY'
import json, sys
print(json.dumps(json.loads(sys.argv[1]), ensure_ascii=True, indent=2))
PY
fi

if [ -n "$JSON_OUT" ]; then
  python3 - "$trace_json" <<'PY' >"$JSON_OUT"
import json, sys
print(json.dumps(json.loads(sys.argv[1]), ensure_ascii=True, indent=2))
PY
fi

root_cause="$(python3 - "$trace_json" <<'PY'
import json, sys
print(json.loads(sys.argv[1]).get('root_cause', 'unknown'))
PY
)"
if [ "$root_cause" != "unknown" ]; then
  exit 1
fi
