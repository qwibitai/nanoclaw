# Self-Edit: Modify NanoClaw Source Code via PR Workflow

When the user asks you to add a feature, fix a bug, or change NanoClaw's behavior, use this workflow. Changes go through a PR review process — the live system always runs stable `main`.

## Safety Rules

- **NEVER** edit files directly in `/workspace/project/src/` — that's the live code
- **ALWAYS** work in a git worktree (separate directory, shares `.git`, keeps live `main` untouched)
- **ALWAYS** validate (`tsc --noEmit` + `vitest run`) before committing
- If validation fails, fix the issues before creating the PR
- **New features MUST be packaged as skills** (see "Packaging as a Skill" below)
- Bug fixes and internal refactors can be raw code changes

## Workflow

### Step 1: Understand the Change

Read the relevant source files in `/workspace/project/` to understand what needs to change. Don't modify anything yet — just read.

### Step 2: Create a Worktree

```bash
cd /workspace/project
BRANCH_NAME="feat/short-description"  # or "fix/short-description" for bug fixes
git worktree add .worktrees/$BRANCH_NAME -b $BRANCH_NAME
cd .worktrees/$BRANCH_NAME
```

### Step 3: Set HTTPS Push URL

The remote is SSH but the container has `GH_TOKEN` instead of SSH keys:

```bash
git remote set-url origin "https://x-access-token:${GH_TOKEN}@github.com/tglowaski/nanoclaw.git"
```

### Step 4: Determine Change Type

**New feature or capability** → Package as a skill (Step 5a)
**Bug fix or internal refactor** → Make raw code changes (Step 5b)

### Step 5a: Package as a Skill (for new features)

New features must follow NanoClaw's "skills not features" philosophy. Create a skill package:

```
.claude/skills/{feature-name}/
├── manifest.yaml          # Declares adds/modifies/dependencies
├── SKILL.md               # Usage instructions for the skill
├── add/                   # New files
│   └── src/new-file.ts
├── modify/                # Base copies of files to modify
│   ├── src/existing-file.ts
│   └── src/existing-file.ts.intent.md
```

**manifest.yaml format:**
```yaml
skill: feature-name
version: 1.0.0
description: "What the feature does"
core_version: 0.1.0
adds:
  - src/new-file.ts
modifies:
  - src/existing-file.ts
structured:
  npm_dependencies:
    some-package: "^1.0.0"
  env_additions:
    - NEW_ENV_VAR
conflicts: []
depends: []
test: "npx vitest run src/new-file.test.ts"
```

Use existing skills (e.g., `.claude/skills/add-telegram/`) as structural templates.

After creating the skill, test it:
```bash
npx tsx scripts/apply-skill.ts .claude/skills/{feature-name}
```

### Step 5b: Raw Code Changes (for bug fixes)

Edit source files directly in the worktree. The worktree has its own copy of all files — changes here don't affect `/workspace/project/`.

### Step 6: Validate

```bash
npm install
npx tsc --noEmit
npx vitest run
```

If validation fails, fix the issues and re-validate. Do not proceed until both pass.

### Step 7: Commit and Push

```bash
git add -A
git commit -m "feat: short description of the change

Longer explanation if needed."
git push -u origin $BRANCH_NAME
```

### Step 8: Create PR

Use the GitHub CLI (authenticated via `GH_TOKEN`):

```bash
gh pr create \
  --repo tglowaski/nanoclaw \
  --title "feat: short description" \
  --body "## Summary

- What changed and why

## Testing

- How to verify the change works"
```

Capture the PR number from the output.

### Step 9: Clean Up Worktree

```bash
cd /workspace/project
git worktree remove .worktrees/$BRANCH_NAME
```

### Step 10: Notify User

Send the PR URL to the user via `send_message`:

```
Created PR #N for your request: https://github.com/tglowaski/nanoclaw/pull/N

I've set up automatic monitoring — when you merge it, I'll pull the changes and restart automatically.
```

### Step 11: Schedule Merge Poll

Schedule an interval task to check if the PR gets merged:

Write an IPC task file:
```bash
cat > /workspace/ipc/tasks/merge_poll_$(date +%s).json << 'TASKEOF'
{
  "type": "schedule_task",
  "prompt": "Check if PR #N in tglowaski/nanoclaw is merged. Run: gh api repos/tglowaski/nanoclaw/pulls/N --jq '.merged'. If the result is 'true', trigger a self-update by writing: echo '{\"type\": \"self_update\"}' > /workspace/ipc/tasks/self_update_$(date +%s).json — then cancel this task by writing: echo '{\"type\": \"cancel_task\", \"taskId\": \"TASK_ID_PLACEHOLDER\"}' > /workspace/ipc/tasks/cancel_$(date +%s).json. If the PR has been open for more than 24 hours (check created_at), send the user a reminder and cancel this task. If still open and under 24h, do nothing.",
  "schedule_type": "interval",
  "schedule_value": "300000",
  "context_mode": "isolated",
  "targetJid": "TARGET_JID"
}
TASKEOF
```

Replace `N` with the PR number and `TARGET_JID` with the current chat JID from the environment.

## Quick Reference

| Step | Command | Purpose |
|------|---------|---------|
| Create worktree | `git worktree add .worktrees/<branch> -b <branch>` | Isolated working directory |
| Set push URL | `git remote set-url origin https://x-access-token:${GH_TOKEN}@github.com/tglowaski/nanoclaw.git` | HTTPS auth for push |
| Validate | `npx tsc --noEmit && npx vitest run` | Catch errors before PR |
| Create PR | `gh pr create --repo tglowaski/nanoclaw` | Submit for review |
| Clean up | `git worktree remove .worktrees/<branch>` | Remove worktree |
| Self-update | IPC `{"type": "self_update"}` | Pull + rebuild + restart |
