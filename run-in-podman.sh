#!/bin/bash
# Run NanoClaw orchestrator inside a Podman container.
#
# Supply-chain isolation: npm install and tsc never run on your host.
# All Node.js dependency resolution happens inside the container image.
#
# Usage:
#   ./run-in-podman.sh            # build images (first time) and start
#   ./run-in-podman.sh restart    # rebuild images and restart
#   ./run-in-podman.sh stop       # stop the orchestrator
#   ./run-in-podman.sh logs       # tail live logs
#   ./run-in-podman.sh build      # rebuild images only (no start)

set -e


SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONTAINER_NAME="nanoclaw-host"
IMAGE_NAME="nanoclaw-host:latest"
AGENT_IMAGE="nanoclaw-agent:latest"

# ── Path conversion ──────────────────────────────────────────────────────────
# Podman on Windows uses WSL2. Bind-mount paths must be WSL2 paths (/mnt/d/...).
# This converts Git Bash paths (/d/...) or Windows paths (D:\...) to WSL2 format.
to_wsl_path() {
    local p="$1"
    if [[ "$p" =~ ^/([a-zA-Z])/(.*) ]]; then
        # Git Bash format: /d/foo → /mnt/d/foo
        echo "/mnt/${BASH_REMATCH[1],,}/${BASH_REMATCH[2]}"
    elif [[ "$p" =~ ^([a-zA-Z]):[/\\](.*) ]]; then
        # Windows format: D:\foo or D:/foo → /mnt/d/foo
        local rest="${BASH_REMATCH[2]//\\//}"
        echo "/mnt/${BASH_REMATCH[1],,}/$rest"
    else
        # Already WSL2/Linux format
        echo "$p"
    fi
}

PROJECT_DIR="$(to_wsl_path "$SCRIPT_DIR")"

# ── Helpers ──────────────────────────────────────────────────────────────────
stop_container() {
    if podman ps -q --filter "name=^${CONTAINER_NAME}$" | grep -q .; then
        echo "Stopping $CONTAINER_NAME..."
        podman stop "$CONTAINER_NAME" 2>/dev/null || true
    fi
    podman rm -f "$CONTAINER_NAME" 2>/dev/null || true
}

build_agent_image() {
    echo "Building agent container image (nanoclaw-agent)..."
    CONTAINER_RUNTIME=podman bash "$SCRIPT_DIR/container/build.sh"
}

build_host_image() {
    echo "Building orchestrator image (nanoclaw-host)..."
    podman build -f "$SCRIPT_DIR/Containerfile.host" -t "$IMAGE_NAME" "$SCRIPT_DIR"
}

# ── Command dispatch ─────────────────────────────────────────────────────────
cmd="${1:-start}"

case "$cmd" in
    stop)
        stop_container
        echo "Stopped."
        exit 0
        ;;
    logs)
        podman logs -f "$CONTAINER_NAME"
        exit 0
        ;;
    build)
        build_agent_image
        build_host_image
        echo "Build complete."
        exit 0
        ;;
    start|restart)
        ;;
    *)
        echo "Usage: $0 [start|stop|restart|logs|build]"
        exit 1
        ;;
esac

# ── Build images if needed ───────────────────────────────────────────────────
if ! podman image exists "$AGENT_IMAGE" || [[ "$cmd" == "restart" ]]; then
    build_agent_image
fi

if ! podman image exists "$IMAGE_NAME" || [[ "$cmd" == "restart" ]]; then
    build_host_image
fi

stop_container

# ── Ensure runtime directories exist ────────────────────────────────────────
mkdir -p "$SCRIPT_DIR/groups" "$SCRIPT_DIR/store" "$SCRIPT_DIR/data" "$SCRIPT_DIR/logs" "$SCRIPT_DIR/data/tmp"

# ── Mount configuration ──────────────────────────────────────────────────────
# Podman socket for spawning agent containers (rootful Podman default path)
PODMAN_SOCK="/run/podman/podman.sock"

# Nanoclaw config dir (mount allowlist, sender allowlist) — outside project root
WSL_HOME="$(to_wsl_path "$HOME")"
NANOCLAW_CONFIG="$WSL_HOME/.config/nanoclaw"

# Build optional mount args as a string to avoid Git Bash array expansion issues
ENV_MOUNTS=""
if [[ -f "$SCRIPT_DIR/.env" ]]; then
    ENV_MOUNTS="-v ${PROJECT_DIR}/.env:/app/.env:ro -v ${PROJECT_DIR}/.env:${PROJECT_DIR}/.env:ro"
fi
CONFIG_MOUNT=""
if [[ -d "$NANOCLAW_CONFIG" ]]; then
    CONFIG_MOUNT="-v ${NANOCLAW_CONFIG}:/root/.config/nanoclaw"
fi

# ── Start orchestrator ───────────────────────────────────────────────────────
echo "Starting NanoClaw orchestrator (project: $PROJECT_DIR)..."

# shellcheck disable=SC2086
MSYS_NO_PATHCONV=1 podman run -d \
    --name "$CONTAINER_NAME" \
    --network host \
    -e HOST_PROJECT_ROOT="$PROJECT_DIR" \
    -e CONTAINER_RUNTIME_BIN=podman \
    -e CONTAINER_HOST="unix://${PODMAN_SOCK}" \
    -e TMPDIR="${PROJECT_DIR}/data/tmp" \
    -v "${PODMAN_SOCK}:${PODMAN_SOCK}" \
    -v "${PROJECT_DIR}/groups:${PROJECT_DIR}/groups" \
    -v "${PROJECT_DIR}/store:${PROJECT_DIR}/store" \
    -v "${PROJECT_DIR}/data:${PROJECT_DIR}/data" \
    -v "${PROJECT_DIR}/logs:${PROJECT_DIR}/logs" \
    -v "${PROJECT_DIR}/container:${PROJECT_DIR}/container:ro" \
    $ENV_MOUNTS \
    $CONFIG_MOUNT \
    "$IMAGE_NAME"

echo ""
echo "NanoClaw is running in Podman container '$CONTAINER_NAME'."
echo "  View logs:  ./run-in-podman.sh logs"
echo "  Stop:       ./run-in-podman.sh stop"
echo "  Rebuild:    ./run-in-podman.sh restart"
