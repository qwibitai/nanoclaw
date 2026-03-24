---
name: test-pr
description: "Test a NanoClaw upstream PR safely in a worktree, rebuild if needed, then write a test report. Use when Scott says 'test PR #1234' or 'review PR'."
---

# Test a NanoClaw PR

Safely test an upstream PR against our customized NanoClaw install, then write a test report.

## Usage

`/test-pr <number>` — e.g., `/test-pr 1157`

If no number given, use `AskUserQuestion` to ask which PR.

## Safety Rules

- **NEVER** checkout a PR branch on `~/NanoClaw` directly
- **NEVER** `git stash` on the main repo
- **ALWAYS** use a git worktree at `/tmp/pr-<number>`
- **ALWAYS** back up the container image before rebuilding (tag it)
- After testing, **restore the original container image** so NanoClaw returns to normal

## Phase 1: Understand the PR

```bash
gh pr view <NUMBER> --repo qwibitai/nanoclaw --json title,state,author,body,labels
gh pr diff <NUMBER> --repo qwibitai/nanoclaw --name-only
```

Show Scott:
- Title, author, state
- Which files change
- Brief summary of what the PR does and what to test

Categorize the files changed:
- **Dockerfile changes** → container rebuild required
- **src/ changes** → TypeScript build required
- **container/agent-runner/ changes** → container rebuild required
- **Skills/docs only** → no build needed

## Phase 2: Set Up Worktree

```bash
cd ~/NanoClaw

# Clean any stale worktrees
git worktree prune

# Create worktree from current HEAD (preserves all our customizations)
git worktree add /tmp/pr-<NUMBER> HEAD

# Install deps in worktree
cd /tmp/pr-<NUMBER> && npm install
```

## Phase 3: Apply PR Changes

Fetch the PR diff and apply it to the worktree. Two approaches depending on complexity:

**Simple (most PRs):** Read the diff and manually apply each change to the worktree files using Edit. This is preferred because it merges the PR's changes with our customizations rather than overwriting.

**Patch-based (clean PRs with no overlap):**
```bash
cd /tmp/pr-<NUMBER>
gh pr diff <NUMBER> --repo qwibitai/nanoclaw | patch -p1
```

If there are conflicts with our customizations, resolve them — keep both our code and the PR's fix.

## Phase 4: Build and Deploy

### If Dockerfile or agent-runner changed:

```bash
# Tag current image as backup
docker tag nanoclaw-agent:latest nanoclaw-agent:pre-pr-<NUMBER>

# Rebuild from worktree
cd /tmp/pr-<NUMBER> && ./container/build.sh
```

### If src/ changed:

Apply the same src/ changes to `~/NanoClaw/src/` (the running install), then:

```bash
cd ~/NanoClaw && npm run build && systemctl --user restart nanoclaw
```

Copy any new non-src files (like seccomp profiles, config files) to `~/NanoClaw/` as well.

### If skills/docs only:

No build needed. Just review the content.

## Phase 5: Test

Tell Scott what to test. Common test scenarios:

- **Browser fix** → "Message Jorgenclaw: open https://example.com with agent-browser"
- **Channel fix** → "Send a message and confirm it arrives/processes correctly"
- **Scheduler fix** → Check task scheduling behavior
- **Container fix** → Verify container spawns and runs correctly

Wait for Scott to confirm the test result. Check logs:

```bash
tail -30 ~/NanoClaw/logs/nanoclaw.log
docker ps --format "{{.Names}} {{.Status}}"
```

## Phase 6: Write Report

Draft the test report following this template:

```markdown
## Test Report — PR #<NUMBER> (<title>)

**Environment:**
- Pop!_OS Linux (bare-metal), Surface Pro 7+, Intel Iris Xe
- Docker 28.x, NanoClaw v<version>
- Container base: `node:22-slim` with Chromium, `agent-browser`
- Tested on top of a customized install (Signal/WhiteNoise/NostrDM channels, custom tools)

**What we tested:**
<What was done, step by step>

**Result: ✅ Pass / ❌ Fail**

<Bullet points of observations>

**Notes:**
<Any observations about code quality, edge cases, or suggestions>

Tested by @jorgenclaw (Scott Jorgensen + Claude Code). cc @GabiSimons
```

Show the draft to Scott. **Do not post until Scott approves.**

Post with:
```bash
gh pr comment <NUMBER> --repo qwibitai/nanoclaw --body "<report>"
```

## Phase 7: Clean Up

```bash
# Remove worktree
cd ~/NanoClaw && git worktree remove /tmp/pr-<NUMBER> --force

# If container was rebuilt, restore original image
docker tag nanoclaw-agent:pre-pr-<NUMBER> nanoclaw-agent:latest
docker rmi nanoclaw-agent:pre-pr-<NUMBER>

# Rebuild our container to restore our Dockerfile customizations
cd ~/NanoClaw && ./container/build.sh

# If src/ was modified for testing, revert those changes
cd ~/NanoClaw && git checkout src/
npm run build
systemctl --user restart nanoclaw
```

Verify NanoClaw is back to normal:
```bash
systemctl --user status nanoclaw --no-pager | grep Active
```

## Keeping the Fix

If Scott wants to keep the PR's changes (not just test them):

```bash
# Skip the restore steps above
# Instead, commit the changes
cd ~/NanoClaw
git add <changed files>
git commit -m "feat: apply PR #<NUMBER> — <title>"
```
