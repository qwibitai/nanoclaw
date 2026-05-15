#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="${NANOCLAW_ROOT:-/Users/ilansolot/nanoclaw-v2}"
PODCAST_DIR="$ROOT_DIR/groups/thedius_pod/podcast"
LOG_DIR="$ROOT_DIR/logs"
LOCK_DIR="$LOG_DIR/local-enrichment-nightly.lock"
MODEL="${PODCAST_LOCAL_ENRICH_MODEL:-llama3.2:latest}"
RUN_ID="$(date +%Y%m%d-%H%M%S)"
LOG_FILE="$LOG_DIR/local-enrichment-nightly-$RUN_ID.log"

export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:${PATH:-}"

iso_now() {
  date '+%Y-%m-%dT%H:%M:%S%z'
}

mkdir -p "$LOG_DIR"
ln -sf "$LOG_FILE" "$LOG_DIR/local-enrichment-nightly.latest.log"

if ! mkdir "$LOCK_DIR" 2>/dev/null; then
  echo "Local enrichment already running; lock exists at $LOCK_DIR"
  exit 0
fi

cleanup() {
  rmdir "$LOCK_DIR" 2>/dev/null || true
}
trap cleanup EXIT

{
  echo "=== NanoClaw local enrichment nightly ==="
  echo "Started: $(iso_now)"
  echo "Root: $ROOT_DIR"
  echo "Podcast dir: $PODCAST_DIR"
  echo "Model: $MODEL"

  cd "$PODCAST_DIR"

  echo
  echo "--- Ingest transcripts ---"
  INGEST_STATUS=0
  node bin/ingest-transcripts.mjs --all || INGEST_STATUS=$?
  if [ "$INGEST_STATUS" -ne 0 ]; then
    echo "Transcript ingest exited with status $INGEST_STATUS; rebuilding context packs from currently available transcripts."
  fi

  echo
  echo "--- Ollama model check ---"
  CAN_ENRICH=1
  if ! command -v ollama >/dev/null 2>&1; then
    echo "ollama command not found; skipping local enrichment"
    CAN_ENRICH=0
  elif ! ollama list | awk '{print $1}' | grep -Fx "$MODEL" >/dev/null; then
    echo "Ollama model $MODEL not installed; skipping local enrichment"
    ollama list || true
    CAN_ENRICH=0
  fi

  if [ "$CAN_ENRICH" -eq 1 ]; then
    echo
    echo "--- Enrich transcripts ---"
    pnpm run enrich:local -- \
      --all \
      --exclude-feed kids \
      --model "$MODEL" \
      --chunk-chars 2500 \
      --overlap-chars 150 \
      --num-ctx 2048 \
      --num-predict 700 \
      --timeout-ms 300000 \
      --retries 1 \
      --max-minutes 480
  fi

  echo
  echo "--- Build context packs ---"
  pnpm run context:local -- --all --exclude-feed kids --limit 80

  for feed in markets tech stream iran; do
    if [ -d "library/transcripts/$feed" ]; then
      pnpm run context:local -- --feed "$feed" --limit 80
    fi
  done

  echo
  echo "Finished: $(iso_now)"
} >>"$LOG_FILE" 2>&1

echo "$LOG_FILE"
