#!/bin/bash
# Botti Voice — Gemini Live Audio
# Usage: ./start.sh [--mode camera|screen|none]
cd "$(dirname "$0")"
source .venv/bin/activate
set -a; source .env; set +a
python botti_voice.py "$@"
