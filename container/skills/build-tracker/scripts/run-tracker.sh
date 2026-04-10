#!/usr/bin/env bash
# build-tracker: run-tracker.sh
# Zero-LLM GitHub project tracker. Outputs structured status to stdout.
# Usage: run-tracker.sh <repo> [--stale-pr-hours N] [--stale-issue-hours N] [--phases-file path]
# Exit codes: 0=ok/silent, 1=actionable findings

set -euo pipefail

REPO="${1:-}"
STALE_PR_H="${STALE_PR_HOURS:-4}"
STALE_ISSUE_H="${STALE_ISSUE_HOURS:-8}"
PHASES_FILE="${PHASES_FILE:-}"
ACTIONABLE=0
NOW_EPOCH=$(date +%s)

if [[ -z "$REPO" ]]; then
  echo "Usage: run-tracker.sh <owner/repo> [options]" >&2
  exit 2
fi

# ── Helpers ─────────────────────────────────────────────────────────────────

hours_since() {
  local ts="$1"
  local ts_epoch
  ts_epoch=$(date -j -f "%Y-%m-%dT%H:%M:%SZ" "$ts" +%s 2>/dev/null || date -d "$ts" +%s 2>/dev/null || echo 0)
  echo $(( (NOW_EPOCH - ts_epoch) / 3600 ))
}

# ── Open PRs ─────────────────────────────────────────────────────────────────

PR_JSON=$(gh pr list --repo "$REPO" --state open --json number,title,author,createdAt,updatedAt,reviewDecision,reviews,headRefName 2>/dev/null || echo "[]")
PR_COUNT=$(echo "$PR_JSON" | python3 -c "import json,sys; d=json.load(sys.stdin); print(len(d))")

STALE_PRS=""
if [[ "$PR_COUNT" -gt 0 ]]; then
  STALE_PRS=$(echo "$PR_JSON" | python3 -c "
import json, sys, subprocess, time
from datetime import datetime, timezone

data = json.load(sys.stdin)
now = time.time()
stale_h = int('$STALE_PR_H')
out = []

for pr in data:
    updated = pr.get('updatedAt','')
    if updated:
        try:
            ts = datetime.fromisoformat(updated.replace('Z','+00:00')).timestamp()
            age_h = int((now - ts) / 3600)
        except:
            age_h = 0
    else:
        age_h = 0

    review_decision = pr.get('reviewDecision') or 'NONE'
    if age_h >= stale_h:
        out.append(f\"PR #{pr['number']}: {pr['title'][:60]} ({age_h}h stale, review={review_decision})\")

for line in out:
    print(line)
" 2>/dev/null)
fi

# ── Open Issues ───────────────────────────────────────────────────────────────

ISSUE_JSON=$(gh issue list --repo "$REPO" --state open --json number,title,assignees,createdAt,updatedAt,labels 2>/dev/null || echo "[]")
ISSUE_COUNT=$(echo "$ISSUE_JSON" | python3 -c "import json,sys; d=json.load(sys.stdin); print(len(d))")

STALE_ISSUES=""
if [[ "$ISSUE_COUNT" -gt 0 ]]; then
  STALE_ISSUES=$(echo "$ISSUE_JSON" | python3 -c "
import json, sys, time

data = json.load(sys.stdin)
now = time.time()
stale_h = int('$STALE_ISSUE_H')
out = []

for issue in data:
    assignees = [a.get('login','') for a in issue.get('assignees',[])]
    if not assignees:
        continue  # unassigned issues don't count as stale-on-assignee

    labels = [l.get('name','') for l in issue.get('labels',[])]
    skip_labels = {'parked','blocked','needs-approval','later','in-review'}
    if any(l in skip_labels for l in labels):
        continue

    updated = issue.get('updatedAt','')
    if updated:
        try:
            from datetime import datetime
            ts = datetime.fromisoformat(updated.replace('Z','+00:00')).timestamp()
            age_h = int((now - ts) / 3600)
        except:
            age_h = 0
    else:
        age_h = 0

    if age_h >= stale_h:
        assignee_str = ', '.join(assignees)
        out.append(f\"Issue #{issue['number']}: {issue['title'][:60]} ({age_h}h no update, assigned: {assignee_str})\")

for line in out:
    print(line)
" 2>/dev/null)
fi

# ── Phase tracking (optional) ─────────────────────────────────────────────────

PHASE_STATUS=""
if [[ -n "$PHASES_FILE" && -f "$PHASES_FILE" ]]; then
  PHASE_STATUS=$(python3 -c "
import json, sys, subprocess

with open('$PHASES_FILE') as f:
    phases = json.load(f)

out = []
for phase in phases:
    name = phase.get('name','?')
    issue_refs = phase.get('issues', [])
    repo = '$REPO'
    statuses = []
    for ref in issue_refs:
        try:
            result = subprocess.run(
                ['gh','issue','view', str(ref), '--repo', repo, '--json','state,title'],
                capture_output=True, text=True, timeout=10
            )
            if result.returncode == 0:
                d = json.loads(result.stdout)
                statuses.append(d.get('state','?').upper())
            else:
                statuses.append('UNKNOWN')
        except:
            statuses.append('UNKNOWN')

    all_closed = all(s == 'CLOSED' for s in statuses)
    any_open = any(s == 'OPEN' for s in statuses)
    if all_closed:
        out.append(f'  ✅ {name}: all done')
    elif any_open:
        open_count = sum(1 for s in statuses if s == 'OPEN')
        out.append(f'  🔄 {name}: {open_count}/{len(statuses)} open')
    else:
        out.append(f'  ❓ {name}: status unknown')

for line in out:
    print(line)
" 2>/dev/null)
fi

# ── Build output ──────────────────────────────────────────────────────────────

TIMESTAMP=$(date -u +"%Y-%m-%d %H:%M UTC")
FINDINGS=()

[[ -n "$STALE_PRS" ]] && FINDINGS+=("STALE_PRS") && ACTIONABLE=1
[[ -n "$STALE_ISSUES" ]] && FINDINGS+=("STALE_ISSUES") && ACTIONABLE=1

if [[ $ACTIONABLE -eq 0 ]]; then
  echo "TRACKER_OK"
  echo "repo=$REPO prs=$PR_COUNT issues=$ISSUE_COUNT ts=$TIMESTAMP"
  [[ -n "$PHASE_STATUS" ]] && echo "$PHASE_STATUS"
  exit 0
fi

# Actionable output
echo "TRACKER_ALERT"
echo "repo=$REPO ts=$TIMESTAMP"
echo "open_prs=$PR_COUNT open_issues=$ISSUE_COUNT"
echo ""

if [[ -n "$STALE_PRS" ]]; then
  echo "## Stale PRs (>${STALE_PR_H}h without review activity)"
  echo "$STALE_PRS"
  echo ""
fi

if [[ -n "$STALE_ISSUES" ]]; then
  echo "## Stale assigned issues (>${STALE_ISSUE_H}h without update)"
  echo "$STALE_ISSUES"
  echo ""
fi

if [[ -n "$PHASE_STATUS" ]]; then
  echo "## Phase progress"
  echo "$PHASE_STATUS"
  echo ""
fi

exit 1
