#!/usr/bin/env bash
# Setup helper: install-node — bundles Node 22 install into one idempotent
# script so /new-setup can run it without needing `curl | sudo -E bash -` in
# the allowlist (that pattern is inherently unmatchable — bash reads from
# stdin, so pre-approval can't inspect what's being executed).
#
# The script itself is the allowlisted unit; the pipes and sudo live inside
# it. Pure bash by design — runs before Node exists on the host.
set -euo pipefail

echo "=== NANOCLAW SETUP: INSTALL_NODE ==="

if command -v node >/dev/null 2>&1; then
  echo "STATUS: already-installed"
  echo "NODE_VERSION: $(node --version)"
  echo "=== END ==="
  exit 0
fi

case "$(uname -s)" in
  Darwin)
    echo "STEP: brew-install-node"
    if ! command -v brew >/dev/null 2>&1; then
      echo "STATUS: failed"
      echo "ERROR: Homebrew not installed. Install brew first (https://brew.sh) then re-run."
      echo "=== END ==="
      exit 1
    fi
    brew install node@22
    ;;
  Linux)
    echo "STEP: nodesource-setup"
    curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
    echo "STEP: apt-install-nodejs"
    sudo apt-get install -y nodejs
    ;;
  *)
    echo "STATUS: failed"
    echo "ERROR: Unsupported platform: $(uname -s)"
    echo "=== END ==="
    exit 1
    ;;
esac

if ! command -v node >/dev/null 2>&1; then
  echo "STATUS: failed"
  echo "ERROR: node not found on PATH after install"
  echo "=== END ==="
  exit 1
fi

echo "STATUS: installed"
echo "NODE_VERSION: $(node --version)"
echo "=== END ==="
