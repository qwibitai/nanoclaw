#!/usr/bin/env bash
# gh-collab-sweep.sh
# Session-start GitHub collaboration sweep for Claude and Codex.
# Usage: bash scripts/workflow/gh-collab-sweep.sh --agent claude|codex
# Outputs: terse summary of what needs attention. Exit 0 always.

set -euo pipefail

AGENT=""
OWNER="ingpoc"
REPO="nanoclaw"
PROJECT_NUMBER=1
STALE_HOURS=24

while [[ $# -gt 0 ]]; do
  case $1 in
    --agent) AGENT="$2"; shift 2 ;;
    --owner) OWNER="$2"; shift 2 ;;
    --repo) REPO="$2"; shift 2 ;;
    *) echo "Unknown arg: $1"; exit 1 ;;
  esac
done

if [[ -z "$AGENT" ]]; then
  echo "Usage: $0 --agent claude|codex"
  exit 1
fi

if [[ "$AGENT" != "claude" && "$AGENT" != "codex" ]]; then
  echo "Error: --agent must be 'claude' or 'codex'"
  exit 1
fi

OTHER_AGENT="codex"
[[ "$AGENT" == "codex" ]] && OTHER_AGENT="claude"

echo ""
echo "=== GitHub Collaboration Sweep (${AGENT}) ==="
echo "repo: ${OWNER}/${REPO}  |  $(date -u '+%Y-%m-%d %H:%M UTC')"
echo ""

# ── 1. My Issues (Agent=me, not Done) ────────────────────────────────────────
echo "── MY ISSUES ──"
MY_ISSUES=$(gh project item-list "$PROJECT_NUMBER" --owner "$OWNER" --format json 2>/dev/null \
  | jq -r --arg agent "$AGENT" '
    .items[]
    | select(.agent == $agent and .status != "Done")
    | "  #\(.content.number // "?")  [\(.status // "?")]  \(.title // .content.title // "?")"
  ' 2>/dev/null || true)

if [[ -z "$MY_ISSUES" ]]; then
  echo "  (none)"
else
  echo "$MY_ISSUES"
fi
echo ""

# ── 2. Needs my review (Review Lane=me, status=Review) ───────────────────────
echo "── NEEDS MY REVIEW ──"
REVIEW_ITEMS=$(gh project item-list "$PROJECT_NUMBER" --owner "$OWNER" --format json 2>/dev/null \
  | jq -r --arg agent "$AGENT" '
    .items[]
    | select(.["review Lane"] == $agent and .status == "Review")
    | "  #\(.content.number // "?")  \(.title // .content.title // "?")"
  ' 2>/dev/null || true)

if [[ -z "$REVIEW_ITEMS" ]]; then
  echo "  (none)"
else
  echo "$REVIEW_ITEMS"
fi
echo ""

# ── 3. Stale discussions (0 comments, in my affinity categories, >STALE_HOURS) ─
echo "── STALE DISCUSSIONS (needs response) ──"

# Agent affinity: Claude owns process/coordination; Codex owns feature/tooling/sync
if [[ "$AGENT" == "claude" ]]; then
  AFFINITY_SLUGS=("workflow-operating-model" "claude-codex-collaboration")
else
  AFFINITY_SLUGS=("feature-ideas" "sdk-tooling-opportunities" "upstream-nanoclaw-sync")
fi

STALE_CUTOFF=$(date -u -v-"${STALE_HOURS}"H '+%Y-%m-%dT%H:%M:%SZ' 2>/dev/null \
  || date -u --date="${STALE_HOURS} hours ago" '+%Y-%m-%dT%H:%M:%SZ' 2>/dev/null \
  || echo "")

DISCUSSIONS=$(gh api graphql -f query='
query($owner: String!, $repo: String!) {
  repository(owner: $owner, name: $repo) {
    discussions(first: 30, orderBy: {field: UPDATED_AT, direction: DESC}) {
      nodes {
        number
        title
        createdAt
        updatedAt
        category { slug }
        comments { totalCount }
      }
    }
  }
}' -f owner="$OWNER" -f repo="$REPO" --jq '.data.repository.discussions.nodes' 2>/dev/null || echo "[]")

FOUND_STALE=0
for slug in "${AFFINITY_SLUGS[@]}"; do
  STALE=$(echo "$DISCUSSIONS" | jq -r --arg slug "$slug" --arg cutoff "${STALE_CUTOFF:-1970-01-01T00:00:00Z}" '
    .[]
    | select(.category.slug == $slug and .comments.totalCount == 0 and .createdAt < now and .createdAt <= $cutoff)
    | "  #\(.number)  \(.title)  (0 comments, category: \(.category.slug))"
  ' 2>/dev/null || true)
  if [[ -n "$STALE" ]]; then
    echo "$STALE"
    FOUND_STALE=1
  fi
done

# Also show any 0-comment discussions in affinity categories regardless of age
ALL_ZERO=$(echo "$DISCUSSIONS" | jq -r --argjson slugs "$(printf '%s\n' "${AFFINITY_SLUGS[@]}" | jq -R . | jq -s .)" '
  .[]
  | select((.category.slug as $s | $slugs | index($s) != null) and .comments.totalCount == 0)
  | "  #\(.number)  \(.title)  (0 comments)"
' 2>/dev/null || true)

if [[ -n "$ALL_ZERO" ]]; then
  echo "$ALL_ZERO"
  FOUND_STALE=1
fi

[[ "$FOUND_STALE" -eq 0 ]] && echo "  (none)"
echo ""

# ── 4. Handoff comments from other agent ─────────────────────────────────────
echo "── HANDOFFS FROM ${OTHER_AGENT^^} ──"
# Look for recent Issue comments containing the handoff marker
HANDOFFS=$(gh api "repos/${OWNER}/${REPO}/issues/comments?per_page=30&sort=created&direction=desc" \
  --jq --arg other "$OTHER_AGENT" '
    .[]
    | select(.body | test("agent-handoff") and test($other; "i"))
    | "  Issue #\(.issue_url | split("/") | last)  \(.body | split("\n") | map(select(test("^(To:|Next:|Status:)"))) | join(" | "))"
  ' 2>/dev/null || true)

if [[ -z "$HANDOFFS" ]]; then
  echo "  (none)"
else
  echo "$HANDOFFS"
fi
echo ""

# ── 5. Blocked items (any agent) ─────────────────────────────────────────────
echo "── BLOCKED ITEMS ──"
BLOCKED=$(gh project item-list "$PROJECT_NUMBER" --owner "$OWNER" --format json 2>/dev/null \
  | jq -r '
    .items[]
    | select(.status == "Blocked")
    | "  #\(.content.number // "?")  [\(.agent // "?")]  \(.title // .content.title // "?")"
  ' 2>/dev/null || true)

if [[ -z "$BLOCKED" ]]; then
  echo "  (none)"
else
  echo "$BLOCKED"
fi
echo ""

echo "=== End Sweep ==="
echo ""
echo "Handoff format (use when leaving work for ${OTHER_AGENT}):"
echo "  <!-- agent-handoff -->"
echo "  From: ${AGENT}"
echo "  To: ${OTHER_AGENT}"
echo "  Status: [completed|blocked|needs-review|needs-input]"
echo "  Next: <specific next action>"
echo "  Context: <brief context>"
echo ""
