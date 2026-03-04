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

# ── Phase 7: Mount allowlist ──────────────────────────────────────────────

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

# ── Phase: Start systemd service (first scenario) ────────────────────────────

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

# ── Phase: Infrastructure verification ──────────────────────────────────

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

# ══════════════════════════════════════════════════════════════════════════════
# Scenario sub-phase functions
# Used by playbook.sh to execute individual steps within a scenario.
# ══════════════════════════════════════════════════════════════════════════════

# Set by sub-phase functions on failure — playbook.sh reads this to record
# the actual error detail (compiler output, script message, etc.)
LAST_ERROR_DETAIL=""

# Full build/test output from the last sub-phase command.
# Used by auto-fix to gather context for Claude.
LAST_BUILD_OUTPUT=""

# ── Uninstall channel skills ─────────────────────────────────────────────────
#
# Usage: phase_uninstall_channels <ch1> [ch2...]

phase_uninstall_channels() {
  for channel in "$@"; do
    # uninstall-skill.ts matches on the manifest "skill:" name, not the directory
    log_info "Uninstalling skill: ${channel}"

    local output
    output=$(run_as_user "cd ${CLONE_DIR} && npx tsx scripts/uninstall-skill.ts ${channel}" 2>&1)
    local exit_code=$?

    if [ "$exit_code" -ne 0 ]; then
      log_error "Failed to uninstall skill: ${channel}"
      LAST_ERROR_DETAIL=$(echo "$output" | grep -iE 'error|fail|not applied' | tail -3)
      echo "$output" | tail -20
      return 1
    fi

    log_ok "Skill ${channel} uninstalled"
  done

  # Rebuild after uninstall
  log_info "Rebuilding after skill uninstall..."
  local build_output
  build_output=$(run_as_user "cd ${CLONE_DIR} && npm run build" 2>&1)
  LAST_BUILD_OUTPUT="$build_output"
  if [ $? -ne 0 ]; then
    log_error "Rebuild after skill uninstall failed"
    LAST_ERROR_DETAIL=$(echo "$build_output" | grep -iE 'error TS|error:' | head -3)
    echo "$build_output" | tail -20
    return 1
  fi

  log_ok "Channels uninstalled and rebuilt"
}

# ── Install channel skills ───────────────────────────────────────────────────
#
# Usage: phase_install_channels <ch1> [ch2...]

phase_install_channels() {
  # Initialize skills system (idempotent)
  run_as_user "cd ${CLONE_DIR} && npx tsx scripts/apply-skill.ts --init"
  if [ $? -ne 0 ]; then
    log_error "Skills system initialization failed"
    LAST_ERROR_DETAIL="apply-skill.ts --init returned non-zero"
    return 1
  fi

  for channel in "$@"; do
    local skill_name="add-${channel}"
    log_info "Installing skill: ${skill_name}"

    local output
    output=$(run_as_user "cd ${CLONE_DIR} && npx tsx scripts/apply-skill.ts .claude/skills/${skill_name}" 2>&1)
    local exit_code=$?

    if [ "$exit_code" -ne 0 ]; then
      log_error "Failed to install skill: ${skill_name}"
      LAST_ERROR_DETAIL=$(echo "$output" | grep -iE 'error|fail' | tail -3)
      echo "$output" | tail -20
      return 1
    fi

    log_ok "Skill ${skill_name} installed"
  done

  # Rebuild after install
  log_info "Rebuilding after skill install..."
  local build_output
  build_output=$(run_as_user "cd ${CLONE_DIR} && npm run build" 2>&1)
  LAST_BUILD_OUTPUT="$build_output"
  if [ $? -ne 0 ]; then
    log_error "Rebuild after skill install failed"
    LAST_ERROR_DETAIL=$(echo "$build_output" | grep -iE 'error TS|error:' | head -3)
    echo "$build_output" | tail -20
    return 1
  fi

  log_ok "Channels installed and rebuilt"
}

# ── Register a test group ───────────────────────────────────────────────────
#
# Usage: phase_register_group <jid_var> <name> <channel> [--is-main]

phase_register_group() {
  local jid_var="$1"
  local group_name="$2"
  local channel="$3"
  local is_main="${4:-}"

  # Resolve the JID from the env var name
  local chat_jid="${!jid_var}"
  if [ -z "$chat_jid" ]; then
    log_error "Registration failed: ${jid_var} is not set"
    LAST_ERROR_DETAIL="${jid_var} env var is empty — check credentials.env"
    return 1
  fi

  log_info "Registering group '${group_name}' (channel=${channel}, jid=${chat_jid})"

  local main_flag=""
  if [ "$is_main" = "--is-main" ]; then
    main_flag="--is-main"
  fi

  local output
  output=$(run_as_user "cd ${CLONE_DIR} && npx tsx setup/index.ts --step register -- \
    --jid ${chat_jid} \
    --name ${group_name} \
    --trigger '@Andy' \
    --folder ${group_name} \
    --channel ${channel} \
    ${main_flag} \
    --no-trigger-required" 2>&1)
  local exit_code=$?

  local status
  status=$(parse_status_field "$output" "STATUS")

  log_info "Registration: STATUS=${status}"

  if [ "$exit_code" -ne 0 ] || [ "$status" != "success" ]; then
    log_error "Group registration failed for ${group_name}"
    LAST_ERROR_DETAIL=$(echo "$output" | grep -iE 'error|fail' | tail -3)
    echo "$output" | tail -20
    return 1
  fi

  log_ok "Group '${group_name}' registered (channel=${channel})"
}

# ── Restart systemd service ──────────────────────────────────────────────────
#
# Used between scenarios after skill install/uninstall + rebuild.

phase_restart_service() {
  log_info "Restarting nanoclaw service"

  local uid
  uid=$(id -u "$TEST_USER")

  local restart_output
  restart_output=$(sudo -u "$TEST_USER" XDG_RUNTIME_DIR="/run/user/${uid}" \
    systemctl --user restart nanoclaw 2>&1)

  if [ $? -ne 0 ]; then
    log_error "Service restart failed"
    LAST_ERROR_DETAIL="$restart_output"
    return 1
  fi

  # Wait for the service to come back up
  sleep 5

  if sudo -u "$TEST_USER" XDG_RUNTIME_DIR="/run/user/${uid}" systemctl --user is-active nanoclaw &>/dev/null; then
    log_ok "Service restarted and running"
  else
    log_warn "Service restart issued but may not be active yet"
    sudo -u "$TEST_USER" XDG_RUNTIME_DIR="/run/user/${uid}" systemctl --user status nanoclaw 2>&1 | head -10 || true
  fi
}

# ── Teardown ──────────────────────────────────────────────────────────────────

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
