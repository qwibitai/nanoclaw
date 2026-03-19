#!/bin/bash

# Share Visual Explainer HTML via Vercel
# Usage: ./share.sh <html-file>
# Returns: Live URL instantly (no auth required)

set -e

RED='\033[0;31m'
GREEN='\033[0;32m'
CYAN='\033[0;36m'
NC='\033[0m'

HTML_FILE="${1}"

if [ -z "$HTML_FILE" ]; then
    echo -e "${RED}Error: Please provide an HTML file to share${NC}" >&2
    echo "Usage: $0 <html-file>" >&2
    exit 1
fi

if [ ! -f "$HTML_FILE" ]; then
    echo -e "${RED}Error: File not found: $HTML_FILE${NC}" >&2
    exit 1
fi

# Find vercel-deploy skill
VERCEL_SCRIPT=""
for dir in ~/.pi/agent/skills/vercel-deploy/scripts /mnt/skills/user/vercel-deploy/scripts; do
    if [ -f "$dir/deploy.sh" ]; then
        VERCEL_SCRIPT="$dir/deploy.sh"
        break
    fi
done

if [ -z "$VERCEL_SCRIPT" ]; then
    echo -e "${RED}Error: vercel-deploy skill not found${NC}" >&2
    echo "Install it with: pi install npm:vercel-deploy" >&2
    exit 1
fi

# Create temp directory with index.html
TEMP_DIR=$(mktemp -d)
trap 'rm -rf "$TEMP_DIR"' EXIT

# Copy file as index.html (Vercel serves index.html at root)
cp "$HTML_FILE" "$TEMP_DIR/index.html"

echo -e "${CYAN}Sharing $(basename "$HTML_FILE")...${NC}" >&2

# Deploy via vercel-deploy skill
# Temporarily disable errexit to capture deployment errors
set +e
RESULT=$(bash "$VERCEL_SCRIPT" "$TEMP_DIR" 2>&1)
DEPLOY_EXIT=$?
set -e

if [ $DEPLOY_EXIT -ne 0 ]; then
    echo -e "${RED}Error: Deployment failed${NC}" >&2
    echo "$RESULT" >&2
    exit 1
fi

# Extract preview URL
PREVIEW_URL=$(echo "$RESULT" | grep -oE 'https://[^"]+\.vercel\.app' | head -1)
CLAIM_URL=$(echo "$RESULT" | grep -oE 'https://vercel\.com/claim-deployment[^"]+' | head -1)

if [ -z "$PREVIEW_URL" ]; then
    echo -e "${RED}Error: Deployment failed${NC}" >&2
    echo "$RESULT" >&2
    exit 1
fi

echo "" >&2
echo -e "${GREEN}✓ Shared successfully!${NC}" >&2
echo "" >&2
echo -e "${GREEN}Live URL:  ${PREVIEW_URL}${NC}" >&2
echo -e "${CYAN}Claim URL: ${CLAIM_URL}${NC}" >&2
echo "" >&2

# Output JSON for programmatic use (extract from vercel-deploy output)
echo "$RESULT" | grep -E '^\{' | head -1
