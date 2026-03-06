#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

MODE="resume" # resume|fork|fresh
SESSION_ID=""
PROFILE="read-only" # read-only|scoped-ops|elevated
TIMEOUT_SEC="${CLAUDE_CONSULT_TIMEOUT_SEC:-120}"
PERMISSION_MODE="default"
QUESTION=""
QUESTION_FILE=""
ALLOWED_TOOLS_OVERRIDE=""
EXPECT_JSON=1
SCHEMA_ENABLED=1

DEFAULT_SCHEMA='{"type":"object","properties":{"summary":{"type":"string"},"actions":{"type":"array","items":{"type":"string"}},"risks":{"type":"array","items":{"type":"string"}},"missing_evidence":{"type":"array","items":{"type":"string"}}},"required":["summary","actions"]}'
SCHEMA_JSON="$DEFAULT_SCHEMA"

usage() {
  cat <<'USAGE'
Usage: scripts/claude-consult.sh [options] --question "<prompt>"
       scripts/claude-consult.sh [options] "<prompt>"

Safe non-interactive Claude consult wrapper with timeout + default JSON schema.

Session mode:
  --session-id <id>         Resume this session ID (default mode)
  --fork-session            Resume session and fork it first
  --fresh                   Start a fresh Claude session (no resume)

Safety profile:
  --profile <name>          read-only|scoped-ops|elevated (default: read-only)
  --permission-mode <mode>  Claude permission mode for non-elevated profiles
  --allowed-tools <tools>   Override allowed tools (comma-separated)

Output contract:
  --plain-output            Disable JSON output/schema contract
  --schema-json <json>      Override JSON schema string
  --schema-file <path>      Load JSON schema from file
  --no-schema               Keep JSON output, but do not pass --json-schema
                            (wrapper still parses JSON envelope and emits structured payload if present)

Prompt input:
  --question "<text>"       Prompt text
  --question-file <path>    Read prompt from file

Execution:
  --timeout-sec <n>         Hard timeout in seconds (default: 120 or env CLAUDE_CONSULT_TIMEOUT_SEC)
  -h, --help                Show help

Examples:
  scripts/claude-consult.sh \
    --session-id 0782eacb-3469-4379-a554-2fc0c664b09c \
    --question "Summarize unresolved reliability risks in this repo."

  scripts/claude-consult.sh \
    --session-id 0782eacb-3469-4379-a554-2fc0c664b09c \
    --fork-session \
    --profile scoped-ops \
    --schema-file docs/examples/consult-schema.json \
    --question "List top 3 dispatch contract gaps with file references."
USAGE
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --session-id)
      [ "$#" -ge 2 ] || { echo "Missing value for --session-id" >&2; exit 1; }
      SESSION_ID="$2"
      shift 2
      ;;
    --fork-session)
      MODE="fork"
      shift
      ;;
    --fresh)
      MODE="fresh"
      shift
      ;;
    --profile)
      [ "$#" -ge 2 ] || { echo "Missing value for --profile" >&2; exit 1; }
      PROFILE="$2"
      shift 2
      ;;
    --permission-mode)
      [ "$#" -ge 2 ] || { echo "Missing value for --permission-mode" >&2; exit 1; }
      PERMISSION_MODE="$2"
      shift 2
      ;;
    --allowed-tools)
      [ "$#" -ge 2 ] || { echo "Missing value for --allowed-tools" >&2; exit 1; }
      ALLOWED_TOOLS_OVERRIDE="$2"
      shift 2
      ;;
    --plain-output)
      EXPECT_JSON=0
      SCHEMA_ENABLED=0
      shift
      ;;
    --schema-json)
      [ "$#" -ge 2 ] || { echo "Missing value for --schema-json" >&2; exit 1; }
      SCHEMA_JSON="$2"
      shift 2
      ;;
    --schema-file)
      [ "$#" -ge 2 ] || { echo "Missing value for --schema-file" >&2; exit 1; }
      SCHEMA_JSON="$(cat "$2")"
      shift 2
      ;;
    --no-schema)
      SCHEMA_ENABLED=0
      shift
      ;;
    --question)
      [ "$#" -ge 2 ] || { echo "Missing value for --question" >&2; exit 1; }
      QUESTION="$2"
      shift 2
      ;;
    --question-file)
      [ "$#" -ge 2 ] || { echo "Missing value for --question-file" >&2; exit 1; }
      QUESTION_FILE="$2"
      shift 2
      ;;
    --timeout-sec)
      [ "$#" -ge 2 ] || { echo "Missing value for --timeout-sec" >&2; exit 1; }
      TIMEOUT_SEC="$2"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    --)
      shift
      break
      ;;
    -*)
      echo "Unknown option: $1" >&2
      usage
      exit 1
      ;;
    *)
      break
      ;;
  esac
done

if [ -n "$QUESTION_FILE" ]; then
  QUESTION="$(cat "$QUESTION_FILE")"
elif [ -z "$QUESTION" ] && [ "$#" -gt 0 ]; then
  QUESTION="$*"
fi

if [ -z "$QUESTION" ]; then
  echo "Missing question text. Use --question, --question-file, or positional prompt." >&2
  exit 1
fi

case "$MODE" in
  resume|fork)
    if [ -z "$SESSION_ID" ]; then
      echo "Session mode '$MODE' requires --session-id." >&2
      exit 1
    fi
    ;;
  fresh)
    if [ -n "$SESSION_ID" ]; then
      echo "--fresh cannot be combined with --session-id." >&2
      exit 1
    fi
    ;;
  *)
    echo "Invalid mode: $MODE" >&2
    exit 1
    ;;
esac

case "$PROFILE" in
  read-only|scoped-ops|elevated) ;;
  *)
    echo "Invalid profile: $PROFILE (expected read-only|scoped-ops|elevated)" >&2
    exit 1
    ;;
esac

if ! [[ "$TIMEOUT_SEC" =~ ^[0-9]+$ ]] || [ "$TIMEOUT_SEC" -lt 1 ]; then
  echo "--timeout-sec must be a positive integer." >&2
  exit 1
fi

allowed_tools_for_profile() {
  case "$1" in
    read-only) echo "Read,Grep,Glob" ;;
    scoped-ops) echo "Read,Grep,Glob,Bash(git status),Bash(git diff *)" ;;
    elevated) echo "" ;;
    *) return 1 ;;
  esac
}

CLAUDE_CMD=(claude)

case "$MODE" in
  resume)
    CLAUDE_CMD+=(--resume "$SESSION_ID")
    ;;
  fork)
    CLAUDE_CMD+=(--resume "$SESSION_ID" --fork-session)
    ;;
  fresh)
    ;;
esac

if [ "$PROFILE" = "elevated" ]; then
  CLAUDE_CMD+=(--dangerously-skip-permissions)
else
  CLAUDE_CMD+=(--permission-mode "$PERMISSION_MODE")
  if [ -n "$ALLOWED_TOOLS_OVERRIDE" ]; then
    CLAUDE_CMD+=(--allowedTools "$ALLOWED_TOOLS_OVERRIDE")
  else
    profile_tools="$(allowed_tools_for_profile "$PROFILE")"
    if [ -n "$profile_tools" ]; then
      CLAUDE_CMD+=(--allowedTools "$profile_tools")
    fi
  fi
fi

if [ "$EXPECT_JSON" -eq 1 ]; then
  CLAUDE_CMD+=(--output-format json)
  if [ "$SCHEMA_ENABLED" -eq 1 ]; then
    CLAUDE_CMD+=(--json-schema "$SCHEMA_JSON")
  fi
fi

CLAUDE_CMD+=(-p "$QUESTION")

stdout_file="$(mktemp /tmp/claude-consult-stdout.XXXXXX)"
stderr_file="$(mktemp /tmp/claude-consult-stderr.XXXXXX)"
cleanup() {
  rm -f "$stdout_file" "$stderr_file"
}
trap cleanup EXIT

if ! python3 - "$TIMEOUT_SEC" "$stdout_file" "$stderr_file" "${CLAUDE_CMD[@]}" <<'PY'
import subprocess
import sys

timeout_sec = int(sys.argv[1])
stdout_path = sys.argv[2]
stderr_path = sys.argv[3]
cmd = sys.argv[4:]

with open(stdout_path, "wb") as out, open(stderr_path, "wb") as err:
    try:
        proc = subprocess.run(cmd, stdout=out, stderr=err, timeout=timeout_sec)
        raise SystemExit(proc.returncode)
    except subprocess.TimeoutExpired:
        err.write(f"[claude-consult] timeout after {timeout_sec}s\n".encode("utf-8"))
        raise SystemExit(124)
PY
then
  rc=$?
  if [ -s "$stderr_file" ]; then
    cat "$stderr_file" >&2
  fi
  if [ -s "$stdout_file" ]; then
    cat "$stdout_file" >&2
  fi
  exit "$rc"
fi

if [ "$EXPECT_JSON" -eq 1 ]; then
  if ! python3 - "$stdout_file" "$SCHEMA_ENABLED" "$SCHEMA_JSON" <<'PY'
import json
import pathlib
import sys

payload_path = pathlib.Path(sys.argv[1])
schema_enabled = sys.argv[2] == "1"
schema_json = sys.argv[3]

payload = payload_path.read_text(encoding="utf-8")
obj = json.loads(payload)
if not isinstance(obj, dict):
    raise SystemExit("Expected top-level JSON object output.")

# Claude's --output-format json returns an envelope; emit the structured payload when present.
structured = obj.get("structured_output")
out = structured if isinstance(structured, dict) else obj

def validate(value, schema, path="$"):
    stype = schema.get("type")
    if stype == "object":
        if not isinstance(value, dict):
            raise SystemExit(f"{path}: expected object")
        required = schema.get("required", [])
        for key in required:
            if key not in value:
                raise SystemExit(f"{path}: missing required key '{key}'")
        props = schema.get("properties", {})
        for key, prop_schema in props.items():
            if key in value:
                validate(value[key], prop_schema, f"{path}.{key}")
    elif stype == "array":
        if not isinstance(value, list):
            raise SystemExit(f"{path}: expected array")
        item_schema = schema.get("items")
        if item_schema:
            for idx, item in enumerate(value):
                validate(item, item_schema, f"{path}[{idx}]")
    elif stype == "string":
        if not isinstance(value, str):
            raise SystemExit(f"{path}: expected string")
    elif stype == "number":
        if not isinstance(value, (int, float)) or isinstance(value, bool):
            raise SystemExit(f"{path}: expected number")
    elif stype == "integer":
        if not isinstance(value, int) or isinstance(value, bool):
            raise SystemExit(f"{path}: expected integer")
    elif stype == "boolean":
        if not isinstance(value, bool):
            raise SystemExit(f"{path}: expected boolean")
    elif stype in (None,):
        return
    else:
        raise SystemExit(f"{path}: unsupported schema type '{stype}'")

if schema_enabled:
    schema = json.loads(schema_json)
    validate(out, schema)

print(json.dumps(out, indent=2, ensure_ascii=False))
PY
  then
    echo "[claude-consult] invalid JSON output" >&2
    if [ -s "$stderr_file" ]; then
      cat "$stderr_file" >&2
    fi
    exit 1
  fi
else
  cat "$stdout_file"
fi
