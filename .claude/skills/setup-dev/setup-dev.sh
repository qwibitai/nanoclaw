#!/usr/bin/env bash
set -euo pipefail

repo_root="$(git rev-parse --show-toplevel)"
src="$repo_root/dev-agents"
dst="$repo_root/.claude"

for category_dir in "$src"/*/; do
  category=$(basename "$category_dir")
  mkdir -p "$dst/$category"
  for item_dir in "$category_dir"*/; do
    [ -e "$item_dir" ] || continue
    item=$(basename "$item_dir")
    cp -r "$item_dir" "$dst/$category/$item"
    echo "Installed: $category/$item"
  done
done
