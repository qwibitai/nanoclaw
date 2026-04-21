---
name: add-github
description: Add GitHub skill to container agents. Installs gh CLI in the container, passes GITHUB_TOKEN via stdin, and adds the agent-github skill doc so agents can manage issues, PRs, and code review.
---

# Add GitHub Skill

This skill gives container agents access to the GitHub CLI (`gh`) for managing issues, pull requests, and code review.

## Phase 1: Pre-flight

### Check if already applied

Read `.nanoclaw/state.yaml`. If `github` is in `applied_skills`, skip to Phase 3 (Configure). The code changes are already in place.

### Ask the user

Use `AskUserQuestion` to collect the GitHub token:

AskUserQuestion: Do you have a GitHub personal access token, or do you need to create one?

If they have one, collect it now. If not, guide them in Phase 3.

## Phase 2: Apply Code Changes

### Initialize skills system (if needed)

If `.nanoclaw/` directory doesn't exist yet:

```bash
npx tsx scripts/apply-skill.ts --init
```

### Apply the skill

```bash
npx tsx scripts/apply-skill.ts .claude/skills/add-github
```

This deterministically:
- Adds `container/skills/agent-github/SKILL.md` (agent-facing GitHub CLI docs)
- Three-way merges `gh` CLI installation into `container/Dockerfile`
- Three-way merges `GITHUB_TOKEN` and `GH_REPO` into `readSecrets()` in `src/container-runner.ts`
- Records the application in `.nanoclaw/state.yaml`

If the apply reports merge conflicts, read the intent files:
- `modify/container/Dockerfile.intent.md` — what changed for the Dockerfile
- `modify/src/container-runner.ts.intent.md` — what changed for container-runner.ts

### Validate

```bash
npm run build
```

Build must be clean before proceeding.

## Phase 3: Configure Token and Repository

### Step 1: Ask for token or guide creation

Use `AskUserQuestion`:

AskUserQuestion: Do you have a GitHub personal access token already, or do you need to create one?

If they need to create one, tell them:

> Create a GitHub personal access token (classic):
>
> 1. Go to https://github.com/settings/tokens/new
> 2. **Note**: `NanoClaw agent` (or whatever you like)
> 3. **Expiration**: 90 days (recommended) or "No expiration"
> 4. **Scopes**: select `repo` (full repo access — covers issues, PRs, code, status)
> 5. Click **Generate token** and copy it immediately (you can only see it once)
>
> The token will start with `ghp_...`. Paste it here when you have it.

Wait for the user to provide the token.

### Step 2: Ask for target repository

Use `AskUserQuestion`:

AskUserQuestion: Which GitHub repository should the agent manage? (format: `owner/repo`)

### Step 3: Add to `.env`

Add both values to `.env`:

```bash
GITHUB_TOKEN=ghp_...
GH_REPO=owner/repo
```

`GH_REPO` sets the default repository so the agent doesn't need `--repo` on every command.

### Step 4: Sync env and restart

```bash
npm run build
./container/build.sh
rm -r data/sessions/*/agent-runner-src 2>/dev/null || true
launchctl kickstart -k gui/$(id -u)/com.nanoclaw  # macOS
# Linux: systemctl --user restart nanoclaw
```

## Phase 4: Verify

### Test the connection

Tell the user:

> GitHub is connected! Send this in your main channel:
>
> "List the open issues on our repo"

The agent should invoke `gh issue list` and return results.

### Check logs if needed

```bash
tail -f logs/nanoclaw.log
```

## Troubleshooting

### gh: not found

The container needs to be rebuilt with the `gh` CLI:

```bash
./container/build.sh
rm -r data/sessions/*/agent-runner-src 2>/dev/null || true
launchctl kickstart -k gui/$(id -u)/com.nanoclaw
```

### gh: authentication required

- Check `GITHUB_TOKEN` is set in `.env`
- Restart NanoClaw

### Rate limit exceeded

GitHub allows 5,000 requests/hour with token auth. If hitting limits, the agent is likely making too many API calls in a loop.

## Removal

1. Delete `container/skills/agent-github/SKILL.md`
2. Remove `gh` installation block from `container/Dockerfile`
3. Remove `GITHUB_TOKEN` and `GH_REPO` from `readSecrets()` in `src/container-runner.ts`
4. Remove `GITHUB_TOKEN` and `GH_REPO` from `.env`
5. Remove `github` from `.nanoclaw/state.yaml`
6. Rebuild: `./container/build.sh && npm run build && launchctl kickstart -k gui/$(id -u)/com.nanoclaw`
