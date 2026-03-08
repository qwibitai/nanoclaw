#!/usr/bin/env bash
# start-with-vault.sh — Load secrets from Vaultwarden, then start NanoClaw
set -euo pipefail

VAULT_DIR="/root/.vault"
VAULT_PASS=$(cat "$VAULT_DIR/service-password" 2>/dev/null)
VAULT_EMAIL=$(cat "$VAULT_DIR/service-email" 2>/dev/null)

if [[ -n "$VAULT_PASS" ]]; then
    # Get BW session
    STATUS=$(bw status 2>/dev/null | python3 -c "import sys,json; print(json.load(sys.stdin).get('status','unauthenticated'))" 2>/dev/null || echo "unauthenticated")

    if [[ "$STATUS" == "locked" ]]; then
        export BW_SESSION=$(bw unlock "$VAULT_PASS" --raw 2>/dev/null)
    elif [[ "$STATUS" == "unauthenticated" ]]; then
        export BW_SESSION=$(bw login "$VAULT_EMAIL" "$VAULT_PASS" --raw 2>/dev/null)
    fi

    if [[ -n "${BW_SESSION:-}" ]]; then
        # Load vault secrets into environment
        eval "$(python3 /root/.vault/vault-env.py --export 2>/dev/null)"

        # Map vault keys to NanoClaw env vars
        export DISCORD_BOT_TOKEN="${DISCORD_TOKEN:-}"
        export CLAUDE_CODE_OAUTH_TOKEN="${CLAUDE_CODE_OAUTH_TOKEN_NANOCLAW:-}"

        echo "Vault secrets loaded into environment"
    else
        echo "WARNING: Vault unlock failed, falling back to .env" >&2
    fi
fi


# Load .env if it exists (for DISCORD_ONLY, etc.)
if [[ -f /root/nanoclaw/.env ]]; then
    set -a
    source /root/nanoclaw/.env
    set +a
fi

# Start NanoClaw
exec /usr/bin/node /root/nanoclaw/dist/index.js
