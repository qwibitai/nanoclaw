#!/bin/bash
# Pollinations Image Generator
# Generates images via the Pollinations API.
#
# Usage:
#   generate.sh --prompt "a cat in space" [OPTIONS]
#
# Options:
#   --prompt TEXT         Required. The image prompt
#   --model MODEL        Model name (default: zimage)
#   --negative TEXT      Negative prompt (max 5 entries, comma-separated)
#   --enhance            Enable prompt enhancement (default: off)
#   --image URL          Reference image URL for editing
#   --output PATH        Output file path (default: /workspace/group/generated-<timestamp>.jpg)
#   --list-models        List available free models and exit
#
# Environment:
#   POLLINATIONS_API_KEY  Required. API key for Pollinations

set -euo pipefail

POLLINATIONS_BASE="https://gen.pollinations.ai"
MODELS_ENDPOINT="${POLLINATIONS_BASE}/image/models"
IMAGE_ENDPOINT="${POLLINATIONS_BASE}/image"

# Defaults
PROMPT=""
MODEL="zimage"
NEGATIVE_PROMPT=""
ENHANCE="false"
IMAGE_URL=""
OUTPUT_PATH=""
LIST_MODELS="false"
API_KEY="${POLLINATIONS_API_KEY:-}"

# Parse arguments
while [[ $# -gt 0 ]]; do
  case $1 in
    --prompt)   PROMPT="$2"; shift 2 ;;
    --model)    MODEL="$2"; shift 2 ;;
    --negative) NEGATIVE_PROMPT="$2"; shift 2 ;;
    --enhance)  ENHANCE="true"; shift ;;
    --image)    IMAGE_URL="$2"; shift 2 ;;
    --output)   OUTPUT_PATH="$2"; shift 2 ;;
    --list-models) LIST_MODELS="true"; shift ;;
    *) echo "Unknown option: $1" >&2; exit 1 ;;
  esac
done

# --- List models mode ---
if [[ "$LIST_MODELS" == "true" ]]; then
  if ! command -v jq &>/dev/null; then
    echo "Error: jq is required for --list-models" >&2
    exit 1
  fi

  echo "Fetching available models..."
  MODEL_DATA=$(curl -sf "${MODELS_ENDPOINT}")

  if [[ -z "$MODEL_DATA" ]]; then
    echo "Error: Failed to fetch model list" >&2
    exit 1
  fi

  echo ""
  echo "Free (non-paid) image models:"
  echo "-----------------------------"
  echo "$MODEL_DATA" | jq -r '
    .[]
    | select((.paid_only // false) == false)
    | select(.output_modalities // [] | contains(["image"]))
    | "\(.name)\t\(.description)\t\(.input_modalities | join(","))"
  ' | while IFS=$'\t' read -r name desc modalities; do
    mod_hint=""
    if echo "$modalities" | grep -q "image"; then
      mod_hint=" [supports image input]"
    fi
    printf "  %-20s %s%s\n" "$name" "$desc" "$mod_hint"
  done
  echo ""
  echo "Paid models (excluded):"
  echo "-----------------------"
  echo "$MODEL_DATA" | jq -r '
    .[]
    | select(.paid_only == true)
    | select(.output_modalities // [] | contains(["image"]))
    | "  \(.name) - \(.description)"
  '
  exit 0
fi

# --- Validate required args ---
if [[ -z "$PROMPT" ]]; then
  echo "Error: --prompt is required" >&2
  exit 1
fi

if [[ -z "$API_KEY" ]]; then
  echo "Error: POLLINATIONS_API_KEY environment variable is not set" >&2
  exit 1
fi

# --- Validate model is not paid-only ---
validate_model() {
  local model="$1"
  local model_data

  model_data=$(curl -sf "${MODELS_ENDPOINT}" 2>/dev/null) || {
    echo "Warning: Could not fetch model list, skipping paid-check" >&2
    return 0
  }

  local paid
  paid=$(echo "$model_data" | jq -r --arg m "$model" '
    .[] | select(.name == $m) | .paid_only // false
  ')

  if [[ "$paid" == "true" ]]; then
    echo "Error: Model '$model' is paid-only. Use --list-models to see free options." >&2
    exit 1
  fi

  # Check image input support if --image is provided
  if [[ -n "$IMAGE_URL" ]]; then
    local supports_image
    supports_image=$(echo "$model_data" | jq -r --arg m "$model" '
      .[] | select(.name == $m) | .input_modalities // [] | contains(["image"])
    ')

    if [[ "$supports_image" != "true" ]]; then
      echo "Error: Model '$model' does not support image input. Cannot use --image." >&2
      echo "Models with image input support:" >&2
      echo "$model_data" | jq -r '
        .[] | select((.paid_only // false) == false)
        | select(.input_modalities // [] | contains(["image"]))
        | "  \(.name)"
      ' >&2
      exit 1
    fi
  fi
}

validate_model "$MODEL"

# --- Build output path ---
if [[ -z "$OUTPUT_PATH" ]]; then
  TIMESTAMP=$(date +%Y%m%d_%H%M%S)
  OUTPUT_PATH="/workspace/group/generated-${TIMESTAMP}.jpg"
fi

mkdir -p "$(dirname "$OUTPUT_PATH")"

# --- Build the URL ---
# URL-encode via python3 stdin to handle any special chars safely
ENCODED_PROMPT=$(printf '%s' "$PROMPT" | python3 -c "import sys, urllib.parse; print(urllib.parse.quote(sys.stdin.read().strip(), safe=''))")

URL="${IMAGE_ENDPOINT}/${ENCODED_PROMPT}?model=${MODEL}&seed=-1&safe=false"

if [[ -n "$NEGATIVE_PROMPT" ]]; then
  ENCODED_NEG=$(printf '%s' "$NEGATIVE_PROMPT" | python3 -c "import sys, urllib.parse; print(urllib.parse.quote(sys.stdin.read().strip(), safe=''))")
  URL="${URL}&negative_prompt=${ENCODED_NEG}"
fi

if [[ "$ENHANCE" == "true" ]]; then
  URL="${URL}&enhance=true"
fi

if [[ -n "$IMAGE_URL" ]]; then
  ENCODED_IMG=$(printf '%s' "$IMAGE_URL" | python3 -c "import sys, urllib.parse; print(urllib.parse.quote(sys.stdin.read().strip(), safe=''))")
  URL="${URL}&image=${ENCODED_IMG}"
fi

# --- Call the API ---
echo "Generating image with model: ${MODEL}"
echo "Prompt: ${PROMPT}"
[[ -n "$NEGATIVE_PROMPT" ]] && echo "Negative prompt: ${NEGATIVE_PROMPT}"
[[ "$ENHANCE" == "true" ]] && echo "Enhancement: enabled"
[[ -n "$IMAGE_URL" ]] && echo "Reference image: ${IMAGE_URL}"

HTTP_CODE=$(curl -sf -o "$OUTPUT_PATH" -w '%{http_code}' \
  -H "Authorization: Bearer ${API_KEY}" \
  "$URL") || {
    # curl failed entirely (network error, timeout, etc.)
    rm -f "$OUTPUT_PATH" 2>/dev/null
    echo "Error: Request failed (network error or timeout)" >&2
    exit 1
  }

# Check for non-200 responses where curl wrote an error body
if [[ "$HTTP_CODE" != "200" ]]; then
  # Try to read error details from the output file
  ERROR_BODY=$(head -c 2000 "$OUTPUT_PATH" 2>/dev/null || echo "")
  rm -f "$OUTPUT_PATH" 2>/dev/null

  echo "Error: API returned HTTP ${HTTP_CODE}" >&2
  if [[ -n "$ERROR_BODY" ]]; then
    # Try to extract JSON error message
    MSG=$(echo "$ERROR_BODY" | jq -r '.error.message // empty' 2>/dev/null)
    if [[ -n "$MSG" ]]; then
      echo "  ${MSG}" >&2
    else
      echo "  ${ERROR_BODY}" >&2
    fi
  fi
  exit 1
fi

# --- Verify output is actually an image ---
FILE_TYPE=$(file -b "$OUTPUT_PATH" 2>/dev/null | head -1)
if [[ -n "$FILE_TYPE" ]] && ! echo "$FILE_TYPE" | grep -qi "image\|JPEG\|PNG\|WebP\|GIF"; then
  echo "Warning: Output doesn't appear to be an image (${FILE_TYPE})" >&2
  # Keep the file anyway — might be a valid format file didn't recognize
fi

# --- Output result ---
FILESIZE=$(stat -f%z "$OUTPUT_PATH" 2>/dev/null || stat -c%s "$OUTPUT_PATH" 2>/dev/null || echo "unknown")

echo ""
echo "--- Result ---"
echo "File: ${OUTPUT_PATH}"
echo "Size: ${FILESIZE} bytes"
echo "Type: ${FILE_TYPE:-unknown}"
echo "Model: ${MODEL}"
echo "Prompt: ${PROMPT}"
