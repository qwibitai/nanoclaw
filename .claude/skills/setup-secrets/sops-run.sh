#!/bin/bash
# sops-run.sh — decrypt secrets and run a command with them as env vars
#
# Usage: sops-run.sh <secrets.yaml> <command...>
#
# Example:
#   ~/sops-run.sh ~/paycheck/secrets.yaml docker compose up -d
#   ~/sops-run.sh ~/caddy/secrets.yaml docker compose restart
#
# Secrets are decrypted in memory only — never written to disk as plaintext.
# Requires: ~/.age/key.txt (your age private key) and sops in PATH or ~/.local/bin/sops

set -e

SECRETS_FILE="$1"
shift

if [ -z "$SECRETS_FILE" ] || [ ! -f "$SECRETS_FILE" ]; then
  echo "Usage: sops-run.sh <secrets.yaml> <command...>" >&2
  exit 1
fi

export SOPS_AGE_KEY_FILE="$HOME/.age/key.txt"

# $* not $@ — sops exec-env passes the command to sh -c, which requires a single string
exec "${HOME}/.local/bin/sops" exec-env "$SECRETS_FILE" "$*"
