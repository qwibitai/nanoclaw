---
name: add-github-ops
description: Connect GitHub to Almanda — search code, read files, browse PRs and issues freely; open PRs, comment, and push only with user approval. Requires a GitHub personal access token.
---

# Add GitHub Operations

Adds read + write access to GitHub repositories for the Alma Labs organization.

## Prerequisites
- `/add-almanda-core` installed
- GitHub PAT with scopes: `repo`, `read:user`, `read:org`
  Create at: https://github.com/settings/tokens

## Installation

### 1. Merge the skill branch
```bash
git merge feature/v2-mcp-bundle --no-edit
```

### 2. Add token to .env
```bash
echo "GITHUB_PERSONAL_ACCESS_TOKEN=github_pat_..." >> .env
```

### 3. Rebuild and restart
```bash
./container/build.sh && npm run build
rm -rf data/sessions/*/agent-runner-src/
launchctl kickstart -k gui/$(id -u)/com.nanoclaw  # macOS
```

### 4. Verify
Ask: "Find all TypeScript files that use the auth middleware"
Expected: searches code, returns results, no approval prompt.

Ask: "Open a PR from my branch to main"
Expected: Almanda describes the PR and asks "Should I go ahead?"

## Notes
- Uses `@modelcontextprotocol/server-github` via `npx` — downloaded on first container run
- Fine-grained PATs can scope to specific repos for tighter security
