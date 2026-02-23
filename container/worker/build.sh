#!/usr/bin/env bash
set -e
IMAGE_NAME="nanoclaw-worker"
TAG="${1:-latest}"
CONTAINER_RUNTIME="${CONTAINER_RUNTIME:-container}"
cd "$(dirname "$0")"
VENDOR_DIR="$(pwd)/vendor"
OPENCODE_BUNDLE="${VENDOR_DIR}/opencode-ai-node_modules.tgz"
REFRESH_OPENCODE_BUNDLE="${REFRESH_OPENCODE_BUNDLE:-0}"

get_builder_status() {
  local output rc
  output="$(${CONTAINER_RUNTIME} builder status 2>&1)"
  rc=$?

  if [[ $rc -ne 0 ]]; then
    if echo "${output}" | grep -qiE 'not found|no builder|does not exist'; then
      echo "MISSING"
    else
      echo "ERROR"
    fi
    return
  fi

  if echo "${output}" | grep -qE '(^|[[:space:]])RUNNING([[:space:]]|$)'; then
    echo "RUNNING"
    return
  fi

  if echo "${output}" | grep -qE '(^|[[:space:]])STOPPED([[:space:]]|$)'; then
    echo "STOPPED"
    return
  fi

  echo "UNKNOWN"
}

prepare_opencode_bundle() {
  mkdir -p "${VENDOR_DIR}"

  if [[ "${REFRESH_OPENCODE_BUNDLE}" != "1" && -f "${OPENCODE_BUNDLE}" ]]; then
    echo "Using cached OpenCode bundle: ${OPENCODE_BUNDLE}"
    return
  fi

  rm -f "${OPENCODE_BUNDLE}"

  local attempt
  for attempt in 1 2 3; do
    echo "Preparing OpenCode bundle (attempt ${attempt}/3)..."
    if ${CONTAINER_RUNTIME} run --rm \
      -e NODE_OPTIONS="--dns-result-order=ipv4first" \
      -v "${VENDOR_DIR}:/out" \
      node:22 sh -lc \
      "set -e;
       npm config set fetch-retries 5;
       npm config set fetch-retry-mintimeout 20000;
       npm config set fetch-retry-maxtimeout 120000;
       npm config set fetch-timeout 180000;
       npm view opencode-ai version >/dev/null;
       npm view chrome-devtools-mcp version >/dev/null;
       npm view @upstash/context7-mcp version >/dev/null;
       npm view mcp-remote version >/dev/null;
       npm install -g --no-audit --no-fund --loglevel=warn \
         opencode-ai \
         chrome-devtools-mcp \
         @upstash/context7-mcp \
         mcp-remote;
       tar -C /usr/local/lib/node_modules -czf /out/opencode-ai-node_modules.tgz \
         opencode-ai \
         chrome-devtools-mcp \
         @upstash/context7-mcp \
         mcp-remote"; then
      echo "Prepared OpenCode bundle: ${OPENCODE_BUNDLE}"
      return
    fi
    sleep $((attempt * 2))
  done

  echo "Failed to prepare OpenCode bundle after 3 attempts" >&2
  exit 1
}

ensure_builder_healthy() {
  local status corrupt
  status="$(get_builder_status)"

  # Check for storage corruption in running builder
  if [[ "${status}" == "RUNNING" ]]; then
    corrupt=$(${CONTAINER_RUNTIME} logs buildkit 2>&1 | grep -c "structure needs cleaning" || true)
    if [[ "${corrupt}" -gt 0 ]]; then
      echo "WARNING: Buildkit storage corruption detected (${corrupt} occurrences)."
      echo "Destroying and recreating builder to recover..."
      ${CONTAINER_RUNTIME} stop buildkit 2>/dev/null || pkill -f buildkit 2>/dev/null || true
      sleep 2
      ${CONTAINER_RUNTIME} rm buildkit 2>/dev/null || true
      status="DESTROYED"
    fi
  fi

  if [[ "${status}" != "RUNNING" ]]; then
    echo "Builder not running (${status}). Attempting start..."
    ${CONTAINER_RUNTIME} builder start 2>/dev/null || true
    sleep 3
    status="$(get_builder_status)"
    if [[ "${status}" != "RUNNING" ]]; then
      echo "Builder failed to start. Trying full reset (rm + start)..."
      ${CONTAINER_RUNTIME} rm buildkit 2>/dev/null || true
      ${CONTAINER_RUNTIME} builder start 2>/dev/null || true
      sleep 3
      status="$(get_builder_status)"
      if [[ "${status}" != "RUNNING" ]]; then
        echo "Builder failed to start after reset." >&2
        exit 1
      fi
    fi
  fi
  echo "Builder healthy (${status})"
}

prepare_opencode_bundle
ensure_builder_healthy
${CONTAINER_RUNTIME} build -t "${IMAGE_NAME}:${TAG}" .
echo "Built ${IMAGE_NAME}:${TAG}"
