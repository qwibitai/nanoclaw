#!/bin/bash
# Transcribe audio to text using whisper.cpp (default) or Gemini LLM (--llm flag)
# Usage: transcribe.sh [--llm] <audio_file>
# Outputs transcription text to stdout

set -euo pipefail

# Parse flags
USE_LLM=false
while [[ "${1:-}" == --* ]]; do
  case "$1" in
    --llm) USE_LLM=true; shift ;;
    *) echo "Unknown flag: $1" >&2; exit 1 ;;
  esac
done

INPUT="${1:?Usage: transcribe.sh [--llm] <audio_file>}"

if [ ! -f "$INPUT" ]; then
  echo "Error: File not found: $INPUT" >&2
  exit 1
fi

# --- Gemini LLM mode ---
if [ "$USE_LLM" = true ]; then
  if [ -z "${GEMINI_API_KEY:-}" ]; then
    echo "Error: GEMINI_API_KEY not set" >&2
    exit 1
  fi

  python3 -c "
import base64, json, os, urllib.request, sys

with open('$INPUT', 'rb') as f:
    audio_b64 = base64.b64encode(f.read()).decode()

payload = json.dumps({
    'contents': [{'parts': [
        {'inlineData': {'mimeType': 'audio/ogg', 'data': audio_b64}},
        {'text': 'Transcribe this audio exactly as spoken. Output only the transcription, nothing else.'}
    ]}]
}).encode()

req = urllib.request.Request(
    f'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key={os.environ[\"GEMINI_API_KEY\"]}',
    data=payload,
    headers={'Content-Type': 'application/json'}
)
resp = urllib.request.urlopen(req)
result = json.loads(resp.read())
print(result['candidates'][0]['content']['parts'][0]['text'])
"
  exit 0
fi

# --- Whisper mode (default) ---
WHISPER_MODEL="/usr/local/share/whisper/ggml-base.en.bin"

if [ ! -f "$WHISPER_MODEL" ]; then
  echo "Error: Whisper model not found at $WHISPER_MODEL" >&2
  exit 1
fi

# Convert to 16kHz mono WAV (whisper.cpp requirement)
TMPWAV=$(mktemp --suffix=.wav)
trap 'rm -f "$TMPWAV"' EXIT

ffmpeg -i "$INPUT" -ar 16000 -ac 1 -f wav "$TMPWAV" -y 2>/dev/null

# Run whisper, suppress stderr diagnostics, output only transcription text
whisper-cli -m "$WHISPER_MODEL" -f "$TMPWAV" --no-timestamps 2>/dev/null

# Reminder to stderr (visible to the agent but not mixed into the transcription)
echo "[Whisper transcription — if this looks off, re-run with --llm flag for Gemini backup]" >&2

