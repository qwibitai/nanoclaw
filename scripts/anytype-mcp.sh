#!/usr/bin/env bash
# Wrapper for @anyproto/anytype-mcp
# ANYTYPE_API_KEY is injected via container.json mcpServers env — never hardcoded here.

set -euo pipefail

: "${ANYTYPE_API_KEY:?ANYTYPE_API_KEY is not set}"
: "${ANYTYPE_API_BASE_URL:?ANYTYPE_API_BASE_URL is not set}"

export OPENAPI_MCP_HEADERS="{\"Authorization\":\"Bearer ${ANYTYPE_API_KEY}\", \"Anytype-Version\":\"2025-11-08\"}"

exec npx -y @anyproto/anytype-mcp
