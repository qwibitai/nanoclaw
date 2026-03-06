#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"

OUT_ROOT="data/diagnostics/weekend-prevention"
WINDOW_DAYS=7
ISSUE_WINDOW_DAYS=30
TOP_LIMIT=10
RUN_ACCEPTANCE=1
SKIP_CONNECTIVITY=0
SKIP_PREFLIGHT=0
JSON_OUT=""
SUMMARY_OUT=""

usage() {
  cat <<'USAGE'
Usage: scripts/workflow/weekend-prevention-run.sh [options]

Runs weekend reliability-prevention workflow:
1) deterministic governance checks
2) reliability gates (status/hotspots/auth/linkage/acceptance)
3) top recurring issue frequency synthesis (incidents + worker failures)
4) machine + markdown evidence artifacts

Options:
  --out-root <path>          Output root (default: data/diagnostics/weekend-prevention)
  --window-days <n>          Runtime lookback in days for status/hotspots (default: 7)
  --issue-window-days <n>    Lookback in days for top-issue synthesis (default: 30)
  --top-limit <n>            Number of top issue categories in report (default: 10)
  --skip-acceptance          Skip acceptance-gate check
  --skip-connectivity        Pass --skip-connectivity to acceptance-gate
  --skip-preflight           Skip workflow preflight check
  --json-out <path>          Also write manifest JSON to this path
  --summary-out <path>       Also write markdown summary to this path
  -h, --help                 Show help
USAGE
}

is_pos_int() {
  [[ "${1:-}" =~ ^[0-9]+$ ]] && [ "$1" -gt 0 ]
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --out-root)
      OUT_ROOT="$2"
      shift 2
      ;;
    --window-days)
      WINDOW_DAYS="$2"
      shift 2
      ;;
    --issue-window-days)
      ISSUE_WINDOW_DAYS="$2"
      shift 2
      ;;
    --top-limit)
      TOP_LIMIT="$2"
      shift 2
      ;;
    --skip-acceptance)
      RUN_ACCEPTANCE=0
      shift
      ;;
    --skip-connectivity)
      SKIP_CONNECTIVITY=1
      shift
      ;;
    --skip-preflight)
      SKIP_PREFLIGHT=1
      shift
      ;;
    --json-out)
      JSON_OUT="$2"
      shift 2
      ;;
    --summary-out)
      SUMMARY_OUT="$2"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown option: $1"
      usage
      exit 1
      ;;
  esac
done

for value in "$WINDOW_DAYS" "$ISSUE_WINDOW_DAYS" "$TOP_LIMIT"; do
  if ! is_pos_int "$value"; then
    echo "Expected positive integer, got: $value"
    exit 1
  fi
done

timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
run_dir="$OUT_ROOT/run-$timestamp"
logs_dir="$run_dir/logs"
mkdir -p "$logs_dir"

results_file="$run_dir/checks.tsv"
manifest_file="$run_dir/manifest.json"
issues_file="$run_dir/top-issues.json"
summary_file="$run_dir/summary.md"

status_window_minutes=$((WINDOW_DAYS * 24 * 60))
hotspots_window_hours=$((WINDOW_DAYS * 24))

run_check() {
  local check_id="$1"
  local command_str="$2"
  local log_file="$logs_dir/${check_id}.log"
  local start_iso end_iso start_epoch end_epoch duration_sec exit_code status detail_line

  start_iso="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
  start_epoch="$(date +%s)"

  set +e
  PYENV_REHASH_DISABLE="${PYENV_REHASH_DISABLE:-1}" bash -c "$command_str" >"$log_file" 2>&1
  exit_code=$?
  set -e

  end_iso="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
  end_epoch="$(date +%s)"
  duration_sec=$((end_epoch - start_epoch))

  if [ "$exit_code" -eq 0 ]; then
    status="pass"
    echo "[PASS] $check_id (${duration_sec}s)"
  else
    status="fail"
    detail_line="$(tr '\n' ' ' <"$log_file" | sed 's/[[:space:]]\+/ /g' | cut -c1-220)"
    echo "[FAIL] $check_id (${duration_sec}s)"
    [ -n "$detail_line" ] && echo "  detail: $detail_line"
  fi

  printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' \
    "$check_id" "$status" "$exit_code" "$start_iso" "$end_iso" "$duration_sec" "$command_str" "$log_file" >>"$results_file"
}

echo "== Weekend Prevention Run =="
echo "repo: $ROOT_DIR"
echo "run_dir: $run_dir"
echo "window_days: $WINDOW_DAYS"
echo "issue_window_days: $ISSUE_WINDOW_DAYS"
echo "top_limit: $TOP_LIMIT"
echo

if [ "$SKIP_PREFLIGHT" -eq 0 ]; then
  run_check "workflow_preflight" "bash scripts/workflow/preflight.sh --skip-recall --with-incident-status"
fi

run_check "workflow_contracts" "bash scripts/check-workflow-contracts.sh"
run_check "mirror_check" "bash scripts/check-claude-codex-mirror.sh"
run_check "tooling_governance" "bash scripts/check-tooling-governance.sh"
run_check "slop_inventory_summary" "bash scripts/workflow/slop-inventory.sh --summary"

run_check "jarvis_status" "bash scripts/jarvis-ops.sh status --window-minutes $(printf '%q' "$status_window_minutes") --json-out $(printf '%q' "$run_dir/status.json")"
run_check "jarvis_hotspots" "bash scripts/jarvis-ops.sh hotspots --window-hours $(printf '%q' "$hotspots_window_hours") --json-out $(printf '%q' "$run_dir/hotspots.json")"
run_check "jarvis_auth_health" "bash scripts/jarvis-ops.sh auth-health --json-out $(printf '%q' "$run_dir/auth-health.json")"
run_check "jarvis_linkage_audit" "bash scripts/jarvis-ops.sh linkage-audit --warn-only --json-out $(printf '%q' "$run_dir/linkage-audit.json")"
run_check "incident_open_list" "bash scripts/jarvis-ops.sh incident list --status open"

if [ "$RUN_ACCEPTANCE" -eq 1 ]; then
  acceptance_cmd="bash scripts/jarvis-ops.sh acceptance-gate --out $(printf '%q' "$run_dir/acceptance.json")"
  if [ "$SKIP_CONNECTIVITY" -eq 1 ]; then
    acceptance_cmd+=" --skip-connectivity"
  fi
  run_check "acceptance_gate" "$acceptance_cmd"
fi

python3 - "$ROOT_DIR/.claude/progress/incident.json" "$ROOT_DIR/store/messages.db" "$ISSUE_WINDOW_DAYS" "$TOP_LIMIT" "$issues_file" <<'PY'
import json
import os
import re
import sqlite3
import sys
from collections import defaultdict
from datetime import datetime, timedelta, timezone

incident_path, db_path, issue_window_days_raw, top_limit_raw, out_path = sys.argv[1:6]
issue_window_days = int(issue_window_days_raw)
top_limit = int(top_limit_raw)
cutoff = datetime.now(timezone.utc) - timedelta(days=issue_window_days)

def parse_iso(value: str):
    if not value or not isinstance(value, str):
        return None
    normalized = value.strip().replace("Z", "+00:00")
    try:
        return datetime.fromisoformat(normalized)
    except ValueError:
        return None

def normalize_category(raw: str) -> str:
    text = (raw or "").strip().lower()
    if not text:
        return "Unknown / Uncategorized"
    if any(k in text for k in ("no_output", "no output", "watchdog", "timeout", "silent")):
        return "No-Output Timeout / Watchdog Drift"
    if any(k in text for k in ("worker", "connect", "connection", "disconnected", "probe")):
        return "Worker Connectivity / Dispatch"
    if any(k in text for k in ("running_without_container", "container_runtime", "docker: command not found", "container system")):
        return "Container Runtime / Lifecycle Drift"
    if any(k in text for k in ("queued_stale_before_spawn", "queued_cursor_past_dispatch", "stale queued", "stale running")):
        return "Queue / State Lifecycle Drift"
    if any(k in text for k in ("contract", "branch mismatch", "request_id", "completion", "dispatch lint")):
        return "Contract / Dispatch Drift"
    if any(k in text for k in ("parser", "json", "escaped output", "ack text mismatch")):
        return "Parser / Output Format Drift"
    if any(k in text for k in ("auth", "quota", "token", "api key", "unauthorized")):
        return "Auth / Quota / Credentials"
    if any(k in text for k in ("linkage", "worker_run_id", "coordinator_active", "state drift", "stale unlinked")):
        return "State / Linkage Drift"
    if any(k in text for k in ("classif", "work_intake", "status check-in", "misclassified")):
        return "Message Classification Drift"
    if any(k in text for k in ("symlink", "mount", "filesystem", "eexist", "einval", "exdev")):
        return "Filesystem / Mount / Path Drift"
    if any(k in text for k in ("mapfile", "bash 3", "bash compatibility", "posix")):
        return "Shell Compatibility"
    if any(k in text for k in ("governance", "slop", "hook", "subagent", "budget")):
        return "Tooling Governance Drift"
    if len(text) > 64:
        return "Other / Unmapped Signals"
    return raw.strip()[:64]

signals = defaultdict(lambda: {"incident_hits": 0, "worker_failure_hits": 0, "note_signal_hits": 0, "examples": []})

if os.path.isfile(incident_path):
    try:
        with open(incident_path, "r", encoding="utf-8") as fh:
            payload = json.load(fh)
    except Exception:
        payload = {}

    for incident in payload.get("incidents", []):
        updated_at = parse_iso(incident.get("updated_at", ""))
        if updated_at and updated_at < cutoff:
            continue
        summary = incident.get("summary") or {}
        cause = summary.get("suspected_cause") or incident.get("title") or "unknown"
        category = normalize_category(str(cause))
        signals[category]["incident_hits"] += 1
        if len(signals[category]["examples"]) < 3:
            signals[category]["examples"].append(f"incident:{incident.get('id','unknown')}")
        notes = incident.get("notes") or []
        for note in notes:
            note_ts = parse_iso((note or {}).get("ts", ""))
            if note_ts and note_ts < cutoff:
                continue
            text = (note or {}).get("text") or ""
            if not text:
                continue
            note_cat = normalize_category(text)
            if note_cat != "Unknown / Uncategorized":
                signals[note_cat]["note_signal_hits"] += 1
                if len(signals[note_cat]["examples"]) < 3:
                    signals[note_cat]["examples"].append("note")

if os.path.isfile(db_path):
    try:
        conn = sqlite3.connect(db_path)
        conn.row_factory = sqlite3.Row
        cur = conn.cursor()
        cur.execute(
            """
            SELECT
              status,
              COALESCE(
                CASE
                  WHEN json_valid(error_details) THEN json_extract(error_details, '$.reason')
                  ELSE NULL
                END,
                stop_reason,
                result_summary,
                error_details,
                status
              ) AS reason,
              COUNT(*) AS c
            FROM worker_runs
            WHERE started_at >= datetime('now', ?)
            GROUP BY status, reason
            """,
            (f"-{issue_window_days} days",),
        )
        for row in cur.fetchall():
            status = str(row["status"] or "")
            if status not in ("failed_runtime", "failed_timeout", "failed_contract"):
                continue
            reason = str(row["reason"] or status)
            category = normalize_category(reason)
            signals[category]["worker_failure_hits"] += int(row["c"] or 0)
            if len(signals[category]["examples"]) < 3:
                signals[category]["examples"].append(f"worker:{reason[:72]}")
    finally:
        try:
            conn.close()
        except Exception:
            pass

top = []
for category, detail in signals.items():
    total = detail["incident_hits"] + detail["worker_failure_hits"] + detail["note_signal_hits"]
    if total <= 0:
        continue
    top.append(
        {
            "issue_category": category,
            "occurrence": total,
            "incident_hits": detail["incident_hits"],
            "worker_failure_hits": detail["worker_failure_hits"],
            "note_signal_hits": detail["note_signal_hits"],
            "examples": detail["examples"][:3],
        }
    )

top.sort(key=lambda item: (-item["occurrence"], -item["worker_failure_hits"], item["issue_category"]))
top = top[:top_limit]

payload = {
    "generated_at": datetime.now(timezone.utc).isoformat(),
    "issue_window_days": issue_window_days,
    "top_limit": top_limit,
    "top_issues": top,
}

with open(out_path, "w", encoding="utf-8") as fh:
    json.dump(payload, fh, ensure_ascii=True, indent=2)
    fh.write("\n")
PY

python3 - "$results_file" "$manifest_file" "$issues_file" "$WINDOW_DAYS" "$ISSUE_WINDOW_DAYS" "$ROOT_DIR" <<'PY'
import json
import sys

results_file, manifest_file, issues_file, window_days, issue_window_days, root_dir = sys.argv[1:7]
checks = []
with open(results_file, "r", encoding="utf-8") as fh:
    for line in fh:
        parts = line.rstrip("\n").split("\t")
        if len(parts) != 8:
            continue
        cid, status, exit_code, start_at, end_at, duration_sec, cmd, log_path = parts
        checks.append(
            {
                "id": cid,
                "status": status,
                "exit_code": int(exit_code),
                "start_at": start_at,
                "end_at": end_at,
                "duration_sec": int(duration_sec),
                "command": cmd,
                "log_path": log_path,
            }
        )

failed = [c for c in checks if c["status"] == "fail"]
payload = {
    "script": "weekend-prevention-run",
    "generated_at": checks[-1]["end_at"] if checks else None,
    "root_dir": root_dir,
    "window_days": int(window_days),
    "issue_window_days": int(issue_window_days),
    "summary": {
        "total": len(checks),
        "passed": len([c for c in checks if c["status"] == "pass"]),
        "failed": len(failed),
        "status": "fail" if failed else "pass",
    },
    "checks": checks,
    "top_issues_path": issues_file,
}

with open(manifest_file, "w", encoding="utf-8") as out:
    json.dump(payload, out, ensure_ascii=True, indent=2)
    out.write("\n")
PY

python3 - "$manifest_file" "$issues_file" "$summary_file" <<'PY'
import json
import sys

manifest_path, issues_path, out_md = sys.argv[1:4]
manifest = json.load(open(manifest_path, "r", encoding="utf-8"))
issues = json.load(open(issues_path, "r", encoding="utf-8"))

lines = []
lines.append("# Weekend Prevention Summary")
lines.append("")
lines.append(f"- Generated: {manifest.get('generated_at')}")
lines.append(f"- Overall status: {manifest.get('summary', {}).get('status')}")
lines.append(f"- Checks: {manifest.get('summary', {}).get('passed')}/{manifest.get('summary', {}).get('total')} passed")
lines.append("")
lines.append("## Top Recurring Issues")
lines.append("")
lines.append("| Rank | Issue Category | Occurrence | Incident Hits | Worker Failure Hits | Note Signal Hits |")
lines.append("|---|---|---:|---:|---:|---:|")

for idx, row in enumerate(issues.get("top_issues", []), start=1):
    lines.append(
        f"| {idx} | {row.get('issue_category')} | {row.get('occurrence')} | {row.get('incident_hits')} | {row.get('worker_failure_hits')} | {row.get('note_signal_hits')} |"
    )

if not issues.get("top_issues"):
    lines.append("| - | No recurring issue signals found in window | 0 | 0 | 0 | 0 |")

lines.append("")
lines.append("## Failed Checks")
lines.append("")
failed = [c for c in manifest.get("checks", []) if c.get("status") == "fail"]
if not failed:
    lines.append("- None")
else:
    for item in failed:
        lines.append(f"- `{item.get('id')}` (exit {item.get('exit_code')}), log: `{item.get('log_path')}`")

with open(out_md, "w", encoding="utf-8") as fh:
    fh.write("\n".join(lines).rstrip() + "\n")
PY

if [ -n "$JSON_OUT" ]; then
  mkdir -p "$(dirname "$JSON_OUT")"
  cp "$manifest_file" "$JSON_OUT"
fi

if [ -n "$SUMMARY_OUT" ]; then
  mkdir -p "$(dirname "$SUMMARY_OUT")"
  cp "$summary_file" "$SUMMARY_OUT"
fi

echo
echo "Artifacts:"
echo "  - manifest: $manifest_file"
echo "  - top_issues: $issues_file"
echo "  - summary: $summary_file"

overall_status="$(python3 - "$manifest_file" <<'PY'
import json
import sys
obj = json.load(open(sys.argv[1], "r", encoding="utf-8"))
print(obj.get("summary", {}).get("status", "fail"))
PY
)"

if [ "$overall_status" = "pass" ]; then
  echo "Result: PASS"
  exit 0
fi

echo "Result: FAIL"
exit 1
