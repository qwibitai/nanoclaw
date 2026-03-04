#!/bin/bash
# phases.sh — All pipeline phase functions.
#
# Each phase function:
#   - Logs what it's doing
#   - Runs the actual commands
#   - Returns 0 on success, non-zero on failure
#
# Globals used: TEST_USER, TEST_HOME, CLONE_DIR, GIT_REF, REPO_URL

# ── Phase 1: Create test user ──────────────────────────────────────────────

phase_user_create() {
  log_info "Creating user: ${TEST_USER}"

  # Remove existing user if leftover from a failed run
  if id "$TEST_USER" &>/dev/null; then
    log_warn "User ${TEST_USER} already exists — removing first"
    phase_teardown 2>/dev/null || true
  fi

  useradd -m -s /bin/bash -G docker "$TEST_USER"

  # Enable linger so systemd --user works for non-login sessions
  loginctl enable-linger "$TEST_USER"

  TEST_HOME=$(eval echo "~${TEST_USER}")
  CLONE_DIR="${TEST_HOME}/nanoclaw"

  log_ok "User ${TEST_USER} created (home: ${TEST_HOME})"
}

# ── Phase 2: Clone repo ────────────────────────────────────────────────────

phase_clone() {
  log_info "Cloning ${REPO_URL} (ref: ${GIT_REF}) into ${CLONE_DIR}"

  run_as_user "git clone --branch ${GIT_REF} --single-branch ${REPO_URL} ${CLONE_DIR}"

  if [ ! -d "$CLONE_DIR" ]; then
    log_error "Clone directory not found after git clone"
    return 1
  fi

  log_ok "Repository cloned to ${CLONE_DIR}"
}

# ── Phase 3: Bootstrap (setup.sh) ──────────────────────────────────────────

phase_bootstrap() {
  log_info "Running setup.sh bootstrap"

  local output
  output=$(run_as_user "cd ${CLONE_DIR} && bash setup.sh" 2>&1)
  local exit_code=$?

  # Parse structured status block
  local status
  status=$(parse_status_field "$output" "STATUS")
  local node_ok
  node_ok=$(parse_status_field "$output" "NODE_OK")
  local deps_ok
  deps_ok=$(parse_status_field "$output" "DEPS_OK")
  local native_ok
  native_ok=$(parse_status_field "$output" "NATIVE_OK")

  log_info "Bootstrap results: STATUS=${status} NODE_OK=${node_ok} DEPS_OK=${deps_ok} NATIVE_OK=${native_ok}"

  if [ "$exit_code" -ne 0 ] || [ "$status" != "success" ]; then
    log_error "Bootstrap failed (exit=${exit_code}, status=${status})"
    echo "$output" | tail -20
    return 1
  fi

  log_ok "Bootstrap complete"
}

# ── Phase 4: Build + tests ─────────────────────────────────────────────────

phase_build() {
  log_info "Building TypeScript and running tests"

  run_as_user "cd ${CLONE_DIR} && npm run build"
  if [ $? -ne 0 ]; then
    log_error "TypeScript build failed"
    return 1
  fi
  log_ok "TypeScript build succeeded"

  run_as_user "cd ${CLONE_DIR} && npx vitest run"
  if [ $? -ne 0 ]; then
    log_error "Tests failed"
    return 1
  fi
  log_ok "Tests passed"
}

# ── Phase 5: Environment check ─────────────────────────────────────────────

phase_environment() {
  log_info "Running environment check"

  local output
  output=$(run_as_user "cd ${CLONE_DIR} && npx tsx setup/index.ts --step environment" 2>&1)
  local exit_code=$?

  local status
  status=$(parse_status_field "$output" "STATUS")
  local docker
  docker=$(parse_status_field "$output" "DOCKER")
  local platform
  platform=$(parse_status_field "$output" "PLATFORM")

  log_info "Environment: PLATFORM=${platform} DOCKER=${docker} STATUS=${status}"

  if [ "$exit_code" -ne 0 ] || [ "$status" != "success" ]; then
    log_error "Environment check failed"
    return 1
  fi

  if [ "$docker" != "running" ]; then
    log_error "Docker is not running (status: ${docker})"
    return 1
  fi

  log_ok "Environment check passed"
}

# ── Phase 6: Container build ───────────────────────────────────────────────

phase_container_build() {
  log_info "Building agent container image"

  local output
  output=$(run_as_user "cd ${CLONE_DIR} && npx tsx setup/index.ts --step container -- --runtime docker" 2>&1)
  local exit_code=$?

  local status
  status=$(parse_status_field "$output" "STATUS")
  local build_ok
  build_ok=$(parse_status_field "$output" "BUILD_OK")
  local test_ok
  test_ok=$(parse_status_field "$output" "TEST_OK")

  log_info "Container build: BUILD_OK=${build_ok} TEST_OK=${test_ok} STATUS=${status}"

  if [ "$exit_code" -ne 0 ] || [ "$status" != "success" ]; then
    log_error "Container build failed"
    return 1
  fi

  log_ok "Container image built and tested"
}

# ── Phase 7: Write credentials ─────────────────────────────────────────────

phase_credentials() {
  log_info "Writing credentials to test user's .env"
  write_test_env
}

# ── Phase 8: Install Telegram channel ──────────────────────────────────────

phase_channel_install() {
  log_info "Applying Telegram skill"

  # Initialize skills system first, then apply the skill
  run_as_user "cd ${CLONE_DIR} && npx tsx scripts/apply-skill.ts --init"
  if [ $? -ne 0 ]; then
    log_error "Skills system initialization failed"
    return 1
  fi

  local output
  output=$(run_as_user "cd ${CLONE_DIR} && npx tsx scripts/apply-skill.ts .claude/skills/add-telegram" 2>&1)
  local exit_code=$?

  if [ "$exit_code" -ne 0 ]; then
    log_error "Telegram skill application failed"
    echo "$output" | tail -20
    return 1
  fi

  # Rebuild after skill changes
  run_as_user "cd ${CLONE_DIR} && npm run build"
  if [ $? -ne 0 ]; then
    log_error "Rebuild after skill application failed"
    return 1
  fi

  log_ok "Telegram channel installed and rebuilt"
}

# ── Phase 9: Register test chat group ──────────────────────────────────────

phase_registration() {
  log_info "Registering test chat as main group"

  local output
  output=$(run_as_user "cd ${CLONE_DIR} && npx tsx setup/index.ts --step register -- \
    --jid ${TELEGRAM_TEST_CHAT_ID} \
    --name test-main \
    --trigger '@Andy' \
    --folder main \
    --channel telegram \
    --is-main \
    --no-trigger-required" 2>&1)
  local exit_code=$?

  local status
  status=$(parse_status_field "$output" "STATUS")

  log_info "Registration: STATUS=${status}"

  if [ "$exit_code" -ne 0 ] || [ "$status" != "success" ]; then
    log_error "Group registration failed"
    echo "$output" | tail -20
    return 1
  fi

  log_ok "Test chat registered as main group"
}

# ── Phase 10: Mount allowlist ──────────────────────────────────────────────

phase_mounts() {
  log_info "Setting empty mount allowlist"

  local output
  output=$(run_as_user "cd ${CLONE_DIR} && npx tsx setup/index.ts --step mounts -- --empty" 2>&1)
  local exit_code=$?

  local status
  status=$(parse_status_field "$output" "STATUS")

  if [ "$exit_code" -ne 0 ] || [ "$status" != "success" ]; then
    log_error "Mount allowlist setup failed"
    return 1
  fi

  log_ok "Empty mount allowlist configured"
}

# ── Phase 11: Start systemd service ────────────────────────────────────────

phase_service() {
  log_info "Setting up systemd user service"

  local output
  output=$(run_as_user "cd ${CLONE_DIR} && npx tsx setup/index.ts --step service" 2>&1)
  local exit_code=$?

  local status
  status=$(parse_status_field "$output" "STATUS")
  local service_loaded
  service_loaded=$(parse_status_field "$output" "SERVICE_LOADED")

  log_info "Service: STATUS=${status} SERVICE_LOADED=${service_loaded}"

  if [ "$exit_code" -ne 0 ] || [ "$status" != "success" ]; then
    log_error "Service setup failed"
    echo "$output" | tail -20
    return 1
  fi

  # Give the service a moment to start
  sleep 3

  # Verify it's actually running
  local uid
  uid=$(id -u "$TEST_USER")
  if sudo -u "$TEST_USER" XDG_RUNTIME_DIR="/run/user/${uid}" systemctl --user is-active nanoclaw &>/dev/null; then
    log_ok "Service is running"
  else
    log_warn "Service setup succeeded but service may not be active yet"
    sudo -u "$TEST_USER" XDG_RUNTIME_DIR="/run/user/${uid}" systemctl --user status nanoclaw 2>&1 | head -10 || true
  fi
}

# ── Phase 12: Infrastructure verification ──────────────────────────────────

phase_verify_infra() {
  log_info "Running infrastructure health check"

  local output
  output=$(run_as_user "cd ${CLONE_DIR} && npx tsx setup/index.ts --step verify" 2>&1)
  local exit_code=$?

  local status
  status=$(parse_status_field "$output" "STATUS")
  local service
  service=$(parse_status_field "$output" "SERVICE")
  local credentials
  credentials=$(parse_status_field "$output" "CREDENTIALS")
  local channels
  channels=$(parse_status_field "$output" "CONFIGURED_CHANNELS")
  local groups
  groups=$(parse_status_field "$output" "REGISTERED_GROUPS")

  log_info "Verify: SERVICE=${service} CREDENTIALS=${credentials} CHANNELS=${channels} GROUPS=${groups}"

  if [ "$exit_code" -ne 0 ] || [ "$status" != "success" ]; then
    log_error "Infrastructure verification failed"
    echo "$output" | tail -20
    return 1
  fi

  log_ok "Infrastructure health check passed"
}

# ── Phase 13: End-to-end Telegram verification ─────────────────────────────

phase_verify_e2e() {
  log_info "Starting end-to-end Telegram verification"
  run_telegram_e2e
}

# ── Phase 14: Teardown ─────────────────────────────────────────────────────

phase_teardown() {
  log_info "Tearing down test environment"

  # Stop the service
  if id "$TEST_USER" &>/dev/null; then
    local uid
    uid=$(id -u "$TEST_USER") || true
    if [ -n "$uid" ]; then
      sudo -u "$TEST_USER" XDG_RUNTIME_DIR="/run/user/${uid}" systemctl --user stop nanoclaw 2>/dev/null || true
      sudo -u "$TEST_USER" XDG_RUNTIME_DIR="/run/user/${uid}" systemctl --user disable nanoclaw 2>/dev/null || true
    fi
  fi

  # Kill any remaining processes owned by the test user
  pkill -u "$TEST_USER" 2>/dev/null || true
  sleep 2
  pkill -9 -u "$TEST_USER" 2>/dev/null || true

  # Disable linger
  loginctl disable-linger "$TEST_USER" 2>/dev/null || true

  # Remove user and home directory
  if id "$TEST_USER" &>/dev/null; then
    userdel -r "$TEST_USER" 2>/dev/null || true
    log_ok "User ${TEST_USER} removed"
  else
    log_info "User ${TEST_USER} does not exist (already removed)"
  fi
}
