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
    if command -v brew >/dev/null 2>&1; then
      echo "STEP: brew-install-node"
      brew install node@22
    elif command -v port >/dev/null 2>&1; then
      echo "STEP: port-install-node"
      sudo port install nodejs22 npm10
    else
      echo "STATUS: failed"
      echo "ERROR: No macOS package manager found. Install Homebrew (https://brew.sh) or MacPorts (https://macports.org) and re-run."
      echo "=== END ==="
      exit 1
    fi
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
