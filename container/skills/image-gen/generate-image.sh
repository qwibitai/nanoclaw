#!/bin/bash
# Generate an image using Google Gemini API
# Usage: generate-image.sh "prompt" [aspect_ratio] [size]
#   aspect_ratio: 1:1 (default), 16:9, 9:16, 4:3, 3:4
#   size: small, medium (default), large

set -euo pipefail

PROMPT="${1:?Usage: generate-image.sh \"prompt\" [aspect_ratio] [size]}"
ASPECT_RATIO="${2:-1:1}"
SIZE="${3:-medium}"

if [ -z "${GEMINI_API_KEY:-}" ]; then
  echo "Error: GEMINI_API_KEY not set" >&2
  exit 1
fi

# Map size to persona instruction (Gemini doesn't have explicit size params)
case "$SIZE" in
  small)  SIZE_HINT="Create a simple, minimal image." ;;
  large)  SIZE_HINT="Create a highly detailed, high-resolution image." ;;
  *)      SIZE_HINT="" ;;
esac

FULL_PROMPT="Generate an image: ${PROMPT}. Aspect ratio: ${ASPECT_RATIO}. ${SIZE_HINT}"

# Create output directory
OUTPUT_DIR="/workspace/group/media/generated"
mkdir -p "$OUTPUT_DIR"
TIMESTAMP=$(date +%s%N | cut -c1-13)
OUTPUT_FILE="${OUTPUT_DIR}/${TIMESTAMP}.png"

# Temp file for API response (cleaned up on exit)
TMPFILE=$(mktemp)
trap 'rm -f "$TMPFILE"' EXIT

# Call Gemini API — write body to temp file, capture HTTP code
HTTP_CODE=$(curl -s -w "%{http_code}" -o "$TMPFILE" \
  "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-image-preview:generateContent?key=${GEMINI_API_KEY}" \
  -H "Content-Type: application/json" \
  -d "$(cat <<EOF
{
  "contents": [{
    "parts": [{"text": "$FULL_PROMPT"}]
  }],
  "generationConfig": {
    "responseModalities": ["TEXT", "IMAGE"]
  }
}
EOF
)")

if [ "$HTTP_CODE" != "200" ]; then
  echo "Error: Gemini API returned HTTP $HTTP_CODE" >&2
  cat "$TMPFILE" >&2
  exit 1
fi

# Extract base64 image data using python3 (no jq in container)
# Reads from temp file to avoid shell argument length limits
python3 -c "
import json, base64, sys

with open('$TMPFILE') as f:
    data = json.load(f)

candidates = data.get('candidates', [])
if not candidates:
    print('Error: No candidates in response', file=sys.stderr)
    sys.exit(1)

parts = candidates[0].get('content', {}).get('parts', [])
image_data = None
for part in parts:
    if 'inlineData' in part:
        image_data = part['inlineData'].get('data')
        break

if not image_data:
    print('Error: No image data in response', file=sys.stderr)
    for part in parts:
        if 'text' in part:
            print(f'Response text: {part[\"text\"]}', file=sys.stderr)
    sys.exit(1)

with open('$OUTPUT_FILE', 'wb') as f:
    f.write(base64.b64decode(image_data))
"

echo "$OUTPUT_FILE"
