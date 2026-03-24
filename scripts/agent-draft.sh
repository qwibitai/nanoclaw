#!/bin/bash
# agent-draft.sh — Launch a Claude Code session to draft paper sections
#
# Usage:
#   ./scripts/agent-draft.sh <project-dir> "<instruction>"
#
# Examples:
#   ./scripts/agent-draft.sh ~/projects/discontinuous-machines "Draft the introduction"
#   ./scripts/agent-draft.sh ~/projects/collab-paper "Revise the methods section to cover the new sampling approach"
#
# The agent will:
#   1. Read project CLAUDE.md and vault context
#   2. Create an agent/* branch
#   3. Draft/revise the requested section(s)
#   4. Commit and push the branch for review

set -e

PROJECT_DIR="$1"
INSTRUCTION="$2"
VAULT_DIR="$HOME/obsidian-notes"
TIMESTAMP=$(date +%Y%m%d_%H%M%S)
LOG_DIR="$HOME/logs"

if [ -z "$PROJECT_DIR" ] || [ -z "$INSTRUCTION" ]; then
  echo "Usage: $0 <project-dir> \"<instruction>\""
  echo ""
  echo "Examples:"
  echo "  $0 ~/projects/my-paper \"Draft the introduction\""
  echo "  $0 ~/projects/my-paper \"Revise methods to cover new sampling\""
  exit 1
fi

# Resolve to absolute path
PROJECT_DIR=$(cd "$PROJECT_DIR" && pwd)
PROJECT_NAME=$(basename "$PROJECT_DIR")

if [ ! -d "$PROJECT_DIR" ]; then
  echo "Error: Project directory not found: $PROJECT_DIR"
  exit 1
fi

# Ensure log directory exists
mkdir -p "$LOG_DIR"

echo "=== Agent Drafting Session ==="
echo "Project: $PROJECT_NAME ($PROJECT_DIR)"
echo "Instruction: $INSTRUCTION"
echo "Log: $LOG_DIR/draft_${PROJECT_NAME}_${TIMESTAMP}.log"
echo ""

cd "$PROJECT_DIR"

# Pull latest if this is a git repo with a remote
if git remote get-url origin &>/dev/null; then
  echo "Pulling latest from origin..."
  git pull origin main 2>/dev/null || git pull origin master 2>/dev/null || true
fi

# Determine project layout
if [ -d "draft/sections" ]; then
  LAYOUT="research-project"
  TEX_ROOT="draft"
elif [ -d "sections" ]; then
  LAYOUT="paper-only"
  TEX_ROOT="."
elif [ -f "draft/main.tex" ]; then
  LAYOUT="research-project-monolithic"
  TEX_ROOT="draft"
else
  LAYOUT="unknown"
  TEX_ROOT="."
fi

echo "Detected layout: $LAYOUT (tex root: $TEX_ROOT)"
echo ""

# Build the prompt
TODAY=$(date +%Y%m%d)
PROMPT=$(cat <<PROMPT_EOF
You are drafting a section of an academic paper. Follow the paper-drafting skill exactly.

## Setup

1. Read CLAUDE.md in this project root for project-specific instructions.
2. Read vault context:
   - Read ${VAULT_DIR}/_meta/researcher-profile.md
   - Read ${VAULT_DIR}/_meta/preferences.md
   - Read ${VAULT_DIR}/projects/${PROJECT_NAME}/PROJECT.md (if it exists)
3. Read the existing manuscript to match style and argument flow.
   - If ${TEX_ROOT}/sections/ exists, read each section file there.
   - Otherwise, read ${TEX_ROOT}/main.tex — the full manuscript is in one file.
4. Read ${TEX_ROOT}/refs.bib for available citation keys.

## Git workflow

- Create branch: git checkout -b agent/draft-${TODAY}
- Commit your work with descriptive messages
- Push the branch: git push -u origin agent/draft-${TODAY}
- NEVER merge to main

## Your task

${INSTRUCTION}

## After writing

Report: what you wrote, which citations you used (especially [CITE:] placeholders), what needs the researcher's judgment, and the branch name.
PROMPT_EOF
)

# Run Claude Code
echo "$PROMPT" | claude -p \
  --allowedTools "Read,Write,Edit,Glob,Grep,Bash(git:*),Bash(latexmk:*),Bash(make:*),Bash(ls:*),Bash(cat:*),Bash(grep:*),Bash(zotero-cli:*),mcp__*" \
  2>&1 | tee "$LOG_DIR/draft_${PROJECT_NAME}_${TIMESTAMP}.log"
