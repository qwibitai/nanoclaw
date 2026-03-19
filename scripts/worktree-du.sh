#!/usr/bin/env bash
# worktree-du.sh — Disk usage analysis and cleanup for NanoClaw worktrees, branches, and Docker images
#
# Usage:
#   ./scripts/worktree-du.sh [analyze|cleanup] [--fast] [--dry-run]
#
# Modes:
#   analyze  (default)  Show full disk usage report
#   cleanup             Remove stale worktrees, merged branches, dangling Docker images
#
# Flags:
#   --fast              Skip slow checks (PR status, Docker, disk usage)
#   --dry-run           Show what cleanup would do without doing it

set -euo pipefail

# Resolve project root — works from any worktree or main checkout
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(git -C "$SCRIPT_DIR" rev-parse --git-common-dir 2>/dev/null | sed 's|/\.git$||')"
if [ -z "$PROJECT_ROOT" ] || [ ! -d "$PROJECT_ROOT" ]; then
  PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
fi

WORKTREES_DIR="$PROJECT_ROOT/.claude/worktrees"
DB_PATH="$PROJECT_ROOT/store/messages.db"

# Colors (disabled if not a terminal)
if [ -t 1 ]; then
  RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[0;33m'
  BOLD='\033[1m'; DIM='\033[2m'; NC='\033[0m'
else
  RED=''; GREEN=''; YELLOW=''; BOLD=''; DIM=''; NC=''
fi

# Parse args
MODE="analyze"
FAST=false
DRY_RUN=false

for arg in "$@"; do
  case "$arg" in
    analyze)   MODE="analyze" ;;
    cleanup)   MODE="cleanup" ;;
    --fast)    FAST=true ;;
    --dry-run) DRY_RUN=true ;;
    --help|-h)
      sed -n '2,/^$/{ s/^# //; s/^#//; p; }' "$0"
      exit 0
      ;;
    *) echo "Unknown arg: $arg" >&2; exit 1 ;;
  esac
done

# Helpers
query_db() {
  node -e "
    const db = require('better-sqlite3')('$DB_PATH');
    const rows = db.prepare(\`$1\`).all();
    console.log(JSON.stringify(rows));
  " 2>/dev/null || echo "[]"
}

human_size() {
  numfmt --to=iec --suffix=B "$1" 2>/dev/null || echo "${1}B"
}

# Lock file checks — mirrors cases.ts with PID liveness awareness.
# A lock with a LIVE PID always blocks removal.
# A lock with a DEAD PID is stale — safe to clean up.
# Claude sessions can be suspended for hours and resumed, so heartbeat
# staleness alone is NOT enough — we must check if the PID is still alive.
STALE_THRESHOLD_SECONDS=1800  # 30 minutes, same as cases.ts

has_lock_file() {
  [ -f "$1/.worktree-lock.json" ]
}

# Read the PID from a lock file. Returns empty string if no PID or no file.
get_lock_pid() {
  local lock_file="$1/.worktree-lock.json"
  [ -f "$lock_file" ] || return
  node -e "
    try {
      const lock = JSON.parse(require('fs').readFileSync('$lock_file', 'utf8'));
      console.log(lock.pid || '');
    } catch { console.log(''); }
  " 2>/dev/null
}

# Check if the PID in a lock file is still running.
# Returns 0 (true) if PID is alive, 1 (false) if dead or no PID recorded.
is_lock_pid_alive() {
  local pid
  pid=$(get_lock_pid "$1")
  [ -n "$pid" ] || return 1
  kill -0 "$pid" 2>/dev/null
}

is_lock_active() {
  local lock_file="$1/.worktree-lock.json"
  [ -f "$lock_file" ] || return 1
  local heartbeat
  heartbeat=$(node -e "
    try {
      const lock = JSON.parse(require('fs').readFileSync('$lock_file', 'utf8'));
      console.log(lock.heartbeat || lock.started_at || '');
    } catch { console.log(''); }
  " 2>/dev/null)
  [ -n "$heartbeat" ] || return 1
  local hb_epoch now_epoch
  hb_epoch=$(date -d "$heartbeat" +%s 2>/dev/null || echo "0")
  now_epoch=$(date +%s)
  [ $(( now_epoch - hb_epoch )) -lt "$STALE_THRESHOLD_SECONDS" ]
}

get_lock_age() {
  local lock_file="$1/.worktree-lock.json"
  [ -f "$lock_file" ] || return
  node -e "
    try {
      const lock = JSON.parse(require('fs').readFileSync('$lock_file', 'utf8'));
      const hb = new Date(lock.heartbeat || lock.started_at);
      const mins = Math.round((Date.now() - hb.getTime()) / 60000);
      if (mins < 60) console.log(mins + 'min');
      else if (mins < 1440) console.log(Math.round(mins/60) + 'hr');
      else console.log(Math.round(mins/1440) + 'd');
    } catch { console.log('?'); }
  " 2>/dev/null
}

# Classify a lock: "active" (live PID + fresh heartbeat), "orphaned" (dead PID),
# "stale" (live PID but old heartbeat — suspended session), or "none".
classify_lock() {
  has_lock_file "$1" || { echo "none"; return; }
  if is_lock_pid_alive "$1"; then
    if is_lock_active "$1"; then
      echo "active"
    else
      echo "stale"  # PID alive but heartbeat old — suspended session, DO NOT remove
    fi
  else
    echo "orphaned"  # PID dead — safe to clean up
  fi
}

# Precompute merged branches (once)
MERGED_BRANCHES=""
get_merged_branches() {
  if [ -z "$MERGED_BRANCHES" ]; then
    MERGED_BRANCHES=$(git -C "$PROJECT_ROOT" branch --merged main 2>/dev/null | sed 's/^[* +]*//' || echo "")
  fi
  echo "$MERGED_BRANCHES"
}

is_branch_merged() {
  get_merged_branches | grep -Fxq "$1" 2>/dev/null
}

# Distinguish "truly merged" (diverged then merged back) from "at-main" (never diverged)
# Returns: "merged", "squash-merged", "at-main", or "unmerged"
branch_merge_status() {
  local branch="$1"

  # Fast path: git branch --merged recognizes regular merges
  if is_branch_merged "$branch"; then
    local ahead
    ahead=$(git -C "$PROJECT_ROOT" rev-list --count "main..$branch" 2>/dev/null || echo "0")
    if [ "$ahead" -eq 0 ]; then
      echo "at-main"
    else
      echo "merged"
    fi
    return
  fi

  # Squash-merge detection: branch is not in --merged but its changes may
  # already be in main via squash-merge (different SHA, same content).
  # Use two-dot diff (direct tree comparison) — if main already contains all
  # the branch's changes via squash-merge, the trees will be identical.
  local diff_stat
  diff_stat=$(git -C "$PROJECT_ROOT" diff --stat "main..$branch" 2>/dev/null || echo "has-diff")
  if [ -z "$diff_stat" ]; then
    echo "squash-merged"
    return
  fi

  echo "unmerged"
}

# Analyze worktrees
analyze_worktrees() {
  echo -e "${BOLD}Worktrees${NC}"
  echo ""

  local total_size=0 count=0 active_locks=0 stale_locks=0 merged=0 dirty_count=0

  printf "  ${DIM}%-42s %7s  %-18s %-14s %-20s %s${NC}\n" \
    "NAME" "SIZE" "BRANCH" "LOCK" "STATE" "CASE"

  for wt in "$WORKTREES_DIR"/*/; do
    [ -d "$wt" ] || continue
    local name
    name=$(basename "$wt")
    count=$((count + 1))

    # Size
    local size_str="-"
    if ! $FAST; then
      local size_bytes
      size_bytes=$(du -sb "$wt" 2>/dev/null | cut -f1 || echo "0")
      size_str=$(human_size "$size_bytes")
      total_size=$((total_size + size_bytes))
    fi

    # Branch
    local branch
    branch=$(git -C "$wt" rev-parse --abbrev-ref HEAD 2>/dev/null || echo "?")
    local branch_short
    branch_short=$(echo "$branch" | sed 's|^case/||;s|^worktree-||;s|^wt/||;s|^feat/||;s|^fix/||;s|^docs/||' | cut -c1-18)

    # Lock status (with PID liveness)
    local lock_str lock_class
    lock_class=$(classify_lock "$wt")
    case "$lock_class" in
      active)   lock_str="${RED}ACTIVE${NC}"; active_locks=$((active_locks + 1)) ;;
      stale)    lock_str="${YELLOW}stale($(get_lock_age "$wt"))${NC}"; stale_locks=$((stale_locks + 1)) ;;
      orphaned) lock_str="${YELLOW}orphan($(get_lock_age "$wt"))${NC}"; stale_locks=$((stale_locks + 1)) ;;
      *)        lock_str="${DIM}none${NC}" ;;
    esac

    # Git state
    local state_parts=""
    local merge_status
    merge_status=$(branch_merge_status "$branch")
    case "$merge_status" in
      merged)        state_parts="${GREEN}merged${NC}"; merged=$((merged + 1)) ;;
      squash-merged) state_parts="${GREEN}squash-merged${NC}"; merged=$((merged + 1)) ;;
      at-main)       state_parts="${DIM}at-main${NC}" ;;
      *)             state_parts="unmerged" ;;
    esac

    local dirty_files
    dirty_files=$(git -C "$wt" status --porcelain 2>/dev/null | grep -cv '.worktree-lock.json' || true)
    dirty_files=$(( dirty_files + 0 ))  # normalize to integer
    if [ "$dirty_files" -gt 0 ]; then
      state_parts="${state_parts} ${YELLOW}dirty($dirty_files)${NC}"
      dirty_count=$((dirty_count + 1))
    fi

    local unpushed
    unpushed=$(git -C "$wt" log --oneline '@{u}..HEAD' 2>/dev/null | wc -l || true)
    unpushed=$(( unpushed + 0 ))
    if [ "$unpushed" -gt 0 ]; then
      state_parts="${state_parts} ${YELLOW}unpush($unpushed)${NC}"
    fi

    # Case info (via domain model CLI, not raw SQL)
    local case_str="${DIM}none${NC}"
    local case_json
    case_json=$(node "$PROJECT_ROOT/dist/cli-kaizen.js" case-by-branch "$branch" 2>/dev/null)
    if [ -n "$case_json" ] && [ "$case_json" != "null" ]; then
      local case_row
      case_row=$(echo "$case_json" | node -e "const c=JSON.parse(require('fs').readFileSync('/dev/stdin','utf8')); console.log(c.status + (c.github_issue ? ' #'+c.github_issue : ''))" 2>/dev/null)
      [ -n "$case_row" ] && case_str="$case_row"
    fi

    printf "  %-42s %7s  %-18s %-22b %-28b %s\n" \
      "$name" "$size_str" "$branch_short" "$lock_str" "$state_parts" "$case_str"
  done

  echo ""
  echo -e "  ${BOLD}Total:${NC} $count worktrees"
  $FAST || echo -e "  ${BOLD}Disk:${NC} $(human_size $total_size)"
  echo -e "  Locks: ${RED}$active_locks active${NC}, ${YELLOW}$stale_locks stale/orphaned${NC}  |  Merged: ${GREEN}$merged${NC}  Dirty: ${YELLOW}$dirty_count${NC}"
}

# Analyze branches
analyze_branches() {
  echo ""
  echo -e "${BOLD}Branches${NC}"
  echo ""

  local merged_count unmerged_count local_only=0
  merged_count=$(git -C "$PROJECT_ROOT" branch --merged main 2>/dev/null | grep -cv '^\*\|main$' || echo "0")
  unmerged_count=$(git -C "$PROJECT_ROOT" branch --no-merged main 2>/dev/null | wc -l || echo "0")
  local total=$((merged_count + unmerged_count + 1))

  echo "  Total: $total  |  Unmerged: $unmerged_count  |  Merged (deletable): ${GREEN}$merged_count${NC}"

  # Local-only branches (no remote tracking)
  while IFS= read -r branch; do
    branch=$(echo "$branch" | sed 's/^[* +]*//')
    [ "$branch" = "main" ] && continue
    [ -z "$branch" ] && continue
    if ! git -C "$PROJECT_ROOT" config "branch.$branch.remote" >/dev/null 2>&1; then
      local_only=$((local_only + 1))
    fi
  done < <(git -C "$PROJECT_ROOT" branch 2>/dev/null)
  echo "  Local-only (never pushed): ${YELLOW}$local_only${NC}"
}

# Analyze cases
analyze_cases() {
  echo ""
  echo -e "${BOLD}Cases${NC}"
  echo ""

  # Counts by status (via domain model CLI)
  local all_cases
  all_cases=$(node "$PROJECT_ROOT/dist/cli-kaizen.js" case-list 2>/dev/null)
  if [ -n "$all_cases" ] && [ "$all_cases" != "[]" ]; then
    echo "$all_cases" | node -e "
      const cases = JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));
      const counts = {};
      cases.forEach(c => { counts[c.status] = (counts[c.status] || 0) + 1; });
      const order = ['active','blocked','backlog','suggested','done','reviewed','pruned'];
      order.forEach(s => { if (counts[s]) console.log('  ' + s + ': ' + counts[s]); });
    " 2>/dev/null
  else
    echo "  (no cases)"
  fi

  # Stale active cases (active/blocked but branch merged or worktree gone)
  echo ""
  echo -e "  ${BOLD}Stale active cases${NC} (active/blocked but branch merged or worktree gone):"
  local active_cases
  active_cases=$(node "$PROJECT_ROOT/dist/cli-kaizen.js" case-list --status active,blocked 2>/dev/null)
  if [ -n "$active_cases" ] && [ "$active_cases" != "[]" ]; then
    echo "$active_cases" | node -e "
      const fs = require('fs');
      const { execSync } = require('child_process');
      const merged = new Set(
        execSync('git -C $PROJECT_ROOT branch --merged main', { encoding: 'utf8' })
          .split('\n').map(b => b.replace(/^[* +]*/, '').trim()).filter(Boolean)
      );
      const cases = JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));
      let found = false;
      for (const c of cases) {
        const reasons = [];
        if (c.worktree_path && !fs.existsSync(c.worktree_path)) reasons.push('worktree gone');
        if (c.branch_name && merged.has(c.branch_name)) reasons.push('branch merged');
        if (reasons.length > 0) {
          const issue = c.github_issue ? ' (#' + c.github_issue + ')' : '';
          console.log('    ' + c.name + issue + ' — ' + reasons.join(', '));
          found = true;
        }
      }
      if (!found) console.log('    (none)');
    " 2>/dev/null || echo "    (could not check)"
  else
    echo "    (none)"
  fi
}

# Analyze open PRs
analyze_prs() {
  $FAST && return
  echo ""
  echo -e "${BOLD}Open PRs${NC}"
  echo ""

  local prs
  prs=$(gh pr list --repo Garsson-io/nanoclaw --state open --json number,title,headBranch \
    --jq '.[] | "  #\(.number)  \(.headBranch)  \(.title)"' 2>/dev/null || echo "")
  if [ -z "$prs" ]; then
    echo "  (none)"
  else
    echo "$prs"
  fi
}

# Analyze Docker
analyze_docker() {
  $FAST && return
  echo ""
  echo -e "${BOLD}Docker${NC}"
  echo ""

  local docker_cmd="docker"
  command -v docker.exe >/dev/null 2>&1 && docker_cmd="docker.exe"

  $docker_cmd system df 2>&1 | sed 's/^/  /' || echo "  (Docker not available)"

  # Dangling image count
  local dangling
  dangling=$($docker_cmd images --filter "dangling=true" -q 2>/dev/null | wc -l || echo "0")
  [ "$dangling" -gt 0 ] && echo -e "  Dangling images: ${YELLOW}$dangling${NC}"

  # VHDX (WSL)
  local vhdx_path
  for candidate in \
    "/mnt/c/Users/$(cmd.exe /C 'echo %USERNAME%' 2>/dev/null | tr -d '\r')/AppData/Local/Docker/wsl/disk/docker_data.vhdx" \
    "/mnt/c/Users/$(whoami)/AppData/Local/Docker/wsl/disk/docker_data.vhdx"; do
    if [ -f "$candidate" ]; then
      vhdx_path="$candidate"
      break
    fi
  done
  if [ -n "${vhdx_path:-}" ]; then
    local vhdx_size
    vhdx_size=$(ls -lh "$vhdx_path" 2>/dev/null | awk '{print $5}')
    echo ""
    echo -e "  VHDX on host disk: ${BOLD}$vhdx_size${NC}"
    echo -e "  ${DIM}(VHDX doesn't auto-shrink — 'wsl --shutdown' + compact to reclaim)${NC}"
  fi
}

# Disk usage summary
analyze_disk() {
  $FAST && return
  echo ""
  echo -e "${BOLD}Disk${NC}"
  echo ""

  local wt_size proj_size store_size
  wt_size=$(du -sh "$WORKTREES_DIR" 2>/dev/null | cut -f1 || echo "?")
  proj_size=$(du -sh "$PROJECT_ROOT" --exclude=".claude/worktrees" 2>/dev/null | cut -f1 || echo "?")
  store_size=$(du -sh "$PROJECT_ROOT/store" 2>/dev/null | cut -f1 || echo "?")

  echo "  Worktrees:        $wt_size"
  echo "  Project (ex-wt):  $proj_size"
  echo "  Store (DB+data):  $store_size"
}

# Cleanup
do_cleanup() {
  local label="REMOVE"
  $DRY_RUN && label="would remove"

  echo -e "${BOLD}Cleanup${NC}$($DRY_RUN && echo " ${YELLOW}(DRY RUN)${NC}")"
  echo ""

  local removed_wt=0 removed_br=0 skipped=0

  # Phase 1: Worktrees
  echo -e "  ${BOLD}Phase 1: Stale worktrees${NC}"
  echo -e "  ${DIM}Removes: merged/squash-merged/at-main + clean + unlocked (or orphaned lock)${NC}"
  echo ""

  for wt in "$WORKTREES_DIR"/*/; do
    [ -d "$wt" ] || continue
    local name branch
    name=$(basename "$wt")
    branch=$(git -C "$wt" rev-parse --abbrev-ref HEAD 2>/dev/null || echo "?")

    # Lock safety gate — PID-aware
    local lock_class
    lock_class=$(classify_lock "$wt")
    case "$lock_class" in
      active|stale)
        # Active PID or suspended session — never touch
        local age
        age=$(get_lock_age "$wt")
        echo -e "    ${YELLOW}SKIP${NC} $name — lock ($lock_class, heartbeat: $age)"
        skipped=$((skipped + 1))
        continue
        ;;
      orphaned)
        # Dead PID — remove the stale lock file so we can proceed
        local age
        age=$(get_lock_age "$wt")
        echo -e "    ${DIM}Removing orphaned lock${NC} $name (PID dead, heartbeat: $age)"
        if ! $DRY_RUN; then
          rm -f "$wt/.worktree-lock.json"
        fi
        ;;
      # "none" — no lock, proceed normally
    esac

    # Branch must be merged, squash-merged, or at-main (stillborn)
    local merge_status
    merge_status=$(branch_merge_status "$branch")
    case "$merge_status" in
      merged|squash-merged|at-main) ;;  # eligible for cleanup
      *)
        continue  # unmerged — skip silently
        ;;
    esac

    # Must be clean
    local dirty
    dirty=$(git -C "$wt" status --porcelain 2>/dev/null | grep -cv '.worktree-lock.json' || true)
    dirty=$(( dirty + 0 ))
    if [ "$dirty" -gt 0 ]; then
      echo -e "    ${YELLOW}SKIP${NC} $name — dirty files ($dirty)"
      skipped=$((skipped + 1))
      continue
    fi

    # Must have no unpushed commits (skip for at-main — they have 0 commits)
    if [ "$merge_status" != "at-main" ]; then
      local unpushed
      unpushed=$(git -C "$wt" log --oneline '@{u}..HEAD' 2>/dev/null | head -1)
      if [ -n "$unpushed" ]; then
        echo -e "    ${YELLOW}SKIP${NC} $name — unpushed commits"
        skipped=$((skipped + 1))
        continue
      fi
    fi

    if $DRY_RUN; then
      echo -e "    ${GREEN}$label${NC}: $name (branch: $branch, $merge_status)"
    else
      if git -C "$PROJECT_ROOT" worktree remove "$wt" --force 2>/dev/null; then
        echo -e "    ${GREEN}REMOVED${NC} $name ($merge_status)"
      else
        echo -e "    ${RED}FAILED${NC} $name"
      fi
    fi
    removed_wt=$((removed_wt + 1))
  done

  # Phase 2: Merged/squash-merged branches with no worktree
  echo ""
  echo -e "  ${BOLD}Phase 2: Merged branches (no worktree)${NC}"
  echo ""

  while IFS= read -r branch; do
    branch=$(echo "$branch" | sed 's/^[* +]*//')
    [ "$branch" = "main" ] && continue
    [ -z "$branch" ] && continue

    # Skip if any worktree uses this branch
    git -C "$PROJECT_ROOT" worktree list 2>/dev/null | grep -qF "[$branch]" && continue

    local ms
    ms=$(branch_merge_status "$branch")
    case "$ms" in
      merged|at-main)
        # Regular merged branch — safe delete with -d
        if $DRY_RUN; then
          echo -e "    ${GREEN}$label${NC}: $branch ($ms)"
        else
          if git -C "$PROJECT_ROOT" branch -d "$branch" 2>/dev/null; then
            echo -e "    ${GREEN}REMOVED${NC} $branch ($ms)"
          fi
        fi
        removed_br=$((removed_br + 1))
        ;;
      squash-merged)
        # Squash-merged: -d won't work (git doesn't see it as merged), use -D
        if $DRY_RUN; then
          echo -e "    ${GREEN}$label${NC}: $branch ($ms)"
        else
          if git -C "$PROJECT_ROOT" branch -D "$branch" 2>/dev/null; then
            echo -e "    ${GREEN}REMOVED${NC} $branch ($ms)"
          fi
        fi
        removed_br=$((removed_br + 1))
        ;;
    esac
  done < <(git -C "$PROJECT_ROOT" branch 2>/dev/null)

  # Phase 3: Docker
  echo ""
  echo -e "  ${BOLD}Phase 3: Docker images & cache${NC}"
  echo ""

  local docker_cmd="docker"
  command -v docker.exe >/dev/null 2>&1 && docker_cmd="docker.exe"

  if $DRY_RUN; then
    local dangling
    dangling=$($docker_cmd images --filter "dangling=true" -q 2>/dev/null | wc -l || echo "0")
    echo "    $label: $dangling dangling images"
    echo "    $label: unreferenced build cache"
  else
    echo "    Pruning dangling images..."
    $docker_cmd image prune -f 2>/dev/null | tail -1 | sed 's/^/    /' || echo "    (skipped)"
    echo "    Pruning unreferenced build cache (preserving active layers)..."
    $docker_cmd builder prune -f 2>/dev/null | tail -1 | sed 's/^/    /' || echo "    (skipped)"
  fi

  # Phase 4: Git housekeeping
  echo ""
  echo -e "  ${BOLD}Phase 4: Git worktree prune${NC}"
  echo ""

  if $DRY_RUN; then
    git -C "$PROJECT_ROOT" worktree prune --dry-run -v 2>&1 | sed 's/^/    /' || true
  else
    git -C "$PROJECT_ROOT" worktree prune -v 2>&1 | sed 's/^/    /' || true
  fi

  # Phase 5: Stale active cases
  if ! $FAST; then
    echo ""
    echo -e "  ${BOLD}Phase 5: Stale active cases → done${NC}"
    echo ""

    # Use domain model CLI for both reads and writes (triggers GitHub sync, reflection hooks)
    local active_cases
    active_cases=$(node "$PROJECT_ROOT/dist/cli-kaizen.js" case-list --status active,blocked 2>/dev/null)
    if [ -n "$active_cases" ] && [ "$active_cases" != "[]" ]; then
      local stale_names
      stale_names=$(echo "$active_cases" | node -e "
        const { execSync } = require('child_process');
        const merged = new Set(
          execSync('git -C $PROJECT_ROOT branch --merged main', { encoding: 'utf8' })
            .split('\n').map(b => b.replace(/^[* +]*/, '').trim()).filter(Boolean)
        );
        const cases = JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));
        cases.filter(c => c.branch_name && merged.has(c.branch_name))
          .forEach(c => console.log(c.name));
      " 2>/dev/null)

      if [ -z "$stale_names" ]; then
        echo "    (none)"
      else
        echo "$stale_names" | while IFS= read -r case_name; do
          [ -z "$case_name" ] && continue
          if $DRY_RUN; then
            echo "    would mark done: $case_name"
          else
            node "$PROJECT_ROOT/dist/cli-kaizen.js" case-update-status "$case_name" done 2>/dev/null
            echo "    marked done: $case_name"
          fi
        done
      fi
    else
      echo "    (none)"
    fi
  fi

  # Summary
  echo ""
  echo -e "  ${BOLD}Summary:${NC} $removed_wt worktrees, $removed_br branches cleaned. $skipped skipped (protected)."
  $DRY_RUN && echo -e "  ${YELLOW}Dry run — run without --dry-run to apply.${NC}"
}

# Main
echo ""
echo -e "${BOLD}NanoClaw Worktree DU${NC}$($FAST && echo " (fast)")"
echo -e "${DIM}$PROJECT_ROOT${NC}"
echo ""

case "$MODE" in
  analyze) analyze_worktrees; analyze_branches; analyze_cases; analyze_prs; analyze_docker; analyze_disk ;;
  cleanup) do_cleanup ;;
esac

echo ""
