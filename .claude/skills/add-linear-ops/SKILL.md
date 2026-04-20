---
name: add-linear-ops
description: Connect Linear to Almanda — read issues, projects, cycles, and teams freely; create or update issues with user approval. Requires a Linear personal API key.
---

# Add Linear Operations

Adds read + write access to Alma Labs' Linear workspace.

## Prerequisites
- `/add-almanda-core` installed (operating rules enforce write approval)
- Linear personal API key from https://linear.app/settings/api

## Installation

### 1. Merge the skill branch
```bash
git merge feature/v2-mcp-bundle --no-edit
```

### 2. Add API key to .env
```bash
echo "LINEAR_API_TOKEN=lin_api_..." >> .env
```

### 3. Rebuild and restart
```bash
./container/build.sh && npm run build
rm -rf data/sessions/*/agent-runner-src/
launchctl kickstart -k gui/$(id -u)/com.nanoclaw  # macOS
```

### 4. Verify
Ask Almanda: "What Linear issues are assigned to me?"
Expected: lists open issues, no approval prompt.

Ask: "Create a Linear issue: test the integration"
Expected: Almanda describes the issue and asks "Should I go ahead?" before creating.

## Notes
- Uses `@tacticlaunch/mcp-linear` via `npx` — downloaded on first container run (requires outbound internet)
- Personal API key has full account access; consider a service account for production
