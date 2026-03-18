# Hook Migration Plan: Claude Hooks → Portable Enforcement

## Problem

NanoClaw's development policies (worktree isolation, test coverage, PR review, verification) are currently enforced exclusively through Claude Code hooks. This creates three problems:

1. **Not portable** — policies don't apply to Codex, humans, or other agents
2. **Fragile parsing** — hooks regex-match Bash command strings; `bash -c "gh pr create"` or piped commands bypass them
3. **State management** — review loop uses temp files with branch-scoped isolation, a workaround for lacking native session state

## Migration Strategy

Move **enforcement** to portable layers (CI, git hooks, architecture). Keep Claude hooks as **advisory early warnings** (exit 0, never deny). This gives fast feedback in Claude sessions while ensuring all contributors hit the real gates.

### Principle: warn early, enforce late

| Layer | Role | Applies to |
|-------|------|-----------|
| Claude hooks | Advisory warnings (exit 0) | Claude sessions only |
| Git hooks (husky) | Pre-commit/pre-push gates | All local contributors |
| CI (GitHub Actions) | Merge gates (required checks) | All PRs, all contributors |
| Architecture (Level 3) | Makes violations impossible | Everyone, always |

## Migration Items (ordered by ROI)

### 1. Move PR policy to CI ✅ (this PR)

**What moves:** Test coverage check, verification section check.

**Current state:**
- `check-test-coverage.sh`: warns on `gh pr create`, blocks `gh pr merge`
- `check-verification.sh`: blocks `gh pr create` without verification section, reminds on merge

**Target state:**
- New CI job `pr-policy` runs on PRs: checks changed source files have test changes, checks PR body has verification section
- CI job is a **required status check** (configure in GitHub branch protection)
- Claude hooks become advisory-only (warn, never block)

**Why this is better:**
- Applies to all contributors (humans, Codex, Claude)
- Source of truth at the merge boundary, not inside one agent's runtime
- Auditable in GitHub (check runs are visible on the PR)
- No fragile Bash command parsing

**What's lost:**
- Immediate feedback on `gh pr create` — now feedback comes ~30s later from CI
- Acceptable tradeoff: the Claude hook still warns immediately

### 2. Move commit/push guards to git hooks ✅ (this PR)

**What moves:** Worktree enforcement for commits and pushes.

**Current state:**
- `enforce-case-worktree.sh`: blocks `git commit`/`git push` outside worktrees (Claude-only)
- `.husky/pre-commit`: formats staged TS files, advisory test coverage warning

**Target state:**
- `.husky/pre-commit`: block ALL commits in main checkout (any branch, not just main)
- `.husky/pre-push`: block ALL pushes from main checkout (defense-in-depth)
- Claude hook becomes advisory-only

**Why block all branches, not just main?** The policy is "dev work happens in worktrees" — the branch name is irrelevant. Consider:

```bash
# In main checkout (the running production instance):
git checkout -b hotfix-typo     # still in main checkout
vim src/config.ts               # editing production files
git add -A && git commit        # if only "main" blocked, this succeeds!
git push -u origin hotfix-typo  # policy violation shipped
```

This violates workspace isolation even though the branch isn't `main`. What matters is **where** the work happens, not what branch it's on. See `.claude/kaizen/README.md` for the full rationale.

Pre-push is defense-in-depth: if pre-commit blocks all commits, there's nothing to push. But it catches `--no-verify` bypass.

**Why this is better:**
- Works for humans and all agents, not just Claude
- Catches at the actual git boundary, not via Bash command string parsing
- Simpler — git hooks are a well-understood mechanism

**What doesn't move:**
- `check-dirty-files.sh` blocks `gh pr create` with dirty files — no git hook equivalent (gh ≠ git)
- `enforce-pr-review.sh` blocks arbitrary commands during review — no git hook equivalent
- These stay as Claude hooks until MCP tools exist (item 3)

### 3. Build MCP workflow tools (future — kaizen ticket)

**What moves:** PR review loop, dirty file checks, structured workflows.

**Target:**
- MCP tools: `create_pr`, `push_code`, `review_pr`, `merge_pr`
- Each tool encapsulates the policy (dirty file check, review gate, verification)
- State lives in the MCP server (in-memory or DB), not temp files
- Raw `gh pr create`/`git push` can be restricted or removed from allowed commands

**Why this is the right next step:**
- Eliminates fragile Bash command parsing entirely
- Natural place for workflow state (no `/tmp/.pr-review-state/` files)
- Solves cross-worktree contamination at the architecture level
- Makes review loop more reliable, not less

**Why not now:**
- Requires MCP server infrastructure
- Need to decide: restrict raw commands (stronger) or keep them (weaker but flexible)?
- Design work needed on tool API surface

### 4. Move workspace isolation to launcher (future — kaizen ticket)

**What moves:** Worktree writes enforcement, session-start WIP check.

**Target:**
- Mandatory launcher script that creates/selects a worktree before starting any agent session
- Main checkout mounted read-only (or source dirs excluded from write permission)
- WIP surfacing happens in the launcher, not a SessionStart hook

**Why last:**
- Most disruptive — changes how sessions start
- MCP tools (item 3) solve 80% of this by making `create_case` the natural entry point
- Design questions: interactive vs. rigid? What about quick exploratory sessions?

## Hooks After Migration

After items 1-2 (this PR):

| Hook | Current role | New role |
|------|-------------|----------|
| `check-test-coverage.sh` | Blocks merge | Advisory only (CI enforces) |
| `check-verification.sh` | Blocks PR create | Advisory only (CI enforces) |
| `enforce-case-worktree.sh` | Blocks commit/push | Advisory only (git hooks enforce) |
| `enforce-worktree-writes.sh` | Blocks source edits | **Unchanged** (no portable equivalent yet) |
| `check-dirty-files.sh` | Blocks push/PR create | **Unchanged** (no git hook equivalent for `gh` commands) |
| `enforce-pr-review.sh` | Blocks commands during review | **Unchanged** (needs MCP, item 3) |
| `pr-review-loop.sh` | Tracks review state | **Unchanged** (needs MCP, item 3) |
| `kaizen-reflect.sh` | Reflection prompts + notifications | **Unchanged** (notification part could move to CI later) |
| `verify-before-stop.sh` | Blocks stop without passing tests | **Unchanged** (no portable equivalent for Stop event) |
| `check-cleanup-on-stop.sh` | Advisory cleanup reminder | **Unchanged** |
| `check-wip.sh` | Advisory WIP surfacing | **Unchanged** (moves with item 4) |

## Branch Protection Configuration

After CI checks are in place, configure GitHub branch protection on `main`:

1. Require status checks to pass: `ci`, `pr-policy`
2. Require branches to be up to date before merging
3. This makes CI the actual enforcement layer — Claude hooks, git hooks, and humans all converge at this gate
