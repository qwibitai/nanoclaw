#!/usr/bin/env bash
# Memory Architect - Build Your Second Brain
# Powered by Ars Contexta methodology

set -euo pipefail

SKILL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WORKSPACE_GROUP="${WORKSPACE_GROUP:-/workspace/group}"
TEMP_DIR="/tmp/second-brain-$$"

# Colors for output
GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m' # No Color

log_info() {
    echo -e "${BLUE}→${NC} $1"
}

log_success() {
    echo -e "${GREEN}✓${NC} $1"
}

log_warn() {
    echo -e "${YELLOW}⚠️${NC} $1"
}

log_error() {
    echo -e "${RED}❌${NC} $1"
}

cleanup() {
    if [ -d "$TEMP_DIR" ]; then
        rm -rf "$TEMP_DIR"
    fi
}

trap cleanup EXIT

# This is a placeholder script
# The actual implementation is handled by the Claude agent
# when the /second-brain skill is invoked

cat << 'EOF'
🧠 Memory Architect - Build Your Second Brain

This skill is powered by Ars Contexta methodology and requires
the Claude agent to perform the installation.

The agent will:
1. Fetch and analyze Ars Contexta repository
2. Ask questions about your use case and preferences
3. Propose a tailored memory architecture
4. Implement the three-space system
5. Validate the installation

Please invoke this skill through Claude Code or your nanoclaw agent.

For more information, see:
- SKILL.md in this directory
- https://github.com/agenticnotetaking/arscontexta
EOF
