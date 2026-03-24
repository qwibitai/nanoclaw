---
name: test-pr
description: "Safely test a NanoClaw upstream PR in a git worktree, rebuild if needed, then draft a test report. Use when the user says 'test PR #1234' or 'review PR'."
---

# Test a NanoClaw PR

Safely test an upstream PR against the user's NanoClaw install without risking their customizations, then write a structured test report.

## Usage

`/test-pr <number>` — e.g., `/test-pr 1157`

If no number given, use `AskUserQuestion` to ask which PR.

## Safety Rules

- **NEVER** checkout a PR branch directly on the user's NanoClaw directory
- **NEVER** use `git stash` on the main repo — this has corrupted customizations in the past
- **ALWAYS** use a git worktree at `/tmp/pr-<number>` for isolation
- **ALWAYS** tag the container image before rebuilding so it can be restored
- After testing, **restore the original state** unless the user explicitly says to keep the fix

## Phase 1: Understand the PR

```bash
gh pr view <NUMBER> --repo qwibitai/nanoclaw --json title,state,author,body,labels
gh pr diff <NUMBER> --repo qwibitai/nanoclaw --name-only
gh pr diff <NUMBER> --repo qwibitai/nanoclaw
```

Present to the user:
- Title, author, current state
- Which files change and a plain-language summary of what the PR does
- What needs to be tested

Categorize the changes to determine build requirements:
- **Dockerfile changes** → container image rebuild required
- **`src/` changes** → TypeScript build required
- **`container/agent-runner/` changes** → container image rebuild required
- **Skills or docs only** → no build needed

## Phase 2: Set Up Worktree

```bash
cd ~/NanoClaw   # or wherever the user's NanoClaw lives

# Clean any stale worktrees from previous test runs
git worktree prune

# Create worktree from current HEAD (preserves all customizations)
git worktree add /tmp/pr-<NUMBER> HEAD

# Install dependencies in the worktree
cd /tmp/pr-<NUMBER> && npm install
```

## Phase 3: Apply PR Changes

Read the full diff and apply each change to the worktree. Two approaches:

**Manual (preferred for PRs that touch files the user has customized):** Read the diff and use Edit to merge the PR's changes with the user's existing code. This preserves customizations.

**Patch (for clean PRs with no overlap):**
```bash
cd /tmp/pr-<NUMBER>
gh pr diff <NUMBER> --repo qwibitai/nanoclaw | patch -p1
```

If there are conflicts with the user's customizations, resolve them — keep both.

## Phase 4: Build and Deploy

### If Dockerfile or agent-runner changed:

```bash
# Back up current container image
docker tag nanoclaw-agent:latest nanoclaw-agent:pre-pr-<NUMBER>

# Rebuild from worktree
cd /tmp/pr-<NUMBER> && ./container/build.sh
```

### If `src/` changed:

Apply the same `src/` changes to the user's main NanoClaw install (not just the worktree), then:

```bash
cd ~/NanoClaw && npm run build
```

Copy any new non-src files (config files, seccomp profiles, etc.) to the main install as well.

Restart NanoClaw:
```bash
# Linux (systemd)
systemctl --user restart nanoclaw

# macOS (launchd)
launchctl kickstart -k gui/$(id -u)/com.nanoclaw
```

### If skills or docs only:

No build needed. Review the content with the user.

## Phase 5: Test

Tell the user what to test based on the PR's changes. Examples:

- **Browser fix** → "Message your agent: open https://example.com with agent-browser"
- **Channel fix** → "Send a message and confirm it arrives and processes correctly"
- **Scheduler fix** → Run the relevant tests: `npx vitest run src/task-scheduler.test.ts`
- **Container fix** → "Send any message to trigger a container spawn and check logs"

Check logs and container status:
```bash
tail -30 ~/NanoClaw/logs/nanoclaw.log
docker ps --format "{{.Names}} {{.Status}}"
```

Wait for the user to confirm the result.

## Phase 6: Write Report

Draft the test report:

```markdown
## Test Report — PR #<NUMBER> (<title>)

**Environment:**
- <OS, hardware>
- Docker <version>, NanoClaw v<version>
- Container base: `node:22-slim` with Chromium, `agent-browser`
- <Note any relevant customizations>

**What we tested:**
<What was done, step by step>

**Result: ✅ Pass / ❌ Fail**

<Bullet points of observations>

**Notes:**
<Code quality observations, edge cases, or suggestions>

Tested by @<github-user>. cc @GabiSimons
```

Show the draft to the user. **Do not post until the user approves.**

```bash
gh pr comment <NUMBER> --repo qwibitai/nanoclaw --body "<approved report>"
```

## Phase 7: Clean Up

### If the user does NOT want to keep the fix:

```bash
# Remove worktree
cd ~/NanoClaw && git worktree remove /tmp/pr-<NUMBER> --force

# Restore container image if it was rebuilt
docker tag nanoclaw-agent:pre-pr-<NUMBER> nanoclaw-agent:latest
docker rmi nanoclaw-agent:pre-pr-<NUMBER>
cd ~/NanoClaw && ./container/build.sh   # rebuild with user's Dockerfile

# Revert any src/ changes applied for testing
cd ~/NanoClaw && git checkout src/
npm run build
systemctl --user restart nanoclaw   # or launchctl equivalent on macOS
```

### If the user DOES want to keep the fix:

```bash
# Remove worktree (changes are already in the main install)
cd ~/NanoClaw && git worktree remove /tmp/pr-<NUMBER> --force

# Clean up backup image
docker rmi nanoclaw-agent:pre-pr-<NUMBER> 2>/dev/null
```

Verify NanoClaw is running normally either way:
```bash
systemctl --user status nanoclaw   # Linux
# or: launchctl print gui/$(id -u)/com.nanoclaw   # macOS
```
