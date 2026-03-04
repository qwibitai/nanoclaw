#!/bin/bash
# credentials.sh — Load and inject test credentials.
#
# Supports either:
#   CLAUDE_CODE_OAUTH_TOKEN  (Claude Pro/Max subscription)
#   ANTHROPIC_API_KEY        (pay-per-use API)
# At least one must be set.
#
# Channel tokens are optional — scenarios only use what they need.

CREDENTIALS_FILE="/etc/nanoclaw-test/credentials.env"

# ── Load credentials from host file ─────────────────────────────────────────
#
# Reads /etc/nanoclaw-test/credentials.env and exports all variables found.
# Only auth (ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN) is required.
# Channel tokens are validated but not required — missing tokens just mean
# scenarios using that channel will fail at E2E time.

load_credentials() {
  if [ ! -f "$CREDENTIALS_FILE" ]; then
    log_error "Credentials file not found: $CREDENTIALS_FILE"
    log_error "Create it with:"
    log_error "  sudo mkdir -p /etc/nanoclaw-test"
    log_error "  sudo tee /etc/nanoclaw-test/credentials.env <<'EOF'"
    log_error "  # Auth (at least one required):"
    log_error "  CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-...   # from: claude setup-token"
    log_error "  # ANTHROPIC_API_KEY=sk-ant-...             # pay-per-use API key"
    log_error ""
    log_error "  # Telegram"
    log_error "  TELEGRAM_BOT_TOKEN=123456:ABC..."
    log_error "  TELEGRAM_TEST_CHAT_ID=tg:123456789"
    log_error ""
    log_error "  # Slack"
    log_error "  SLACK_BOT_TOKEN=xoxb-..."
    log_error "  SLACK_APP_TOKEN=xapp-..."
    log_error "  SLACK_TEST_CHAT_ID=slack:C0123456789"
    log_error ""
    log_error "  # Discord"
    log_error "  DISCORD_BOT_TOKEN=..."
    log_error "  DISCORD_TEST_CHAT_ID=dc:123456789"
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

  # Export everything that was loaded
  export ANTHROPIC_API_KEY CLAUDE_CODE_OAUTH_TOKEN
  export TELEGRAM_BOT_TOKEN TELEGRAM_TEST_CHAT_ID
  export SLACK_BOT_TOKEN SLACK_APP_TOKEN SLACK_TEST_CHAT_ID
  export DISCORD_BOT_TOKEN DISCORD_TEST_CHAT_ID

  # Report which channel tokens are available
  local available=()
  [ -n "${TELEGRAM_BOT_TOKEN:-}" ] && available+=("telegram")
  [ -n "${SLACK_BOT_TOKEN:-}" ] && [ -n "${SLACK_APP_TOKEN:-}" ] && available+=("slack")
  [ -n "${DISCORD_BOT_TOKEN:-}" ] && available+=("discord")

  if [ -n "${CLAUDE_CODE_OAUTH_TOKEN:-}" ]; then
    log_ok "Credentials loaded (using Claude subscription token)"
  else
    log_ok "Credentials loaded (using Anthropic API key)"
  fi

  if [ ${#available[@]} -gt 0 ]; then
    log_info "Channel tokens available: ${available[*]}"
  else
    log_warn "No channel tokens found — E2E scenarios will fail"
  fi
}

# ── Write .env for a scenario ────────────────────────────────────────────────
#
# Writes the test user's .env file with auth token + tokens for the specified
# channels only. Called per-scenario so the .env reflects what's installed.
#
# Usage: write_scenario_env <ch1> [ch2...]

write_scenario_env() {
  local env_file="${CLONE_DIR}/.env"

  {
    # Auth token (prefer subscription)
    if [ -n "${CLAUDE_CODE_OAUTH_TOKEN:-}" ]; then
      echo "CLAUDE_CODE_OAUTH_TOKEN=${CLAUDE_CODE_OAUTH_TOKEN}"
    fi
    if [ -n "${ANTHROPIC_API_KEY:-}" ]; then
      echo "ANTHROPIC_API_KEY=${ANTHROPIC_API_KEY}"
    fi

    # Channel-specific tokens
    for channel in "$@"; do
      case "$channel" in
        telegram)
          if [ -n "${TELEGRAM_BOT_TOKEN:-}" ]; then
            echo "TELEGRAM_BOT_TOKEN=${TELEGRAM_BOT_TOKEN}"
          else
            log_error "TELEGRAM_BOT_TOKEN not set but telegram channel requested"
            return 1
          fi
          ;;
        slack)
          if [ -z "${SLACK_BOT_TOKEN:-}" ] || [ -z "${SLACK_APP_TOKEN:-}" ]; then
            log_error "SLACK_BOT_TOKEN and SLACK_APP_TOKEN must both be set for slack channel"
            return 1
          fi
          echo "SLACK_BOT_TOKEN=${SLACK_BOT_TOKEN}"
          echo "SLACK_APP_TOKEN=${SLACK_APP_TOKEN}"
          ;;
        discord)
          if [ -n "${DISCORD_BOT_TOKEN:-}" ]; then
            echo "DISCORD_BOT_TOKEN=${DISCORD_BOT_TOKEN}"
          else
            log_error "DISCORD_BOT_TOKEN not set but discord channel requested"
            return 1
          fi
          ;;
        *)
          log_warn "Unknown channel '${channel}' — skipping credentials"
          ;;
      esac
    done
  } > "$env_file"

  chown "$TEST_USER:$TEST_USER" "$env_file"
  chmod 600 "$env_file"
  log_ok "Wrote .env to $env_file (channels: $*)"
}
