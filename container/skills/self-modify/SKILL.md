---
name: self-modify
description: >
  Create a pull request to modify NanoClaw's own source code.
  Use when the user asks to change NanoClaw's behavior, add features,
  fix bugs, or update configuration. NEVER push directly to main.
---

# Self-Modify -- Create a PR to modify NanoClaw

## Prerequisites

NanoClaw source code is at `/workspace/extra/code/nanoclaw/` (read-only mount of the live repo).
Git and gh CLI are authenticated.

## Rules

1. NEVER push to main. Always create a feature branch and PR.
2. NEVER merge your own PR. The user must review and merge.
3. Always create a PR, even for small changes.
4. Branch protection and a pre-push hook enforce this -- direct pushes to main will be rejected.

## Workflow

### Step 1: Clone to a temporary worktree

The live repo at `/workspace/extra/code/nanoclaw/` runs the active service with auto-update.
**Never checkout feature branches there.** Clone to `/tmp/` instead:

```bash
# Derive the remote URL from the live repo so forks work automatically
ORIGIN_URL=$(git -C /workspace/extra/code/nanoclaw remote get-url origin)
git clone "$ORIGIN_URL" /tmp/nanoclaw-<feature>
cd /tmp/nanoclaw-<feature>
git checkout -b agent/<descriptive-name>
```

Branch naming: `agent/<verb>-<noun>` (e.g., `agent/add-discord-channel`, `agent/fix-scheduler-drift`).

### Step 2: Make changes

Edit files as needed. Source is in `src/`. After editing:

```bash
npm install   # ensure dependencies are present
npx tsc --noEmit       # verify TypeScript compiles
npx vitest run         # run tests (if they exist)
npx prettier --write "src/**/*.ts"  # format
```

### Step 3: Commit

```bash
git add <specific-files>
git commit -m "feat: <description>"
```

Use conventional commits: `feat:`, `fix:`, `refactor:`, `docs:`, `test:`.

### Step 4: Push and create PR

```bash
git push origin agent/<branch-name>
gh pr create \
  --title "<Short title>" \
  --body "## What
<Description of changes>

## Why
<Motivation>

## Testing
<How it was tested>

---
Created by NanoClaw agent via /self-modify" \
  --base main
```

### Step 5: Report to user

Tell the user:
- What was changed and why
- Link to the PR
- That they need to review and merge
- NanoClaw will auto-restart after merge (with changelog in the restart notification)

### Step 6: Address review feedback

If the user or CI reports issues:
- Re-clone if the `/tmp/` directory was cleaned up
- Checkout the existing branch, fix issues, push
- Notify the user that fixes have been pushed

### Step 7: Clean up

After the PR is merged (or abandoned), remove the temporary clone:

```bash
rm -rf /tmp/nanoclaw-<feature>
```

## After Merge

NanoClaw polls origin/main every 60 seconds. After the user merges:
1. Auto-detects new commits
2. Quiesces the queue (waits for running containers to drain, up to 3 minutes)
3. Runs `git pull --ff-only` and `npm run build`
4. Writes a human-readable changelog
5. Restarts (launchd respawns)
6. Sends a restart notification with the changelog to the main group

No manual action needed from the user after merging.
