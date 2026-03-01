#!/bin/bash
# Transcribe audio to text using Gemini
# Usage: transcribe.sh <audio_file>
# Outputs transcription text to stdout

set -euo pipefail

INPUT="${1:?Usage: transcribe.sh <audio_file>}"

if [ ! -f "$INPUT" ]; then
  echo "Error: File not found: $INPUT" >&2
  exit 1
fi

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
