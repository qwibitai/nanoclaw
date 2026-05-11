#!/usr/bin/env bash
# Setup helper: install-docker — bundles Docker install into one idempotent
# script so /new-setup can run it without needing `curl | sh` in the allowlist
# (pipelines split at matching time, and `sh` receiving stdin can't be
# pre-approved safely).
#
# The script itself is the allowlisted unit; the pipes and sudo live inside
# it. Starting the daemon (after install) stays separate — `open -a Docker`
# and `sudo systemctl start docker` are already in the allowlist.
set -euo pipefail

echo "=== NANOCLAW SETUP: INSTALL_DOCKER ==="

if command -v docker >/dev/null 2>&1; then
  echo "STATUS: already-installed"
  echo "DOCKER_VERSION: $(docker --version 2>/dev/null || echo unknown)"
  echo "=== END ==="
  exit 0
fi

case "$(uname -s)" in
  Darwin)
    echo "STEP: brew-install-docker"
    if ! command -v brew >/dev/null 2>&1; then
      echo "STATUS: failed"
      echo "ERROR: Homebrew not installed. Install brew first (https://brew.sh) then re-run."
      echo "=== END ==="
      exit 1
    fi
    brew install --cask docker
    ;;
  Linux)
    if command -v dnf >/dev/null 2>&1; then
      echo "STEP: dnf-install-podman"
      sudo dnf install -y podman podman-docker docker-compose
      # podman-compose lacks --wait; remove it if pulled in as a weak dep
      sudo dnf remove -y podman-compose 2>/dev/null || true
      echo "STEP: enable-podman-socket"
      systemctl --user enable --now podman.socket
      echo "NOTE: using podman with docker compatibility shim and docker-compose v2"
    elif command -v yum >/dev/null 2>&1; then
      echo "STEP: yum-install-podman"
      sudo yum install -y podman podman-docker docker-compose
      sudo yum remove -y podman-compose 2>/dev/null || true
      echo "STEP: enable-podman-socket"
      systemctl --user enable --now podman.socket
      echo "NOTE: using podman with docker compatibility shim and docker-compose v2"
    else
      echo "STEP: docker-get-script"
      curl -fsSL https://get.docker.com | sh
      echo "STEP: usermod-docker-group"
      sudo usermod -aG docker "$USER"
      echo "NOTE: you may need to log out and back in for docker group membership to take effect"
    fi
    ;;
  *)
    echo "STATUS: failed"
    echo "ERROR: Unsupported platform: $(uname -s)"
    echo "=== END ==="
    exit 1
    ;;
esac

if ! command -v docker >/dev/null 2>&1; then
  echo "STATUS: failed"
  echo "ERROR: docker not found on PATH after install"
  echo "=== END ==="
  exit 1
fi

echo "STATUS: installed"
echo "DOCKER_VERSION: $(docker --version 2>/dev/null || echo unknown)"
echo "=== END ==="
