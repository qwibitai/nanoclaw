#!/bin/bash
# Shared library for Docker image lifecycle scripts.
# Source this file — do not execute directly.

IMAGE_NAME="nanoclaw-agent"
CONTAINER_RUNTIME="${CONTAINER_RUNTIME:-docker}"

# Sanitize a git branch name for use as a Docker tag.
# Rules: replace / with -, strip anything not [a-zA-Z0-9._-], truncate to 128 chars.
sanitize_branch() {
  local branch="$1"
  echo "$branch" | sed 's|/|-|g' | sed 's/[^a-zA-Z0-9._-]//g' | cut -c1-128
}

# Detect current git branch. Falls back to "detached" if HEAD is detached.
detect_branch() {
  local branch
  branch=$(git rev-parse --abbrev-ref HEAD 2>/dev/null)
  if [ "$branch" = "HEAD" ] || [ -z "$branch" ]; then
    echo "detached"
  else
    echo "$branch"
  fi
}

# Check if a Docker image exists locally.
image_exists() {
  local tag="$1"
  "${CONTAINER_RUNTIME}" image inspect "${IMAGE_NAME}:${tag}" >/dev/null 2>&1
}

# List all nanoclaw-agent tags matching a pattern (or all if no pattern).
list_image_tags() {
  local filter="${1:-}"
  "${CONTAINER_RUNTIME}" images "${IMAGE_NAME}" --format '{{.Tag}}' | \
    if [ -n "$filter" ]; then grep -E -- "$filter"; else cat; fi | \
    sort
}

# Get image size in human-readable form.
image_size() {
  local tag="$1"
  "${CONTAINER_RUNTIME}" images "${IMAGE_NAME}:${tag}" --format '{{.Size}}' 2>/dev/null
}

# Get image creation time.
image_created() {
  local tag="$1"
  "${CONTAINER_RUNTIME}" images "${IMAGE_NAME}:${tag}" --format '{{.CreatedSince}}' 2>/dev/null
}

# Get the project root (where store/messages.db lives).
# Walks up from SCRIPT_DIR looking for package.json.
find_project_root() {
  local dir="${1:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)}"
  while [ "$dir" != "/" ]; do
    if [ -f "$dir/package.json" ] && [ -d "$dir/store" ]; then
      echo "$dir"
      return 0
    fi
    dir=$(dirname "$dir")
  done
  # Fallback: one level up from container/
  echo "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
}

# Resolve cli-kaizen (kaizen #209: single-line executable pattern)
_resolve_image_lib_cli() {
  local project_root
  project_root=$(find_project_root)
  "$project_root/scripts/lib/resolve-cli-kaizen.sh" "$project_root" 2>/dev/null || return 1
}

# Query active case branches via domain model CLI (not raw SQL).
# Returns one branch name per line.
active_case_branches() {
  local cli_kaizen
  cli_kaizen=$(_resolve_image_lib_cli) || return 0
  $cli_kaizen case-list --status suggested,backlog,active,blocked 2>/dev/null | \
    node -e "
      const cases = JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));
      cases.filter(c => c.branch_name).forEach(c => console.log(c.branch_name));
    " 2>/dev/null
}

# Get count of active cases (for soft cap calculation).
active_case_count() {
  local cli_kaizen
  cli_kaizen=$(_resolve_image_lib_cli) || { echo "0"; return 0; }
  $cli_kaizen case-list --status suggested,backlog,active,blocked 2>/dev/null | \
    node -e "
      const cases = JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));
      console.log(cases.length);
    " 2>/dev/null || echo "0"
}

# List active worktree branches.
active_worktree_branches() {
  git worktree list --porcelain 2>/dev/null | grep '^branch ' | sed 's|^branch refs/heads/||'
}

# Check if a branch is active (has worktree or active case).
is_branch_active() {
  local branch="$1"
  # Check worktrees
  if active_worktree_branches | grep -qF "$branch"; then
    return 0
  fi
  # Check cases
  if active_case_branches | grep -qF "$branch"; then
    return 0
  fi
  return 1
}

# Calculate soft cap: (active_cases + 1 stable) * 2 slots each.
calculate_soft_cap() {
  local cases
  cases=$(active_case_count)
  echo $(( (cases + 1) * 2 ))
}

# Count current tagged nanoclaw-agent images (excluding <none>).
count_tagged_images() {
  local count
  count=$("${CONTAINER_RUNTIME}" images "${IMAGE_NAME}" --format '{{.Tag}}' 2>/dev/null | grep -cv '<none>' || true)
  echo "${count:-0}"
}

# Count dangling images.
count_dangling_images() {
  "${CONTAINER_RUNTIME}" images --filter "dangling=true" --format '{{.ID}}' 2>/dev/null | wc -l | tr -d ' '
}
