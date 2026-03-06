#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

INPUT_FILE=""
USE_STDIN=0
EXPECTED_RUN_ID=""
EXPECTED_BRANCH=""
REQUIRED_FIELDS="run_id,branch,commit_sha,files_changed,test_result,risk"
ALLOW_NO_CODE=0
JSON_MODE=0
JSON_OUT=""

usage() {
  cat <<'USAGE'
Usage: scripts/jarvis-completion-contract-lint.sh [options]

Validate worker completion contract payload from raw output text.

Options:
  --file <path>               Completion output file
  --stdin                     Read completion output from stdin
  --expected-run-id <id>      Require completion.run_id to match
  --expected-branch <name>    Require completion.branch to match
  --required-fields <csv>     Required fields list (default: run_id,branch,commit_sha,files_changed,test_result,risk)
  --allow-no-code             Allow no-code completion patterns
  --json                      Emit JSON result to stdout
  --json-out <path>           Write JSON result to file
  -h, --help                  Show help
USAGE
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --file) INPUT_FILE="$2"; shift 2 ;;
    --stdin) USE_STDIN=1; shift ;;
    --expected-run-id) EXPECTED_RUN_ID="$2"; shift 2 ;;
    --expected-branch) EXPECTED_BRANCH="$2"; shift 2 ;;
    --required-fields) REQUIRED_FIELDS="$2"; shift 2 ;;
    --allow-no-code) ALLOW_NO_CODE=1; shift ;;
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
  echo "Completion file not found: $INPUT_FILE"
  exit 1
fi

input_file=""
cleanup() {
  if [ "$USE_STDIN" -eq 1 ] && [ -n "$input_file" ]; then
    rm -f "$input_file"
  fi
}
trap cleanup EXIT

if [ "$USE_STDIN" -eq 1 ]; then
  input_file="$(mktemp /tmp/jarvis-completion.XXXXXX)"
  cat >"$input_file"
else
  input_file="$INPUT_FILE"
fi

result="$(python3 - "$input_file" "$EXPECTED_RUN_ID" "$EXPECTED_BRANCH" "$REQUIRED_FIELDS" "$ALLOW_NO_CODE" <<'PY'
import json
import re
import sys
from pathlib import Path

input_path, expected_run_id, expected_branch, required_fields_csv, allow_no_code = sys.argv[1:6]
allow_no_code = allow_no_code == "1"

RUN_ID_MAX_LENGTH = 64
SESSION_ID_MAX_LENGTH = 128
BRANCH_PATTERN = re.compile(r"^jarvis-[A-Za-z0-9._/-]+$")
COMMIT_SHA_PATTERN = re.compile(r"^[0-9a-f]{6,40}$", re.I)
SESSION_ID_PATTERN = re.compile(r"^[A-Za-z0-9._:-]+$")

required_fields = [part.strip() for part in required_fields_csv.split(",") if part.strip()]
if not required_fields:
    required_fields = ["run_id", "branch", "commit_sha", "files_changed", "test_result", "risk"]

def parse_json_object(raw: str):
    try:
        parsed = json.loads(raw.strip())
    except Exception:
        return None
    if isinstance(parsed, dict):
        return parsed
    return None

def decode_escaped_text(raw: str):
    s = raw.strip()
    if not s:
        return None
    try:
        parsed = json.loads(s)
        if isinstance(parsed, str) and parsed.strip():
            return parsed
    except Exception:
        pass
    if not re.search(r'\\[nrt"\\\\]', s):
        return None
    decoded = (
        s.replace("\\r\\n", "\n")
         .replace("\\n", "\n")
         .replace("\\r", "\r")
         .replace("\\t", "\t")
         .replace('\\"', '"')
         .replace("\\\\", "\\")
    )
    return decoded if decoded.strip() and decoded != s else None

def parse_object_flexible(raw: str):
    obj = parse_json_object(raw)
    if obj is not None:
        return obj
    decoded = decode_escaped_text(raw)
    if decoded is not None:
        return parse_json_object(decoded)
    return None

def parse_latest_completion_tag(output: str):
    latest = None
    for match in re.finditer(r"<completion>([\s\S]*?)</completion>", output, re.I):
        candidate = parse_object_flexible(match.group(1))
        if isinstance(candidate, dict):
            latest = candidate
    return latest

raw_output = Path(input_path).read_text(encoding="utf-8", errors="ignore")

contract = parse_latest_completion_tag(raw_output)
if contract is None:
    trimmed = raw_output.strip()
    fenced = re.match(r"^```(?:json)?\s*([\s\S]*?)\s*```$", trimmed, re.I)
    direct_candidate = fenced.group(1).strip() if fenced else trimmed
    decoded = decode_escaped_text(direct_candidate)
    if decoded is not None:
        parsed_decoded_tag = parse_latest_completion_tag(decoded)
        if parsed_decoded_tag is not None:
            contract = parsed_decoded_tag
    if contract is None:
        contract = parse_object_flexible(direct_candidate)

missing = []
warnings = []

if contract is None:
    missing.append("completion block")
else:
    has_pr_skip = bool(str(contract.get("pr_skipped_reason", "")).strip())
    effective_no_code = allow_no_code or has_pr_skip

    if "run_id" in required_fields:
        run_id = contract.get("run_id")
        if not isinstance(run_id, str) or not run_id.strip():
            missing.append("run_id")
        elif re.search(r"\s", run_id) or len(run_id) > RUN_ID_MAX_LENGTH:
            missing.append("run_id format")
        elif expected_run_id and run_id != expected_run_id:
            missing.append("run_id mismatch")

    if "branch" in required_fields:
        branch = contract.get("branch")
        if not isinstance(branch, str) or not BRANCH_PATTERN.match(branch):
            missing.append("branch")
        elif expected_branch and branch != expected_branch:
            missing.append("branch mismatch")

    if "commit_sha" in required_fields:
        commit_sha = str(contract.get("commit_sha", "")).strip()
        if not commit_sha:
            if not effective_no_code:
                missing.append("commit_sha")
        else:
            if COMMIT_SHA_PATTERN.match(commit_sha):
                pass
            elif effective_no_code and re.match(r"^(n/a|na|none|no-commit)$", commit_sha, re.I):
                pass
            elif not effective_no_code:
                missing.append("commit_sha format")

    if "files_changed" in required_fields:
        files_changed = contract.get("files_changed")
        if not isinstance(files_changed, list):
            if not effective_no_code:
                missing.append("files_changed")
        else:
            bad = [item for item in files_changed if not isinstance(item, str) or not item.strip()]
            if bad:
                missing.append("files_changed format")

    if "test_result" in required_fields:
        test_result = contract.get("test_result")
        if not isinstance(test_result, str) or not test_result.strip():
            missing.append("test_result")

    if "risk" in required_fields:
        risk = contract.get("risk")
        if not isinstance(risk, str) or not risk.strip():
            missing.append("risk")

    if not str(contract.get("pr_url", "")).strip() and not str(contract.get("pr_skipped_reason", "")).strip():
        missing.append("pr_url or pr_skipped_reason")

    if "session_id" in required_fields:
        session_id = contract.get("session_id")
        if (
            not isinstance(session_id, str)
            or not session_id.strip()
            or re.search(r"\s", session_id)
            or len(session_id) > SESSION_ID_MAX_LENGTH
            or not SESSION_ID_PATTERN.match(session_id)
        ):
            missing.append("session_id")

if contract is not None and "run_id" not in required_fields and expected_run_id:
    warnings.append("expected-run-id supplied but run_id is not in required fields")
if contract is not None and "branch" not in required_fields and expected_branch:
    warnings.append("expected-branch supplied but branch is not in required fields")

print(json.dumps({
    "valid": len(missing) == 0,
    "missing": missing,
    "warnings": warnings,
    "required_fields": required_fields,
    "expected_run_id": expected_run_id or None,
    "expected_branch": expected_branch or None,
    "allow_no_code": allow_no_code,
    "contract": contract,
}, ensure_ascii=True))
PY
)"

valid="$(python3 - "$result" <<'PY'
import json
import sys
print("true" if json.loads(sys.argv[1]).get("valid") else "false")
PY
)"

echo "== Jarvis Completion Contract Lint =="
if [ "$USE_STDIN" -eq 1 ]; then
  echo "input: <stdin>"
else
  echo "input: $INPUT_FILE"
fi
[ -n "$EXPECTED_RUN_ID" ] && echo "expected run_id: $EXPECTED_RUN_ID"
[ -n "$EXPECTED_BRANCH" ] && echo "expected branch: $EXPECTED_BRANCH"
echo "required fields: $REQUIRED_FIELDS"

python3 - "$result" <<'PY'
import json
import sys
obj = json.loads(sys.argv[1])
if obj.get("valid"):
    print("[PASS] completion contract is valid")
else:
    print("[FAIL] completion contract is invalid")
for m in obj.get("missing", []):
    print(f"  - missing: {m}")
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
    "script": "jarvis-completion-contract-lint",
    "valid": obj.get("valid"),
    "missing": obj.get("missing", []),
    "warnings": obj.get("warnings", []),
    "required_fields": obj.get("required_fields", []),
    "expected_run_id": obj.get("expected_run_id"),
    "expected_branch": obj.get("expected_branch"),
    "allow_no_code": obj.get("allow_no_code"),
    "contract": obj.get("contract"),
}, ensure_ascii=True, indent=2))
PY
fi

if [ -n "$JSON_OUT" ]; then
  python3 - "$result" <<'PY' >"$JSON_OUT"
import json
import sys
obj = json.loads(sys.argv[1])
print(json.dumps({
    "script": "jarvis-completion-contract-lint",
    "valid": obj.get("valid"),
    "missing": obj.get("missing", []),
    "warnings": obj.get("warnings", []),
    "required_fields": obj.get("required_fields", []),
    "expected_run_id": obj.get("expected_run_id"),
    "expected_branch": obj.get("expected_branch"),
    "allow_no_code": obj.get("allow_no_code"),
    "contract": obj.get("contract"),
}, ensure_ascii=True, indent=2))
PY
fi

if [ "$valid" != "true" ]; then
  exit 1
fi
