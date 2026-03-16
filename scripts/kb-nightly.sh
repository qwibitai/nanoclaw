#!/bin/bash
# Nightly knowledge base ingestion — runs nightly_kb.py with proper venv + Ollama
# Cron: 30 3 * * * (3:30 AM EST, after Homura's 2:30 AM download task)

set -euo pipefail

KB_DIR="$HOME/nanoclaw/store/knowledge-base"
VENV_PYTHON="$KB_DIR/.venv/bin/python3"
SCRIPT="$KB_DIR/nightly_kb.py"
LOG="$KB_DIR/nightly.log"

# Check Ollama is running
if ! curl -s http://localhost:11434/api/tags >/dev/null 2>&1; then
  echo "[$(date)] Ollama not running, skipping ingestion" >> "$LOG"
  exit 0
fi

echo "[$(date)] Starting nightly KB ingestion" >> "$LOG"
"$VENV_PYTHON" "$SCRIPT" >> "$LOG" 2>&1
echo "[$(date)] Done" >> "$LOG"
