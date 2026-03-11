#!/usr/bin/env bash
set -euo pipefail

# qmd-context-recall.sh
# Recall-only workflow: search QMD session context and manage handoff notes.
# This script intentionally has no session export sync or git commit/push flow.
#
# Usage:
#   scripts/qmd-context-recall.sh "worker connectivity dispatch"
#   scripts/qmd-context-recall.sh --search-mode hybrid "dispatch contract mismatch"
#   scripts/qmd-context-recall.sh --bootstrap
#   scripts/qmd-context-recall.sh --close --next "run verify-worker-connectivity"
#
# Env overrides:
#   QMD_BIN, HANDOFF_FILE, QCTX_SEARCH_MODE, QMD_MODELS_DIR, QCTX_INCIDENT_FALLBACK,
#   QCTX_BOOTSTRAP_TOP, QCTX_BOOTSTRAP_FETCH, QCTX_BOOTSTRAP_LINES

QMD_BIN="${QMD_BIN:-qmd}"
HANDOFF_FILE="${HANDOFF_FILE:-$(pwd)/.claude/progress/session-handoff.jsonl}"
SEARCH_MODE="${QCTX_SEARCH_MODE:-auto}"
QMD_MODELS_DIR="${QMD_MODELS_DIR:-$HOME/.cache/qmd/models}"
QCTX_INCIDENT_FALLBACK="${QCTX_INCIDENT_FALLBACK:-1}"
QCTX_BOOTSTRAP_TOP="${QCTX_BOOTSTRAP_TOP:-5}"
QCTX_BOOTSTRAP_FETCH="${QCTX_BOOTSTRAP_FETCH:-1}"
QCTX_BOOTSTRAP_LINES="${QCTX_BOOTSTRAP_LINES:-80}"

TOP=8
FETCH=2
LINES=140
COLLECTION="sessions"
MODE="search"
ISSUE_ID=""
DONE_TEXT=""
NEXT_STEP=""
BLOCKER_TEXT=""
COMMANDS_RUN=""
SESSION_STATE="handoff"
USER_SET_TOP=0
USER_SET_FETCH=0

usage() {
  cat <<'EOF'
Usage:
  qmd-context-recall.sh [options] "<query>"
  qmd-context-recall.sh --bootstrap [options] ["<query>"]
  qmd-context-recall.sh --close --next "<next step>" [options]

Options:
  --top N          Number of search hits (default: 8)
  --fetch N        Number of top hits to expand with qmd get (default: 2)
  --lines N        Lines to fetch per expanded hit (default: 140)
  --search-mode M  Search strategy: auto|bm25|hybrid (default: auto)
  --collection C   QMD collection (default: sessions)
  --bootstrap      Session-start mode: handoff-aware query + search
  --close          Session-end mode: write structured handoff record
  --issue ID       Issue/ticket identifier (e.g., INC-123, GH-42)
  --done TEXT      What was completed in this session
  --next TEXT      Next concrete step for the next session
  --blocker TEXT   Current blocker, if any
  --commands TEXT  Important commands run in this session
  --state STATE    active|done|blocked|handoff (default: handoff)
  --no-incident-fallback
                  Disable fallback query from latest open incident on no-hit search
  --no-get         Don't expand hits with qmd get
  -h, --help       Show this help

Deprecated (moved to qmd-session-sync.sh):
  --force-sync, --no-sync, --git-sync, --git-push, --no-git-sync
EOF
}

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Missing required command: $1" >&2
    exit 1
  fi
}

has_doc_hits() {
  local input="$1"
  printf '%s\n' "$input" | awk '/^#/{found=1} END{exit !found}'
}

has_hybrid_model() {
  [[ -d "$QMD_MODELS_DIR" ]] || return 1
  find "$QMD_MODELS_DIR" -type f -name "*.gguf" -size +50M -print -quit 2>/dev/null | grep -q .
}

run_qmd_lookup() {
  local mode="$1"
  local query="$2"
  if [[ "$mode" == "hybrid" ]]; then
    "$QMD_BIN" query "$query" -c "$COLLECTION" -n "$TOP" --files
  else
    "$QMD_BIN" search "$query" -c "$COLLECTION" -n "$TOP" --files
  fi
}

extract_latest_incident_query() {
  local incident_file="$1"
  python3 - "$incident_file" <<'PY'
import json
import re
import sys
from pathlib import Path

path = Path(sys.argv[1]).expanduser()
if not path.exists():
    print("")
    raise SystemExit(0)

try:
    data = json.loads(path.read_text(encoding="utf-8"))
except Exception:
    print("")
    raise SystemExit(0)

incidents = data.get("incidents") or []
open_incidents = [i for i in incidents if str(i.get("status", "")).strip().lower() == "open"]
if not open_incidents:
    print("")
    raise SystemExit(0)

open_incidents.sort(key=lambda row: str(row.get("updated_at", "")), reverse=True)
latest = open_incidents[0]
summary = latest.get("summary") or {}
text_parts = [
    latest.get("title", ""),
    summary.get("symptom", ""),
    summary.get("suspected_cause", ""),
    summary.get("next_action", ""),
]
raw = " ".join(str(p) for p in text_parts if p).strip().lower()
if not raw:
    print("")
    raise SystemExit(0)

tokens = re.findall(r"[a-z0-9][a-z0-9_-]{1,}", raw)
stop = {
    "the", "and", "for", "with", "that", "this", "from", "into", "after",
    "before", "while", "then", "than", "when", "where", "were", "been",
    "have", "has", "had", "are", "was", "will", "can", "could", "should",
    "must", "not", "but", "still", "issue", "incident", "lane", "open",
    "worker", "workers", "run", "runs", "task", "tasks", "status", "next",
    "action", "due", "via", "andy", "jarvis",
}
picked = []
for tok in tokens:
    if tok in stop:
        continue
    if tok not in picked:
        picked.append(tok)
    if len(picked) >= 14:
        break

print(" ".join(picked))
PY
}

search_with_branch_fallback() {
  local mode="$1"
  local query="$2"
  local label="BM25"
  local output=""
  local effective_query="$query"

  if [[ "$mode" == "hybrid" ]]; then
    label="Hybrid"
  fi

  output="$(run_qmd_lookup "$mode" "$query" 2>&1 || true)"
  if [[ "$output" == *"No results found."* ]] && [[ -n "$BRANCH" ]] && [[ "$query" != *"$BRANCH"* ]] && [[ "$BRANCH" != "main" ]] && [[ "$BRANCH" != "master" ]] && [[ "$BRANCH" != "HEAD" ]]; then
    effective_query="$query $BRANCH"
    echo "No direct ${label} hits. Retrying with branch context: $effective_query"
    output="$(run_qmd_lookup "$mode" "$effective_query" 2>&1 || true)"
  fi

  SEARCH_EFFECTIVE_QUERY="$effective_query"
  SEARCH_EFFECTIVE_RESULTS="$output"
}

run_search_pipeline() {
  local query="$1"
  local results=""
  local final_query="$query"
  local final_mode="$SEARCH_MODE"

  if [[ "$SEARCH_MODE" == "hybrid" ]]; then
    search_with_branch_fallback "hybrid" "$query"
    final_query="$SEARCH_EFFECTIVE_QUERY"
    results="$SEARCH_EFFECTIVE_RESULTS"
  elif [[ "$SEARCH_MODE" == "bm25" ]]; then
    search_with_branch_fallback "bm25" "$query"
    final_query="$SEARCH_EFFECTIVE_QUERY"
    results="$SEARCH_EFFECTIVE_RESULTS"
  else
    search_with_branch_fallback "bm25" "$query"
    local bm25_query="$SEARCH_EFFECTIVE_QUERY"
    local bm25_results="$SEARCH_EFFECTIVE_RESULTS"
    results="$bm25_results"
    final_query="$bm25_query"
    final_mode="bm25"

    if has_hybrid_model; then
      echo "Running hybrid rerank over the same query..."
      search_with_branch_fallback "hybrid" "$bm25_query"
      local hybrid_results="$SEARCH_EFFECTIVE_RESULTS"
      if has_doc_hits "$hybrid_results"; then
        results="$hybrid_results"
        final_query="$SEARCH_EFFECTIVE_QUERY"
        final_mode="hybrid"
      else
        echo "Hybrid returned no ranked hits. Using BM25 results."
      fi
    else
      echo "Hybrid model not detected; using BM25 now. Run '--search-mode hybrid' once to warm cache."
    fi
  fi

  PIPELINE_RESULTS="$results"
  PIPELINE_FINAL_QUERY="$final_query"
  PIPELINE_FINAL_MODE="$final_mode"
}

compact_words() {
  local text="$1"
  local max_words="$2"
  printf '%s' "$text" | tr '\n' ' ' | tr -s ' ' | awk -v n="$max_words" '
    {
      out="";
      count=0;
      for (i=1; i<=NF && count<n; i++) {
        if (length($i) == 0) continue;
        out = out (count ? " " : "") $i;
        count++;
      }
      print out;
    }'
}

load_latest_handoff() {
  local branch="$1"
  python3 - "$HANDOFF_FILE" "$branch" <<'PY'
import json, os, sys
path = sys.argv[1]
branch = sys.argv[2]
blank = "\t".join([""] * 7)
if not os.path.exists(path):
    print(blank)
    raise SystemExit(0)
rows = []
with open(path, "r", encoding="utf-8") as f:
    for line in f:
        line = line.strip()
        if not line:
            continue
        try:
            rows.append(json.loads(line))
        except Exception:
            continue
if not rows:
    print(blank)
    raise SystemExit(0)
branch_rows = [r for r in rows if str(r.get("branch", "")).strip() == branch]
row = branch_rows[-1] if branch_rows else rows[-1]
def norm(v):
    if v is None:
        return ""
    if isinstance(v, list):
        v = ", ".join(str(x) for x in v)
    s = str(v).replace("\t", " ").replace("\n", " ").strip()
    return s
fields = ["timestamp", "branch", "issue", "state", "done", "next_step", "blocker"]
print("\t".join(norm(row.get(k, "")) for k in fields))
PY
}

save_handoff() {
  local ts="$1"
  local branch="$2"
  local issue="$3"
  local state="$4"
  local done="$5"
  local next="$6"
  local blocker="$7"
  local commands="$8"
  local files="$9"

  mkdir -p "$(dirname "$HANDOFF_FILE")"
  python3 - "$HANDOFF_FILE" "$ts" "$branch" "$issue" "$state" "$done" "$next" "$blocker" "$commands" "$files" <<'PY'
import json, sys
path, ts, branch, issue, state, done, next_step, blocker, commands, files = sys.argv[1:]
files_list = [f for f in files.split(",") if f.strip()]
record = {
    "timestamp": ts,
    "branch": branch,
    "issue": issue,
    "state": state,
    "done": done,
    "next_step": next_step,
    "blocker": blocker,
    "commands_run": commands,
    "files_touched": files_list,
}
with open(path, "a", encoding="utf-8") as f:
    f.write(json.dumps(record, ensure_ascii=True) + "\n")
print(path)
PY
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --top)
      TOP="${2:-}"
      USER_SET_TOP=1
      shift 2
      ;;
    --fetch)
      FETCH="${2:-}"
      USER_SET_FETCH=1
      shift 2
      ;;
    --lines)
      LINES="${2:-}"
      shift 2
      ;;
    --search-mode)
      SEARCH_MODE="${2:-}"
      shift 2
      ;;
    --collection)
      COLLECTION="${2:-}"
      shift 2
      ;;
    --bootstrap)
      MODE="bootstrap"
      shift
      ;;
    --close)
      MODE="close"
      shift
      ;;
    --issue)
      ISSUE_ID="${2:-}"
      shift 2
      ;;
    --done)
      DONE_TEXT="${2:-}"
      shift 2
      ;;
    --next)
      NEXT_STEP="${2:-}"
      shift 2
      ;;
    --blocker)
      BLOCKER_TEXT="${2:-}"
      shift 2
      ;;
    --commands)
      COMMANDS_RUN="${2:-}"
      shift 2
      ;;
    --state)
      SESSION_STATE="${2:-}"
      shift 2
      ;;
    --no-incident-fallback)
      QCTX_INCIDENT_FALLBACK=0
      shift
      ;;
    --no-get)
      FETCH=0
      USER_SET_FETCH=1
      shift
      ;;
    --force-sync|--no-sync|--git-sync|--git-push|--no-git-sync)
      echo "Option '$1' moved out of qmd-context-recall.sh." >&2
      echo "Run: bash scripts/qmd-session-sync.sh  # sync + qmd update + git add/commit" >&2
      exit 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      break
      ;;
  esac
done

BRANCH="$(git rev-parse --abbrev-ref HEAD 2>/dev/null || true)"

if [[ "$MODE" == "close" ]]; then
  if [[ "$SESSION_STATE" != "active" && "$SESSION_STATE" != "done" && "$SESSION_STATE" != "blocked" && "$SESSION_STATE" != "handoff" ]]; then
    echo "Invalid --state: $SESSION_STATE (expected active|done|blocked|handoff)" >&2
    exit 2
  fi
  if [[ -z "$NEXT_STEP" && -z "$DONE_TEXT" && -z "$BLOCKER_TEXT" ]]; then
    echo "--close requires at least one of --next, --done, or --blocker." >&2
    exit 2
  fi

  FILES_TOUCHED="$({
    git diff --name-only 2>/dev/null || true
    git diff --name-only --cached 2>/dev/null || true
  } | awk 'NF' | sort -u | head -n 40 | paste -sd',' -)"
  TS="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  if [[ -z "$BRANCH" || "$BRANCH" == "HEAD" ]]; then
    BRANCH="unknown-branch"
  fi

  save_handoff "$TS" "$BRANCH" "$ISSUE_ID" "$SESSION_STATE" "$DONE_TEXT" "$NEXT_STEP" "$BLOCKER_TEXT" "$COMMANDS_RUN" "$FILES_TOUCHED" >/dev/null
  echo "Handoff saved to: $HANDOFF_FILE"
  echo "  branch:  $BRANCH"
  [[ -n "$ISSUE_ID" ]] && echo "  issue:   $ISSUE_ID"
  [[ -n "$DONE_TEXT" ]] && echo "  done:    $DONE_TEXT"
  [[ -n "$NEXT_STEP" ]] && echo "  next:    $NEXT_STEP"
  [[ -n "$BLOCKER_TEXT" ]] && echo "  blocker: $BLOCKER_TEXT"
  [[ -n "$FILES_TOUCHED" ]] && echo "  files:   $FILES_TOUCHED"

  if [[ -n "${NOTION_SESSION_SUMMARY_DATABASE_ID:-}" ]]; then
    echo
    echo "Publishing shared session summary to Notion..."
    node scripts/workflow/notion-context.js publish-session-summary \
      --database "$NOTION_SESSION_SUMMARY_DATABASE_ID" \
      --title "${ISSUE_ID:-$BRANCH} session summary (${TS})" \
      --branch "$BRANCH" \
      --issue "$ISSUE_ID" \
      --state "$SESSION_STATE" \
      --done "$DONE_TEXT" \
      --next "$NEXT_STEP" \
      --blocker "$BLOCKER_TEXT"
  fi

  echo
  echo "Next session:"
  if [[ -n "$ISSUE_ID" ]]; then
    echo "  qctx --bootstrap --issue \"$ISSUE_ID\""
  else
    echo "  qctx --bootstrap"
  fi
  exit 0
fi

QUERY="${*:-}"

require_cmd "$QMD_BIN"
require_cmd python3

if [[ "$SEARCH_MODE" != "auto" && "$SEARCH_MODE" != "bm25" && "$SEARCH_MODE" != "hybrid" ]]; then
  echo "Invalid --search-mode: $SEARCH_MODE (expected auto|bm25|hybrid)" >&2
  exit 2
fi

if [[ "$MODE" == "bootstrap" ]]; then
  if (( USER_SET_TOP == 0 )); then
    TOP="$QCTX_BOOTSTRAP_TOP"
  fi
  if (( USER_SET_FETCH == 0 )); then
    FETCH="$QCTX_BOOTSTRAP_FETCH"
  fi
  if [[ "${LINES:-}" == "140" ]]; then
    LINES="$QCTX_BOOTSTRAP_LINES"
  fi
fi

LAST_TS=""
LAST_ISSUE=""
LAST_STATE=""
LAST_DONE=""
LAST_NEXT=""
LAST_BLOCKER=""
if [[ "$MODE" == "bootstrap" ]]; then
  IFS=$'\t' read -r LAST_TS _ LAST_ISSUE LAST_STATE LAST_DONE LAST_NEXT LAST_BLOCKER < <(load_latest_handoff "${BRANCH:-}")
  if [[ -z "$ISSUE_ID" && -n "$LAST_ISSUE" ]]; then
    ISSUE_ID="$LAST_ISSUE"
  fi
  if [[ -z "$QUERY" ]]; then
    QUERY_PARTS=()
    if [[ -n "$BRANCH" && "$BRANCH" != "HEAD" ]]; then
      QUERY_PARTS+=("$BRANCH")
    fi
    [[ -n "$ISSUE_ID" ]] && QUERY_PARTS+=("$ISSUE_ID")
    [[ -n "$LAST_NEXT" ]] && QUERY_PARTS+=("$(compact_words "$LAST_NEXT" 8)")
    [[ -n "$LAST_BLOCKER" ]] && QUERY_PARTS+=("$(compact_words "$LAST_BLOCKER" 6)")
    QUERY="$(printf '%s ' "${QUERY_PARTS[@]}" | tr -s ' ' | sed 's/[[:space:]]*$//')"
  fi
fi

if [[ -z "$QUERY" ]]; then
  if [[ -n "$BRANCH" && "$BRANCH" != "HEAD" ]]; then
    QUERY="$BRANCH"
  else
    usage
    exit 2
  fi
fi

if [[ "$MODE" == "bootstrap" ]]; then
  echo
  echo "Bootstrap context:"
  [[ -n "$BRANCH" ]] && echo "  branch:    $BRANCH"
  [[ -n "$ISSUE_ID" ]] && echo "  issue:     $ISSUE_ID"
  [[ -n "$LAST_TS" ]] && echo "  handoff:   $LAST_TS (${LAST_STATE:-unknown})"
  [[ -n "$LAST_DONE" ]] && echo "  last done: $LAST_DONE"
  [[ -n "$LAST_NEXT" ]] && echo "  next step: $LAST_NEXT"
  [[ -n "$LAST_BLOCKER" ]] && echo "  blocker:   $LAST_BLOCKER"
fi

echo
echo "Searching QMD context..."
echo "  query:      $QUERY"
echo "  collection: $COLLECTION"
echo "  mode:       $SEARCH_MODE"
echo

run_search_pipeline "$QUERY"
RESULTS="$PIPELINE_RESULTS"
FINAL_QUERY="$PIPELINE_FINAL_QUERY"
FINAL_MODE="$PIPELINE_FINAL_MODE"

if [[ "$QCTX_INCIDENT_FALLBACK" == "1" ]] && ! has_doc_hits "$RESULTS"; then
  INCIDENT_QUERY="$(extract_latest_incident_query "$(pwd)/.claude/progress/incident.json")"
  if [[ -n "$INCIDENT_QUERY" && "$INCIDENT_QUERY" != "$QUERY" ]]; then
    echo "No hits from primary query. Retrying with latest incident context..."
    echo "  incident query: $INCIDENT_QUERY"
    run_search_pipeline "$INCIDENT_QUERY"
    if has_doc_hits "$PIPELINE_RESULTS"; then
      RESULTS="$PIPELINE_RESULTS"
      FINAL_QUERY="$PIPELINE_FINAL_QUERY"
      FINAL_MODE="$PIPELINE_FINAL_MODE"
    else
      echo "Incident-context fallback returned no hits."
    fi
  fi
fi

echo "$RESULTS"

if [[ "$MODE" == "bootstrap" ]]; then
  echo
  if [[ -n "$LAST_NEXT" ]]; then
    echo "Next Action: $LAST_NEXT"
  else
    TOP_DOCID="$(printf '%s\n' "$RESULTS" | awk -F',' '/^#/{print $1; exit}')"
    if [[ -n "$TOP_DOCID" ]]; then
      echo "Next Action: Review $TOP_DOCID first, then continue current branch task."
    fi
  fi
fi

if (( FETCH <= 0 )); then
  exit 0
fi

mapfile -t DOC_IDS < <(printf '%s\n' "$RESULTS" | awk -F',' '/^#/{print $1}' | head -n "$FETCH")
if (( ${#DOC_IDS[@]} == 0 )); then
  exit 0
fi

echo
echo "Top context snippets (${FINAL_MODE}, query: ${FINAL_QUERY}):"
for docid in "${DOC_IDS[@]}"; do
  echo "--------------------------------------------------------------------------------"
  echo "$docid"
  "$QMD_BIN" get "$docid" -l "$LINES"
  echo
done
