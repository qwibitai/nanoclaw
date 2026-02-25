#!/usr/bin/env bash
set -euo pipefail

VERSION="0.12.0"
INSTALL_DIR="/usr/local/bin"
UPSTREAM_SKILL_URL="https://raw.githubusercontent.com/BRO3886/gtasks/master/skills/gtasks-cli/SKILL.md"

# Detect OS
OS_RAW="$(uname -s)"
case "${OS_RAW}" in
  Darwin) OS="mac" ;;
  Linux)  OS="linux" ;;
  *) echo "Unsupported OS: ${OS_RAW}" && exit 1 ;;
esac

# Detect arch
ARCH_RAW="$(uname -m)"
case "${ARCH_RAW}" in
  x86_64)  ARCH="amd64" ;;
  arm64)   ARCH="arm64" ;;
  aarch64) ARCH="arm64" ;;
  *) echo "Unsupported architecture: ${ARCH_RAW}" && exit 1 ;;
esac

TARBALL="gtasks_${OS}_${ARCH}_v${VERSION}.tar.gz"
DOWNLOAD_URL="https://github.com/BRO3886/gtasks/releases/download/v${VERSION}/${TARBALL}"

echo "Installing gtasks v${VERSION} for ${OS}/${ARCH}..."

# Download and extract
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "${TMP_DIR}"' EXIT

curl -fsSL "${DOWNLOAD_URL}" -o "${TMP_DIR}/${TARBALL}"
tar -xz -C "${TMP_DIR}" -f "${TMP_DIR}/${TARBALL}"

# Install binary
if [ -w "${INSTALL_DIR}" ]; then
  mv "${TMP_DIR}/gtasks" "${INSTALL_DIR}/gtasks"
else
  sudo mv "${TMP_DIR}/gtasks" "${INSTALL_DIR}/gtasks"
fi
chmod +x "${INSTALL_DIR}/gtasks"

echo "Binary installed: ${INSTALL_DIR}/gtasks"

# Create ~/.gtasks/ directory
mkdir -p "${HOME}/.gtasks"

# Determine script root (for container/skills/ path)
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "${SCRIPT_DIR}")"

# Download SKILL.md to global CC skills
GLOBAL_SKILL_DIR="${HOME}/.claude/skills/gtasks"
mkdir -p "${GLOBAL_SKILL_DIR}"
curl -fsSL "${UPSTREAM_SKILL_URL}" -o "${GLOBAL_SKILL_DIR}/SKILL.md"
echo "Global CC skill: ${GLOBAL_SKILL_DIR}/SKILL.md"

# Container skill is a custom NanoClaw file checked into the repo.
# It is never downloaded from upstream — do not modify this block.
echo "Container skill: using repo version at ${PROJECT_ROOT}/container/skills/gtasks/SKILL.md"

echo ""
echo "Setup complete. Next steps:"
echo ""
echo "  1. Create a GCP project and enable Google Tasks API"
echo "  2. Create OAuth2 credentials (type: Web application)"
echo "     Add authorized redirect URIs:"
echo "       http://localhost:8080/callback"
echo "       http://localhost:8081/callback"
echo "       http://localhost:8082/callback"
echo "       http://localhost:9090/callback"
echo "       http://localhost:9091/callback"
echo "  3. Create ~/.gtasks/env with your credentials:"
echo "       export GTASKS_CLIENT_ID=<your_client_id>"
echo "       export GTASKS_CLIENT_SECRET=<your_client_secret>"
echo "  4. Run: source ~/.gtasks/env && gtasks login"
echo "  5. Rebuild the NanoClaw container: ./container/build.sh"
