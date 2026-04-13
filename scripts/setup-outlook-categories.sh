#!/bin/bash
# One-time setup: create the master category list in Outlook with colors
# that match the COO filter vocabulary. Run this once per mailbox.
# Idempotent: creates categories that don't exist, skips ones that do.

set -e

TOKENS_PATH="/Users/gabrielratner/.outlook-mcp-tokens.json"
ACCESS_TOKEN=$(python3 -c "import json; print(json.load(open('$TOKENS_PATH'))['access_token'])")

# Valid color presets: preset0..preset24
# Chosen for visual hierarchy:
#   CRITICAL         = preset0  (red)
#   APPROVAL         = preset5  (orange)
#   DELEGATE         = preset6  (yellow)
#   WAITING FOR REPLY = preset3 (purple)
#   FYI              = preset9  (teal)

create_category() {
    local name="$1"
    local color="$2"
    echo "Creating: $name ($color)"
    curl -s -X POST "https://graph.microsoft.com/v1.0/me/outlook/masterCategories" \
        -H "Authorization: Bearer $ACCESS_TOKEN" \
        -H "Content-Type: application/json" \
        -d "{\"displayName\":\"$name\",\"color\":\"$color\"}" \
        | python3 -c "
import json, sys
try:
    data = json.loads(sys.stdin.read())
    if 'error' in data:
        msg = data['error'].get('message', '')
        if 'already exists' in msg.lower() or 'conflict' in msg.lower() or 'ErrorObjectAlreadyExists' in msg:
            print('  already exists, skipping')
        else:
            print(f'  error: {msg}')
    else:
        print(f'  created: id={data.get(\"id\", \"?\")}')
except Exception as e:
    print(f'  parse error: {e}')
"
}

echo "Setting up master categories for $(python3 -c "import json; import base64; t=json.load(open('$TOKENS_PATH'))['access_token'].split('.')[1]; t+='='*(-len(t)%4); print(json.loads(base64.b64decode(t))['unique_name'])")"
echo ""

create_category "CRITICAL" "preset0"
create_category "APPROVAL" "preset5"
create_category "DELEGATE" "preset6"
create_category "WAITING FOR REPLY" "preset3"
create_category "FYI" "preset9"

echo ""
echo "Done. Listing all master categories to verify:"
curl -s -X GET "https://graph.microsoft.com/v1.0/me/outlook/masterCategories" \
    -H "Authorization: Bearer $ACCESS_TOKEN" \
    | python3 -c "
import json, sys
data = json.loads(sys.stdin.read())
for cat in data.get('value', []):
    print(f'  {cat[\"displayName\"]:20s} {cat[\"color\"]}')
"
