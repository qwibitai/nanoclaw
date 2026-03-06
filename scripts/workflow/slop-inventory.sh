#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"

mode="summary"

usage() {
  cat <<'USAGE'
Usage: scripts/workflow/slop-inventory.sh [options]

Deterministic slop inventory for docs/scripts reference hygiene.

Options:
  --list-unreferenced-docs      Print only unreferenced docs
  --list-unreferenced-scripts   Print only unreferenced scripts
  --summary                     Print counts and both lists (default)
  -h, --help                    Show help
USAGE
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --list-unreferenced-docs)
      mode="docs"
      shift
      ;;
    --list-unreferenced-scripts)
      mode="scripts"
      shift
      ;;
    --summary)
      mode="summary"
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown option: $1"
      usage
      exit 1
      ;;
  esac
done

docs_all="$(mktemp /tmp/slop-docs-all.XXXXXX)"
docs_refs="$(mktemp /tmp/slop-docs-refs.XXXXXX)"
docs_unreferenced="$(mktemp /tmp/slop-docs-unref.XXXXXX)"
scripts_all="$(mktemp /tmp/slop-scripts-all.XXXXXX)"
scripts_refs="$(mktemp /tmp/slop-scripts-refs.XXXXXX)"
scripts_unreferenced="$(mktemp /tmp/slop-scripts-unref.XXXXXX)"
trap 'rm -f "$docs_all" "$docs_refs" "$docs_unreferenced" "$scripts_all" "$scripts_refs" "$scripts_unreferenced"' EXIT

collect_unreferenced_docs() {
  find docs -type f -name '*.md' | sort >"$docs_all"
  : >"$docs_refs"
  for f in CLAUDE.md AGENTS.md DOCS.md docs/README.md $(find docs .claude/rules -type f -name '*.md' | sort); do
    rg -o --no-filename 'docs/[A-Za-z0-9._/-]+\.md' "$f" >>"$docs_refs" || true
  done
  sort -u "$docs_refs" -o "$docs_refs"
  comm -23 "$docs_all" "$docs_refs" >"$docs_unreferenced"
}

collect_unreferenced_scripts() {
  find scripts -type f \( -name '*.sh' -o -name '*.ts' \) | sort >"$scripts_all"
  : >"$scripts_refs"

  for f in CLAUDE.md AGENTS.md DOCS.md package.json $(find docs .claude/rules .github/workflows scripts -type f \( -name '*.md' -o -name '*.yml' -o -name '*.yaml' -o -name '*.sh' -o -name '*.ts' \) | sort); do
    rg -o --no-filename 'scripts/[A-Za-z0-9._/-]+\.(sh|ts)' "$f" >>"$scripts_refs" || true
    rg -o --no-filename '\./scripts/[A-Za-z0-9._/-]+\.(sh|ts)' "$f" | sed 's#^\./##' >>"$scripts_refs" || true
  done

  # Include scripts routed via local SCRIPT_DIR dispatch (e.g. jarvis-ops command fanout).
  rg -o --no-filename '\$SCRIPT_DIR/[A-Za-z0-9._/-]+\.(sh|ts)' scripts -g '*.sh' \
    | sed 's#^\$SCRIPT_DIR/#scripts/#' >>"$scripts_refs" || true

  sort -u "$scripts_refs" -o "$scripts_refs"
  comm -23 "$scripts_all" "$scripts_refs" >"$scripts_unreferenced"
}

collect_unreferenced_docs
collect_unreferenced_scripts

case "$mode" in
  docs)
    cat "$docs_unreferenced"
    ;;
  scripts)
    cat "$scripts_unreferenced"
    ;;
  summary)
    docs_count="$(wc -l <"$docs_unreferenced" | tr -d ' ')"
    scripts_count="$(wc -l <"$scripts_unreferenced" | tr -d ' ')"
    echo "unreferenced_docs=${docs_count}"
    cat "$docs_unreferenced"
    echo "unreferenced_scripts=${scripts_count}"
    cat "$scripts_unreferenced"
    ;;
esac
