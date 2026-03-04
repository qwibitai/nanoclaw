#!/bin/bash
# credentials.sh — Load and inject test credentials.
#
# Supports either:
#   CLAUDE_CODE_OAUTH_TOKEN  (Claude Pro/Max subscription)
#   ANTHROPIC_API_KEY        (pay-per-use API)
# At least one must be set.

CREDENTIALS_FILE="/etc/nanoclaw-test/credentials.env"

# ── Load credentials from host file ─────────────────────────────────────────
#
# Reads /etc/nanoclaw-test/credentials.env and exports the variables.
# Required: (ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN), TELEGRAM_BOT_TOKEN,
#           TELEGRAM_TEST_CHAT_ID

load_credentials() {
  if [ ! -f "$CREDENTIALS_FILE" ]; then
    log_error "Credentials file not found: $CREDENTIALS_FILE"
    log_error "Create it with:"
    log_error "  sudo mkdir -p /etc/nanoclaw-test"
    log_error "  sudo tee /etc/nanoclaw-test/credentials.env <<'EOF'"
    log_error "  # Use ONE of these (subscription OR API key):"
    log_error "  CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-...   # from: claude setup-token"
    log_error "  # ANTHROPIC_API_KEY=sk-ant-...             # pay-per-use API key"
    log_error "  TELEGRAM_BOT_TOKEN=123456:ABC..."
    log_error "  TELEGRAM_TEST_CHAT_ID=tg:123456789"
    log_error "  EOF"
    log_error "  sudo chmod 600 /etc/nanoclaw-test/credentials.env"
    return 1
  fi

  # shellcheck source=/dev/null
  source "$CREDENTIALS_FILE"

  # Need at least one auth token
  if [ -z "${ANTHROPIC_API_KEY:-}" ] && [ -z "${CLAUDE_CODE_OAUTH_TOKEN:-}" ]; then
    log_error "Missing auth: set CLAUDE_CODE_OAUTH_TOKEN (subscription) or ANTHROPIC_API_KEY (API) in $CREDENTIALS_FILE"
    return 1
  fi

  local missing=()
  [ -z "${TELEGRAM_BOT_TOKEN:-}" ]     && missing+=("TELEGRAM_BOT_TOKEN")
  [ -z "${TELEGRAM_TEST_CHAT_ID:-}" ]  && missing+=("TELEGRAM_TEST_CHAT_ID")

  if [ ${#missing[@]} -gt 0 ]; then
    log_error "Missing required credentials: ${missing[*]}"
    return 1
  fi

  export ANTHROPIC_API_KEY CLAUDE_CODE_OAUTH_TOKEN TELEGRAM_BOT_TOKEN TELEGRAM_TEST_CHAT_ID

  if [ -n "${CLAUDE_CODE_OAUTH_TOKEN:-}" ]; then
    log_ok "Credentials loaded (using Claude subscription token)"
  else
    log_ok "Credentials loaded (using Anthropic API key)"
  fi
}

# ── Write .env for test user ────────────────────────────────────────────────
#
# Writes the test user's .env file with the auth token and bot token.
# Requires TEST_HOME and CLONE_DIR to be set.

write_test_env() {
  local env_file="${CLONE_DIR}/.env"

  {
    # Write whichever auth token is available (prefer subscription)
    if [ -n "${CLAUDE_CODE_OAUTH_TOKEN:-}" ]; then
      echo "CLAUDE_CODE_OAUTH_TOKEN=${CLAUDE_CODE_OAUTH_TOKEN}"
    fi
    if [ -n "${ANTHROPIC_API_KEY:-}" ]; then
      echo "ANTHROPIC_API_KEY=${ANTHROPIC_API_KEY}"
    fi
    echo "TELEGRAM_BOT_TOKEN=${TELEGRAM_BOT_TOKEN}"
  } > "$env_file"

  chown "$TEST_USER:$TEST_USER" "$env_file"
  chmod 600 "$env_file"
  log_ok "Wrote .env to $env_file"
}
