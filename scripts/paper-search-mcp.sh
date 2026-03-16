#!/bin/bash
# Run paper-search-mcp as a Streamable HTTP server on port 3002
# Containers connect via http://host.docker.internal:3002/mcp
cd /Users/jialingwu/nanoclaw/store/paper-search

export SEMANTIC_SCHOLAR_API_KEY="${SEMANTIC_SCHOLAR_API_KEY:-}"

exec .venv/bin/python3 -c "
import uvicorn
from paper_search_mcp.server import mcp
app = mcp.streamable_http_app()
uvicorn.run(app, host='0.0.0.0', port=3002, log_level='warning')
" "$@"
