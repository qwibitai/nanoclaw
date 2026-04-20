---
name: add-company-kb
description: Wire the Alma Labs internal knowledge base MCP into the assistant. Almanda will consult it before WebSearch for any company-related question. Requires an Alma Library API key.
---

# Add Company Knowledge Base

Connects the `alma-library` HTTP MCP so Almanda answers internal company questions from the team's GitHub, Slack, and Google Drive.

## Prerequisites
- NanoClaw v1 set up (`/setup` complete)
- `/add-almanda-core` installed
- Alma Library API key (obtain from the Alma Labs internal tools admin)

## Installation

### 1. Merge the skill branch
```bash
git merge feature/v2-mcp-bundle --no-edit
# or cherry-pick the Phase 1 commit if merging the full bundle at once
```

### 2. Add API key to .env
```bash
echo "ALMA_LIBRARY_API_KEY=<your-key>" >> .env
```

### 3. Rebuild and restart
```bash
./container/build.sh && npm run build
rm -rf data/sessions/*/agent-runner-src/
launchctl kickstart -k gui/$(id -u)/com.nanoclaw  # macOS
# Linux: systemctl --user restart nanoclaw
```

### 4. Verify
Ask Almanda: "Who is Andrey Oleynik?"
Expected: response cites Alma KB, not Wikipedia or web search.

Ask: "Who invented the transistor?"
Expected: uses WebSearch (not internal).

## Troubleshooting
- "MCP not loading": check container logs for `alma-library` registration line
- "Empty results": verify API key is correct in .env
- "Wrong tool used": confirm `/company-kb` skill is in `container/skills/` — rebuild container
