#!/bin/bash
# Research lookup via OpenRouter Perplexity Sonar
# Usage: ./lookup.sh "query" [model]
# Models: perplexity/sonar-pro (default), perplexity/sonar-reasoning-pro

QUERY="$1"
MODEL="${2:-perplexity/sonar-pro}"

if [ -z "$OPENROUTER_API_KEY" ]; then
  echo "Error: OPENROUTER_API_KEY not set" >&2
  exit 1
fi

curl -s "https://openrouter.ai/api/v1/chat/completions" \
  -H "Authorization: Bearer $OPENROUTER_API_KEY" \
  -H "Content-Type: application/json" \
  -d "{
    \"model\": \"$MODEL\",
    \"messages\": [{\"role\": \"user\", \"content\": \"$QUERY\"}]
  }" | jq -r '.choices[0].message.content // .error.message // "No response"'
