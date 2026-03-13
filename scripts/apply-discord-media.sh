#!/bin/bash
# apply-discord-media.sh
# Applies Discord image vision + voice transcription in one step.
# Run from the nanoclaw root: bash scripts/apply-discord-media.sh

set -eo pipefail

NANOCLAW_ROOT="$(cd "$(dirname "$0")/.." && pwd)"

echo ""
echo "Applying Discord image vision + voice transcription"
echo "   Nanoclaw root: $NANOCLAW_ROOT"
echo ""

cd "$NANOCLAW_ROOT"

# ── Step 1: Pre-flight checks ─────────────────────────────────────────────────
echo "Checking system dependencies..."

PREFLIGHT_OK=true

if command -v whisper-cli &>/dev/null; then
  echo "   whisper-cli found"
else
  echo ""
  echo "   whisper-cli not found. Install it with:"
  echo "   brew install whisper-cpp"
  PREFLIGHT_OK=false
fi

if command -v ffmpeg &>/dev/null; then
  echo "   ffmpeg found"
else
  echo ""
  echo "   ffmpeg not found. Install it with:"
  echo "   brew install ffmpeg"
  PREFLIGHT_OK=false
fi

MODEL_PATH="$NANOCLAW_ROOT/data/models/ggml-base.bin"
if [ -f "$MODEL_PATH" ]; then
  echo "   Whisper model found"
else
  echo ""
  echo "   Whisper model not found - downloading ggml-base.bin (~142 MB)..."
  mkdir -p "$(dirname "$MODEL_PATH")"
  if curl -L --progress-bar \
    -o "$MODEL_PATH" \
    "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.bin"; then
    echo "   Model downloaded to $MODEL_PATH"
  else
    echo "   Model download failed. Check your internet connection and try again."
    PREFLIGHT_OK=false
  fi
fi

if [ "$PREFLIGHT_OK" = false ]; then
  echo ""
  echo "Pre-flight checks failed. Fix the issues above and re-run this script."
  exit 1
fi

# ── Step 2: Apply skills via the skill engine ─────────────────────────────────
echo ""
echo "Applying add-discord-image-vision..."
npx tsx scripts/apply-skill.ts .claude/skills/add-discord-image-vision

echo ""
echo "Applying add-discord-voice-transcription..."
npx tsx scripts/apply-skill.ts .claude/skills/add-discord-voice-transcription

# ── Step 3: Run tests ─────────────────────────────────────────────────────────
echo ""
echo "Running tests..."
if npm test; then
  echo "   All tests passed"
else
  echo ""
  echo "Tests failed. Skill files have been applied but NOT committed."
  echo "   Fix the failures above, then run: git add -A && git commit"
  exit 1
fi

# ── Step 4: Build ─────────────────────────────────────────────────────────────
echo ""
echo "Building..."
if npm run build; then
  echo "   Build successful"
else
  echo ""
  echo "Build failed. Fix TypeScript errors, then rebuild and commit."
  exit 1
fi

echo ""
echo "Done! Restart nanoclaw to apply:"
echo ""
echo "   launchctl kickstart -k gui/\$(id -u)/com.nanoclaw"
echo ""
echo "Then send an image or voice memo in Discord to test."
