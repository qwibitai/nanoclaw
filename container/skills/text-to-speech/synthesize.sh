#!/bin/bash
# Generate speech audio from text using Google Gemini TTS
# Usage: synthesize.sh "text to speak"
#    or: echo "text" | synthesize.sh
# Outputs OGG Opus file path to stdout

set -euo pipefail

# Read text from argument or stdin
if [ $# -ge 1 ]; then
  TEXT="$1"
else
  TEXT=$(cat)
fi

if [ -z "$TEXT" ]; then
  echo "Error: No text provided" >&2
  echo "Usage: synthesize.sh \"text to speak\"" >&2
  exit 1
fi

if [ -z "${GEMINI_API_KEY:-}" ]; then
  echo "Error: GEMINI_API_KEY not set" >&2
  exit 1
fi

# Create output directory
OUTPUT_DIR="/workspace/group/media/generated"
mkdir -p "$OUTPUT_DIR"
TIMESTAMP=$(date +%s%N | cut -c1-13)
OGG_FILE="${OUTPUT_DIR}/${TIMESTAMP}.ogg"

# Temp file for API response (cleaned up on exit)
TMPFILE=$(mktemp)
WAV_FILE=$(mktemp --suffix=.wav)
trap 'rm -f "$TMPFILE" "$WAV_FILE"' EXIT

# Call Gemini API for TTS
python3 -c "
import json, base64, os, urllib.request, sys

text = sys.argv[1]

payload = json.dumps({
    'contents': [{'parts': [{'text': text}]}],
    'generationConfig': {
        'responseModalities': ['AUDIO'],
        'speechConfig': {
            'voiceConfig': {
                'prebuiltVoiceConfig': {
                    'voiceName': 'Orus'
                }
            }
        }
    }
}).encode()

req = urllib.request.Request(
    f'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-preview-tts:generateContent?key={os.environ[\"GEMINI_API_KEY\"]}',
    data=payload,
    headers={'Content-Type': 'application/json'}
)
resp = urllib.request.urlopen(req)
result = json.loads(resp.read())

candidates = result.get('candidates', [])
if not candidates:
    print('Error: No candidates in response', file=sys.stderr)
    sys.exit(1)

parts = candidates[0].get('content', {}).get('parts', [])
audio_data = None
for part in parts:
    if 'inlineData' in part:
        audio_data = part['inlineData'].get('data')
        break

if not audio_data:
    print('Error: No audio data in response', file=sys.stderr)
    sys.exit(1)

with open('$WAV_FILE', 'wb') as f:
    f.write(base64.b64decode(audio_data))
" "$TEXT"

# Convert to OGG Opus (Telegram voice message format)
ffmpeg -f s16le -ar 24000 -ac 1 -i "$WAV_FILE" -c:a libopus -b:a 64k "$OGG_FILE" -y 2>/dev/null

echo "$OGG_FILE"
