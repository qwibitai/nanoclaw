#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

DB_PATH="${DB_PATH:-$ROOT_DIR/store/messages.db}"
INPUT_FILE=""
USE_STDIN=0
TARGET_FOLDER=""
STRICT_SESSION_CHECK=0
JSON_MODE=0
JSON_OUT=""

usage() {
  cat <<'USAGE'
Usage: scripts/jarvis-dispatch-lint.sh [options]

Options:
  --file <path>             Dispatch JSON file to validate
  --stdin                   Read dispatch JSON from stdin
  --target-folder <folder>  Worker folder (e.g. jarvis-worker-1)
  --strict-session-check    Enforce session routing checks using worker_runs DB
  --db <path>               SQLite DB path (default: store/messages.db)
  --json                    Emit JSON result to stdout
  --json-out <path>         Write JSON result to file
  -h, --help                Show help
USAGE
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --file) INPUT_FILE="$2"; shift 2 ;;
    --stdin) USE_STDIN=1; shift ;;
    --target-folder) TARGET_FOLDER="$2"; shift 2 ;;
    --strict-session-check) STRICT_SESSION_CHECK=1; shift ;;
    --db) DB_PATH="$2"; shift 2 ;;
    --json) JSON_MODE=1; shift ;;
    --json-out) JSON_OUT="$2"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown option: $1"; usage; exit 1 ;;
  esac
done

if [ "$USE_STDIN" -eq 0 ] && [ -z "$INPUT_FILE" ]; then
  echo "One of --file or --stdin is required"
  exit 1
fi

if [ "$USE_STDIN" -eq 1 ] && [ -n "$INPUT_FILE" ]; then
  echo "Use either --file or --stdin, not both"
  exit 1
fi

if [ "$USE_STDIN" -eq 0 ] && [ ! -f "$INPUT_FILE" ]; then
  echo "Dispatch file not found: $INPUT_FILE"
  exit 1
fi

if [ "$STRICT_SESSION_CHECK" -eq 1 ]; then
  if [ -z "$TARGET_FOLDER" ]; then
    echo "--target-folder is required with --strict-session-check"
    exit 1
  fi
  if [ ! -f "$DB_PATH" ]; then
    echo "DB not found: $DB_PATH"
    exit 1
  fi
  if ! command -v sqlite3 >/dev/null 2>&1; then
    echo "sqlite3 is required for --strict-session-check"
    exit 1
  fi
fi

payload_file=""
cleanup() {
  # Only remove temp payloads we create from stdin.
  if [ "$USE_STDIN" -eq 1 ] && [ -n "$payload_file" ]; then
    rm -f "$payload_file"
  fi
}
trap cleanup EXIT

if [ "$USE_STDIN" -eq 1 ]; then
  payload_file="$(mktemp /tmp/jarvis-dispatch.XXXXXX)"
  cat >"$payload_file"
else
  payload_file="$INPUT_FILE"
fi

result="$(python3 - "$payload_file" "$STRICT_SESSION_CHECK" "$TARGET_FOLDER" "$DB_PATH" <<'PY'
import json
import re
import sqlite3
import sys
from pathlib import Path

payload_path, strict_session_check, target_folder, db_path = sys.argv[1:5]
strict_session_check = strict_session_check == "1"

REPO_PATTERN = re.compile(r"^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$")
BRANCH_PATTERN = re.compile(r"^jarvis-[A-Za-z0-9._/-]+$")
BASE_BRANCH_PATTERN = re.compile(r"^[A-Za-z0-9._/-]+$")
SESSION_ID_PATTERN = re.compile(r"^[A-Za-z0-9._:-]+$")
SCREENSHOT_PATTERN = re.compile(r"\b(screenshot|screen[\s-]?shot|take_screenshot|browser_take_screenshot|comet_screenshot|image analysis|analyze screenshot)\b", re.I)

required_completion_fields = [
    "run_id",
    "branch",
    "commit_sha",
    "files_changed",
    "test_result",
    "risk",
]

errors = []
warnings = []

try:
    raw = Path(payload_path).read_text(encoding="utf-8")
    payload = json.loads(raw)
except Exception as e:
    out = {
        "valid": False,
        "errors": [f"invalid JSON payload: {e}"],
        "warnings": [],
        "normalized": None,
    }
    print(json.dumps(out, ensure_ascii=True))
    sys.exit(0)

if not isinstance(payload, dict):
    errors.append("payload must be a JSON object")

run_id = str(payload.get("run_id", "")).strip()
if not run_id or re.search(r"\s", run_id):
    errors.append("run_id must be non-empty and contain no whitespace")
elif len(run_id) > 64:
    errors.append("run_id must be <= 64 chars")

request_id = payload.get("request_id")
if not isinstance(request_id, str) or not request_id.strip():
    errors.append("request_id is required for worker dispatch")
else:
    request_id = request_id.strip()
    if re.search(r"\s", request_id):
        errors.append("request_id must contain no whitespace")
    if len(request_id) > 64:
        errors.append("request_id must be <= 64 chars")

context_intent = payload.get("context_intent")
if context_intent not in {"fresh", "continue"}:
    errors.append('context_intent must be either "fresh" or "continue"')

task_type = payload.get("task_type")
if not isinstance(task_type, str) or not task_type.strip():
    errors.append("task_type is required")

ui_impacting = payload.get("ui_impacting")
if ui_impacting is not None and not isinstance(ui_impacting, bool):
    errors.append("ui_impacting must be a boolean when provided")

input_text = payload.get("input")
if not isinstance(input_text, str) or not input_text.strip():
    errors.append("input is required")
elif SCREENSHOT_PATTERN.search(input_text):
    errors.append("input must not request screenshot capture/analysis; use text-based browser evidence")

repo = payload.get("repo")
if not isinstance(repo, str) or not REPO_PATTERN.match(repo):
    errors.append("repo must be in owner/repo format")

base_branch = payload.get("base_branch")
if base_branch is not None:
    if not isinstance(base_branch, str) or not base_branch.strip() or re.search(r"\s", base_branch) or not BASE_BRANCH_PATTERN.match(base_branch):
        errors.append("base_branch must be a non-empty branch name when provided")

branch = payload.get("branch")
if not isinstance(branch, str) or not BRANCH_PATTERN.match(branch):
    errors.append("branch must match jarvis-<feature>")

session_id = payload.get("session_id")
if session_id is not None:
    if not isinstance(session_id, str) or not session_id.strip() or re.search(r"\s", session_id) or not SESSION_ID_PATTERN.match(session_id):
        errors.append("session_id must be a non-empty opaque id with no whitespace when provided")

parent_run_id = payload.get("parent_run_id")
if parent_run_id is not None:
    if not isinstance(parent_run_id, str) or not parent_run_id.strip() or re.search(r"\s", parent_run_id) or len(parent_run_id) > 64:
        errors.append("parent_run_id must be a non-empty id with no whitespace and <= 64 chars when provided")

if context_intent == "fresh" and session_id:
    errors.append('session_id must not be provided when context_intent is "fresh"')

acc = payload.get("acceptance_tests")
if not isinstance(acc, list) or not acc:
    errors.append("acceptance_tests must be a non-empty array")
else:
    for i, item in enumerate(acc):
        if not isinstance(item, str) or not item.strip():
            errors.append(f"acceptance_tests[{i}] must be a non-empty string")
        elif SCREENSHOT_PATTERN.search(item):
            errors.append(f"acceptance_tests[{i}] must not include screenshot commands; use text-based checks")

output_contract = payload.get("output_contract")
if not isinstance(output_contract, dict):
    errors.append("output_contract is required")
else:
    browser_evidence_required = output_contract.get("browser_evidence_required")
    if browser_evidence_required is not None and not isinstance(browser_evidence_required, bool):
        errors.append("output_contract.browser_evidence_required must be a boolean when provided")
    fields = output_contract.get("required_fields")
    if not isinstance(fields, list) or not fields:
        errors.append("output_contract.required_fields must be a non-empty array")
    else:
        for f in required_completion_fields:
            if f not in fields:
                errors.append(f"output_contract.required_fields missing {f}")
        if "pr_url" not in fields and "pr_skipped_reason" not in fields:
            errors.append("output_contract.required_fields must include pr_url or pr_skipped_reason")
        if context_intent == "continue" and "session_id" not in fields:
            errors.append('output_contract.required_fields must include session_id when context_intent is "continue"')

if strict_session_check and isinstance(repo, str) and isinstance(branch, str) and context_intent in {"fresh", "continue"}:
    try:
        conn = sqlite3.connect(db_path)
        conn.row_factory = sqlite3.Row
        cur = conn.cursor()

        if session_id:
            cur.execute(
                "SELECT group_folder FROM worker_runs WHERE effective_session_id = ? ORDER BY started_at DESC LIMIT 1",
                (session_id,),
            )
            row = cur.fetchone()
            if row and row["group_folder"] != target_folder:
                errors.append(f"session_id belongs to {row['group_folder']}; cross-worker session reuse is blocked")

        if context_intent == "continue" and not session_id:
            cur.execute(
                """
                SELECT effective_session_id
                FROM worker_runs
                WHERE group_folder = ?
                  AND dispatch_repo = ?
                  AND dispatch_branch = ?
                  AND effective_session_id IS NOT NULL
                  AND TRIM(effective_session_id) != ''
                ORDER BY started_at DESC
                LIMIT 1
                """,
                (target_folder, repo, branch),
            )
            row = cur.fetchone()
            if not row:
                errors.append("context_intent=continue requires reusable prior session for this worker/repo/branch; provide session_id or use context_intent=fresh")
        conn.close()
    except Exception as e:
        errors.append(f"strict session check failed: {e}")

if context_intent == "fresh" and "session_id" in (output_contract or {}).get("required_fields", []):
    warnings.append("output_contract.required_fields includes session_id while context_intent=fresh; usually unnecessary")

out = {
    "valid": len(errors) == 0,
    "errors": errors,
    "warnings": warnings,
    "normalized": {
        "run_id": run_id,
        "request_id": request_id if isinstance(request_id, str) else None,
        "context_intent": context_intent,
        "repo": repo,
        "branch": branch,
        "parent_run_id": parent_run_id if isinstance(parent_run_id, str) else None,
        "target_folder": target_folder if target_folder else None,
    },
}
print(json.dumps(out, ensure_ascii=True))
PY
)"

valid="$(python3 - "$result" <<'PY'
import json, sys
print("true" if json.loads(sys.argv[1]).get("valid") else "false")
PY
)"

echo "== Jarvis Dispatch Lint =="
if [ "$USE_STDIN" -eq 1 ]; then
  echo "input: <stdin>"
else
  echo "input: $INPUT_FILE"
fi
[ -n "$TARGET_FOLDER" ] && echo "target folder: $TARGET_FOLDER"
[ "$STRICT_SESSION_CHECK" -eq 1 ] && echo "strict session check: enabled"

python3 - "$result" <<'PY'
import json
import sys
obj = json.loads(sys.argv[1])
if obj.get("valid"):
    print("[PASS] dispatch payload is valid")
else:
    print("[FAIL] dispatch payload is invalid")
for e in obj.get("errors", []):
    print(f"  - error: {e}")
for w in obj.get("warnings", []):
    print(f"  - warning: {w}")
PY

if [ "$JSON_MODE" -eq 1 ]; then
  echo
  python3 - "$result" <<'PY'
import json
import sys
obj = json.loads(sys.argv[1])
print(json.dumps({
    "script": "jarvis-dispatch-lint",
    "valid": obj.get("valid"),
    "errors": obj.get("errors", []),
    "warnings": obj.get("warnings", []),
    "normalized": obj.get("normalized"),
}, ensure_ascii=True, indent=2))
PY
fi

if [ -n "$JSON_OUT" ]; then
  python3 - "$result" <<'PY' >"$JSON_OUT"
import json
import sys
obj = json.loads(sys.argv[1])
print(json.dumps({
    "script": "jarvis-dispatch-lint",
    "valid": obj.get("valid"),
    "errors": obj.get("errors", []),
    "warnings": obj.get("warnings", []),
    "normalized": obj.get("normalized"),
}, ensure_ascii=True, indent=2))
PY
fi

if [ "$valid" != "true" ]; then
  exit 1
fi
