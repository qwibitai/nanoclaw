#!/bin/bash
# Scrub stale infrastructure-failure loops from known memory files.
# Intended as a manual repair tool, not a broad post-container hook.
#
# These loops can self-sustain when an agent reads an old journal entry about
# a transient infrastructure failure and treats it as current state.
#
# Narrow signatures kept in sync with src/phantom-filter.ts.

set -u

if [ $# -lt 1 ]; then
  echo "Usage: $0 <target_file_or_dir> [more...]" >&2
  exit 2
fi

is_allowed_file() {
  local f="$1"
  case "$f" in
    */journal/*.md|*/MEMORY.md|*/STANDING_FACTS.md|*/OPEN_TASKS.md)
      return 0
      ;;
  esac
  return 1
}

scrub_file() {
  local f="$1"
  [ ! -f "$f" ] && return
  if ! is_allowed_file "$f"; then
    echo "[scrub-phantoms] skipping unsupported target: $f" >&2
    return
  fi
  local before after
  before=$(wc -l < "$f")
  # Keep this intentionally narrow: only known infrastructure/write-failure
  # loops, not ordinary discussion of migrations, backups, or risk.
  perl -i -ne 'print unless /(?i)feed\s+health\s+check.*(workspace\s+unmounted|all\s+rss\s+feeds\s+inaccessible|awaiting\s+remount)|workspace\s+unmounted.*day\s+\d+|all\s+rss\s+feeds\s+inaccessible|awaiting\s+remount|memory\s+maintenance\s+alert.*(awaiting\s+(workspace\s+)?(mount|restore)|pending\s+writ(e|ten)[-\s]?back|queue\s+submission)|no\s+response\s+needed.*(awaiting\s+(workspace\s+)?(mount|restore)|pending\s+writ(e|ten)[-\s]?back|queue\s+submission)/' "$f"
  after=$(wc -l < "$f")
  local removed=$((before - after))
  if [ "$removed" -gt 0 ]; then
    echo "[scrub-phantoms] $f: removed $removed line(s)"
  fi
}

scrub_dir() {
  local d="$1"
  [ ! -d "$d" ] && return
  while IFS= read -r f; do
    scrub_file "$f"
  done < <(find "$d" -type f \( -path "*/journal/*.md" -o -name "MEMORY.md" -o -name "STANDING_FACTS.md" -o -name "OPEN_TASKS.md" \))
}

for target in "$@"; do
  if [ -d "$target" ]; then
    scrub_dir "$target"
  elif [ -f "$target" ]; then
    scrub_file "$target"
  fi
done
