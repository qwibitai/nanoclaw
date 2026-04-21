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
    # WSL2 without systemd: get.docker.com installs fine but dockerd
    # can't start (no init to supervise it). Bail early with both
    # recommended paths so the user picks whichever fits, instead of
    # installing ~400MB and failing at daemon-start 60s later.
    if grep -qiE 'microsoft|wsl' /proc/version 2>/dev/null \
       && [ ! -d /run/systemd/system ]; then
      echo "STEP: detect-wsl-no-systemd"
      cat <<'MSG'

WSL detected without systemd. Docker can't run natively here yet.

Recommended: install Docker Desktop on Windows
  1) Download and install: https://www.docker.com/products/docker-desktop/
  2) Launch Docker Desktop, accept the EULA.
  3) Settings -> Resources -> WSL Integration -> enable for this distro.
  4) Re-run ./nanoclaw.sh here.

Alternative: enable systemd inside this WSL distro
  1) sudo sh -c 'printf "\n[boot]\nsystemd=true\n" >> /etc/wsl.conf'
  2) In Windows PowerShell: wsl --shutdown
  3) Reopen this terminal and re-run ./nanoclaw.sh.

MSG
      echo "STATUS: failed"
      echo "ERROR: wsl_no_systemd"
      echo "=== END ==="
      exit 1
    fi
    echo "STEP: docker-get-script"
    curl -fsSL https://get.docker.com | sh
    echo "STEP: usermod-docker-group"
    sudo usermod -aG docker "$USER"
    echo "NOTE: you may need to log out and back in for docker group membership to take effect"
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
