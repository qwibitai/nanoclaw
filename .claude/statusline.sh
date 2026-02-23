#!/usr/bin/env bash
# NanoClaw status line for Claude Code
# Receives JSON via stdin, outputs a single status line

input=$(cat)

# Extract fields from JSON
model=$(echo "$input" | jq -r '.model.display_name // empty')
used_pct=$(echo "$input" | jq -r '.context_window.used_percentage // empty')
work_dir=$(echo "$input" | jq -r '.workspace.current_dir // .cwd // empty')

# Shorten model name: keep only the part after last space if it contains "Claude"
if [[ -n "$model" ]]; then
  model=$(echo "$model" | sed 's/Claude //')
fi

# Get current git branch (skip optional locks to avoid interference)
git_branch=""
if [[ -n "$work_dir" && -d "$work_dir" ]]; then
  git_branch=$(git -C "$work_dir" --no-optional-locks symbolic-ref --short HEAD 2>/dev/null)
fi

# Build status line parts
parts=()
parts+=("🐙 nano")

[[ -n "$model" ]] && parts+=("$model")

if [[ -n "$used_pct" ]]; then
  # Round to integer
  used_int=$(printf "%.0f" "$used_pct" 2>/dev/null || echo "$used_pct")
  parts+=("ctx: ${used_int}%")
fi

[[ -n "$git_branch" ]] && parts+=("$git_branch")

# Obtener uso de sesión de Claude (cacheado 5 min)
usage_info=$(python3 "$(dirname "$0")/claude-usage.py" 2>/dev/null)
[[ -n "$usage_info" ]] && parts+=("$usage_info")

# Join parts with " | "
output=""
for part in "${parts[@]}"; do
  if [[ -z "$output" ]]; then
    output="$part"
  else
    output="$output | $part"
  fi
done

printf "%s" "${output#nanoclaw | }"
