#!/usr/bin/env bash
# agent-auth-init.sh
# Sourced at agent container startup to fetch credentials from Solo Vault
# and authenticate with Pay, exporting tokens for downstream use.
# Warns but does not fail if Solo Vault is unreachable.

_VAULT_BASE="http://host.docker.internal:3015/v1/secrets/agent-services/production"

_warn() {
  echo "[agent-auth-init] WARNING: $*" >&2
}

_fetch_secret() {
  local key="$1"
  local response
  response=$(curl -sf \
    -H "Authorization: Bearer ${SOLO_VAULT_BOOTSTRAP_KEY}" \
    "${_VAULT_BASE}/${key}" 2>/dev/null) || {
    _warn "Failed to fetch secret '${key}' from Solo Vault (unreachable or auth error)"
    return 1
  }
  # Support {"success":true,"data":{"value":"..."}}, {"value":"..."}, and raw string responses
  echo "$response" | jq -re '.data.value // .value // .' 2>/dev/null || echo "$response"
}

if [[ -z "${SOLO_VAULT_BOOTSTRAP_KEY:-}" ]]; then
  _warn "SOLO_VAULT_BOOTSTRAP_KEY is not set — skipping auth init"
  unset -f _fetch_secret _warn
  unset _VAULT_BASE
  return 0 2>/dev/null || exit 0
fi

echo "[agent-auth-init] Bootstrapping credentials from Solo Vault..." >&2

# Fetch Pay credentials
_pay_email=$(_fetch_secret "PAY_AUTH_EMAIL") || {
  _warn "Skipping Pay auth — could not fetch PAY_AUTH_EMAIL"
  unset -f _fetch_secret _warn; unset _VAULT_BASE _pay_email
  return 0 2>/dev/null || exit 0
}

_pay_password=$(_fetch_secret "PAY_AUTH_PASSWORD") || {
  _warn "Skipping Pay auth — could not fetch PAY_AUTH_PASSWORD"
  unset -f _fetch_secret _warn; unset _VAULT_BASE _pay_email _pay_password
  return 0 2>/dev/null || exit 0
}

# Authenticate with Pay
_pay_resp=$(curl -sf -X POST "http://host.docker.internal:3017/api/v1/auth/login" \
  -H "Content-Type: application/json" \
  -d "{\"email\":$(printf '%s' "$_pay_email" | jq -Rs .),\"passwordPlainText\":$(printf '%s' "$_pay_password" | jq -Rs .)}" \
  2>/dev/null) || { _warn "Pay login request failed — AGENT_PAY_TOKEN not set"; _pay_resp=""; }

if [[ -n "$_pay_resp" ]]; then
  _token=$(echo "$_pay_resp" | jq -re '.data.accessToken // .accessToken // .access_token // .token // empty' 2>/dev/null)
  if [[ -n "$_token" ]]; then
    export AGENT_PAY_TOKEN="$_token"
    echo "[agent-auth-init] AGENT_PAY_TOKEN acquired" >&2
  else
    _warn "Pay login succeeded but response contained no access_token"
    export AGENT_PAY_TOKEN=""
  fi
else
  export AGENT_PAY_TOKEN=""
fi

# Fetch AI Proxy key
_ai_key=$(_fetch_secret "AI_PROXY_API_KEY") && {
  export AGENT_AI_PROXY_KEY="$_ai_key"
  echo "[agent-auth-init] AGENT_AI_PROXY_KEY acquired" >&2
} || {
  _warn "Could not fetch AI_PROXY_API_KEY — AGENT_AI_PROXY_KEY not set"
  export AGENT_AI_PROXY_KEY=""
}

# Cleanup internal symbols
unset -f _fetch_secret _warn
unset _VAULT_BASE _pay_email _pay_password _pay_resp _token _ai_key
