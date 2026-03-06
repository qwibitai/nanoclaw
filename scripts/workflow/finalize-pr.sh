#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"

skip_verify=0
verify_args=()

usage() {
  cat <<'USAGE'
Usage: scripts/workflow/finalize-pr.sh [options] [-- verify-args]

Final workflow gate before commit/push/PR.

Options:
  --skip-verify   Skip workflow verify wrapper
  -h, --help      Show help

Remaining args are forwarded to scripts/workflow/verify.sh.
USAGE
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --skip-verify)
      skip_verify=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    --)
      shift
      while [ "$#" -gt 0 ]; do
        verify_args+=("$1")
        shift
      done
      ;;
    *)
      verify_args+=("$1")
      shift
      ;;
  esac
done

bash scripts/check-workflow-contracts.sh
bash scripts/check-claude-codex-mirror.sh
bash scripts/check-tooling-governance.sh

if [ "$skip_verify" -eq 0 ]; then
  bash scripts/workflow/verify.sh "${verify_args[@]}"
fi

echo "== Finalization Status =="
git status --short

echo
echo "finalize-pr: PASS"
