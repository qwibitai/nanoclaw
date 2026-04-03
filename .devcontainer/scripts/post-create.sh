#!/usr/bin/env bash
set -euo pipefail

VERIFY_ONLY="${1:-}"
AI_NATIVE_TOOL="git+https://github.com/ufJmacca/ai-native"
CODEX_HOME_DIR="/home/vscode/.codex"

export PATH="/home/vscode/.local/bin:${PATH}"

declare -a REQUIRED_FILES=(
  "/home/vscode/.codex/auth.json"
  "/home/vscode/.codex/config.toml"
  "/home/vscode/.gitconfig"
)

declare -a REQUIRED_DIRS=(
  "${CODEX_HOME_DIR}"
  "/home/vscode/.ssh"
)

declare -a REQUIRED_COMMANDS=(
  "claude"
  "docker"
  "git"
  "node"
  "npm"
  "python3"
  "uv"
)

declare -a OPTIONAL_DIRS=(
  "/home/vscode/.config/gh"
)

missing=0

ensure_writable_dir() {
  local dir_path="$1"

  sudo mkdir -p "${dir_path}"
  sudo chown -R vscode:vscode "${dir_path}"

  if [[ -w "${dir_path}" ]]; then
    echo "[writable] ${dir_path}"
  else
    echo "[not-writable] ${dir_path}"
    missing=1
  fi
}

install_npm_workspace() {
  local workspace_dir="$1"
  local label="$2"

  if [[ ! -f "${workspace_dir}/package.json" ]]; then
    return 0
  fi

  if [[ ! -f "${workspace_dir}/package-lock.json" ]]; then
    echo "[skip] ${label} npm install (no package-lock.json)"
    return 0
  fi

  echo "[installing] ${label} dependencies"
  (
    cd "${workspace_dir}"
    npm ci
  )
}

for path in "${REQUIRED_FILES[@]}"; do
  if [[ -f "${path}" ]]; then
    echo "[ok] ${path}"
  else
    echo "[missing] ${path}"
    missing=1
  fi
done

for path in "${REQUIRED_DIRS[@]}"; do
  if [[ -d "${path}" ]]; then
    echo "[ok] ${path}"
  else
    echo "[missing] ${path}"
    missing=1
  fi
done

for command_name in "${REQUIRED_COMMANDS[@]}"; do
  if command -v "${command_name}" >/dev/null 2>&1; then
    echo "[ok] ${command_name}"
  else
    echo "[missing] ${command_name}"
    missing=1
  fi
done

if [[ -d "${CODEX_HOME_DIR}" ]]; then
  if [[ -w "${CODEX_HOME_DIR}" ]]; then
    echo "[writable] ${CODEX_HOME_DIR}"
  else
    echo "[not-writable] ${CODEX_HOME_DIR}"
    missing=1
  fi
fi

for path in "${OPTIONAL_DIRS[@]}"; do
  if [[ -d "${path}" ]]; then
    echo "[ok] ${path}"
  else
    echo "[optional-missing] ${path}"
  fi
done

if command -v docker >/dev/null 2>&1; then
  if docker compose version >/dev/null 2>&1; then
    echo "[ok] docker compose"
  else
    echo "[docker-unavailable] docker compose could not reach the host daemon"
  fi
else
  echo "[docker-unavailable] docker"
fi

if [[ -d "/mnt/host-config/gh" ]] && [[ ! -e "/home/vscode/.config/gh" ]]; then
  mkdir -p /home/vscode/.config
  ln -s /mnt/host-config/gh /home/vscode/.config/gh
  echo "[linked] /home/vscode/.config/gh -> /mnt/host-config/gh"
fi

if [[ "${missing}" -eq 1 ]]; then
  echo "Required devcontainer credentials or runtime directories are not available." >&2
  echo "Check .devcontainer/compose.yaml and confirm ~/.codex, ~/.ssh, and ~/.gitconfig exist on the host." >&2
  echo "Codex also requires ${CODEX_HOME_DIR} to be writable by the vscode user so it can persist runtime state." >&2
fi

if [[ "${VERIFY_ONLY}" == "--verify-only" ]]; then
  exit "${missing}"
fi

ensure_writable_dir "/home/vscode/.npm"
ensure_writable_dir "/workspace/node_modules"
ensure_writable_dir "/workspace/container/agent-runner/node_modules"

if command -v uv >/dev/null 2>&1; then
  echo "[installing] ${AI_NATIVE_TOOL}"
  uv tool install --force --refresh "${AI_NATIVE_TOOL}"
else
  echo "[missing] uv"
  echo "uv is required to install ${AI_NATIVE_TOOL}. Rebuild the devcontainer so .devcontainer/Dockerfile changes are applied." >&2
fi

if [[ -f "./scripts/bootstrap.sh" ]]; then
  echo "[bootstrapping] workspace dependencies"
  bash ./scripts/bootstrap.sh
fi

if command -v npm >/dev/null 2>&1; then
  install_npm_workspace "/workspace" "workspace"
  install_npm_workspace "/workspace/container/agent-runner" "agent-runner"
else
  echo "[missing] npm"
  echo "npm is required to install workspace dependencies. Rebuild the devcontainer so the Node feature is applied." >&2
fi

exit "${missing}"
