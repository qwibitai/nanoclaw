# kAIzen Agent Control Flow

A kaizen-driven, AI-native development workflow enforcement system. Portable across Claude Code projects.

This document is the canonical reference for the kAIzen system — what it enforces, how it's built, and where every component lives.

## What kAIzen is

kAIzen is a multi-layer enforcement system that ensures AI coding agents follow a disciplined development workflow. It enforces invariants like "dev work happens in worktrees," "PRs get self-reviewed," and "tests exist before merge" — regardless of whether the agent would otherwise skip them.

The goal is not "use Claude hooks." The goal is to preserve workflow invariants with the strongest portable control layer available.

## Desired Flow

1. Start from awareness of existing WIP.
2. Do dev work in an isolated worktree, never in the main checkout.
3. Prevent source-code writes in the main checkout.
4. Before shipping code, make a conscious decision about every dirty file.
5. Before PR creation or merge, think explicitly about tests and verification.
6. After PR creation, force a self-review loop (including requirements verification against the ticket).
7. Before the agent declares completion, run build/test verification.
8. After merge, trigger deployment verification, kaizen reflection, and cleanup.

The mechanisms may change. The flow should not.

## System Inventory

Everything in this directory is part of kAIzen. Components outside this directory that participate in the system are documented as **integration points**.

### Claude Hooks (`hooks/`)

These are registered in `.claude/settings.json` and fire on Claude Code tool-use events.

| Hook | Event | Type | Blocks? | Purpose |
|------|-------|------|---------|---------|
| `check-wip.sh` | SessionStart | Advisory | No | Surface existing WIP at session start |
| `enforce-pr-review.sh` | PreToolUse(Bash) | Gate | Yes | Block non-review commands during PR review |
| `enforce-pr-review-tools.sh` | PreToolUse(Edit/Write/Agent) | Gate | Yes | Block editing/agents during PR review |
| `enforce-pr-review-stop.sh` | Stop | Gate | Yes | Block agent from finishing with pending review |
| `enforce-case-worktree.sh` | PreToolUse(Bash) | Advisory | No | Warn before commit/push outside worktree |
| `enforce-worktree-writes.sh` | PreToolUse(Edit/Write) | Gate | Yes | Block source edits in main checkout |
| `enforce-case-exists.sh` | PreToolUse(Edit/Write) | Gate | Yes | Block source edits in worktrees without a case |
| `check-test-coverage.sh` | PreToolUse(Bash) | Advisory | No | Warn when source changes lack tests |
| `check-verification.sh` | PreToolUse(Bash) | Advisory | No | Warn about missing verification section |
| `check-dirty-files.sh` | PreToolUse(Bash) | Gate | Yes | Block push/PR create with dirty files |
| `verify-before-stop.sh` | Stop | Gate | Yes (if fail) | Run tsc/vitest before agent finishes |
| `check-cleanup-on-stop.sh` | Stop | Advisory | No | Warn about orphaned worktree state |
| `pr-review-loop.sh` | PostToolUse(Bash) | State machine | No | Multi-round PR self-review with state tracking |
| `kaizen-reflect.sh` | PostToolUse(Bash) | State machine | No | Trigger kaizen reflection; set `needs_pr_kaizen` state on PR create and merge |
| `enforce-pr-kaizen.sh` | PreToolUse(Bash) | Gate | Yes | Block non-kaizen commands until kaizen action is complete |
| `pr-kaizen-clear.sh` | PostToolUse(Bash) | State machine | No | Clear PR kaizen gate on `gh issue create` or `KAIZEN_NO_ACTION` |
| `enforce-post-merge-stop.sh` | Stop | Gate | Yes | Block agent from finishing with pending post-merge workflow |
| `post-merge-clear.sh` | PostToolUse(Bash,Skill) | State machine | No | Clear post-merge gate on /kaizen; promote awaiting_merge on merge confirmation |

### Shared Libraries (`hooks/lib/`)

| Library | Purpose |
|---------|---------|
| `parse-command.sh` | Command parsing: heredoc stripping, `gh`/`git` subcommand detection, PR number extraction |
| `state-utils.sh` | Worktree-scoped state isolation. All state file iteration MUST go through this library |
| `send-telegram-ipc.sh` | Telegram message helper for escalation notifications |

### Test Infrastructure (`hooks/tests/`)

| File | Purpose |
|------|---------|
| `harness.sh` | Integration test framework: event JSON construction, session lifecycle replay |
| `harness.py` | Python companion test harness |
| `test-helpers.sh` | Shared assertions, mock setup, cleanup |
| `run-all-tests.sh` | Test runner (unit, harness, quick modes) |
| `test-*.sh` | Per-hook and integration test files (15+) |
| `test_hooks.py` | Python-based hook tests |

### Documentation (`docs/`)

| File | Purpose |
|------|---------|
| `hook-design-principles.md` | Design patterns for writing hooks |
| `hook-portability-matrix.md` | Maps each hook to its best portable alternative |
| `hook-migration-plan.md` | Phase plan for moving enforcement to strongest layers |

### Integration Points (outside this directory)

These participate in kAIzen but live where their tools require:

| Component | Location | Why it can't move | What it enforces |
|-----------|----------|-------------------|------------------|
| Git pre-commit hook | `.husky/pre-commit` | Husky convention | Blocks commits from main checkout, prettier, test advisory |
| Git pre-push hook | `.husky/pre-push` | Husky convention | Blocks pushes from main checkout (defense-in-depth) |
| CI workflow | `.github/workflows/ci.yml` | GitHub convention | Format, typecheck, unit tests, contract check, PR policy (test coverage + verification), E2E (container build + MCP tools + IPC round-trip with stub API) |
| Hook registration | `.claude/settings.json` | Claude Code convention | Maps hook scripts to tool-use events |

To install kAIzen in another project, copy `.claude/kaizen/`, merge the settings.json hook entries, and install the git hooks and CI workflow.

## Core Invariants

### Workspace isolation

- Dev work must happen in worktrees, not the main checkout.
- Main-checkout source code should not be edited directly.
- One worktree must not interfere with another worktree's state.

### Main checkout: what is and isn't allowed

The main checkout is the **running production instance**. It is not a development workspace.

| Operation | Allowed? | Why |
|-----------|----------|-----|
| `git fetch` | Yes | Read-only, no state change |
| `git pull origin main` (ff-only) | Yes | Required after every PR merge to sync production |
| `git worktree add/list/prune` | Yes | Managing worktrees is a main-checkout responsibility |
| Service ops (restart, build, status) | Yes | Main checkout is the deployment target |
| `git commit` (any branch) | **No** | Committing = dev work, dev work belongs in worktrees |
| `git push` (any branch) | **No** | If you have commits to push, you committed in the wrong place |
| Source file edits | **No** | Enforced by `enforce-worktree-writes.sh` |

**Why blocking only the `main` branch is insufficient:** Creating a feature branch in the main checkout (`git checkout -b feature && vim src/config.ts`) violates workspace isolation even though the branch isn't `main`. The branch name is irrelevant — what matters is **where** the work happens, not **what branch** it's on.

### Shipping discipline

- PR creation should not happen with forgotten dirty files.
- Test and verification expectations must be explicit before merge.

### Review discipline

- Creating or updating a PR is not the end of the work.
- The agent must perform self-review (including requirements verification) before resuming unrelated work.
- Review state must be scoped to the current worktree only.

### Completion discipline

- The agent should not stop after changing code without verification.
- Merged changes require explicit post-merge verification and communication.
- Kaizen reflection must happen at workflow boundaries.

## Control Layers (Kaizen Levels)

### Level 1: Instructions

CLAUDE.md, SKILL.md, docs. Use when judgment is required or the failure is new. No enforcement.

### Level 2: Automatic checks

Claude `PreToolUse`/`Stop` hooks, git hooks, CI/branch protection. Use when the rule is deterministic and the cost of failure is moderate to high. Blocks or fails the action automatically.

### Level 2.5: Structured tools

MCP tools, dedicated workflow commands. Use when the agent must decide when to act but the system should decide how. Portable across runtimes but weaker if raw commands remain available.

### Level 3: Mechanistic / architectural

Read-only mounts, mandatory worktree launcher, protected wrappers. Use when humans should never pay for agent mistakes. Strongest enforcement and portability, highest implementation cost.

## State Management

### PR review state

- **Location:** `/tmp/.pr-review-state/`
- **Format:** Plain key=value files (never sourced — grep/cut only)
- **Fields:** `PR_URL`, `ROUND`, `STATUS` (needs_review|passed|escalated), `BRANCH`
- **Keyed by:** PR URL (not branch — PRs can target different repos)
- **Staleness:** Files older than 2 hours are ignored
- **Isolation:** `state-utils.sh` filters by BRANCH field matching current git branch

### PR creation / merge kaizen state (kaizen #57, #108)

- **Location:** `/tmp/.pr-review-state/` (same directory, `pr-kaizen-` prefix)
- **Format:** Plain key=value files
- **Fields:** `PR_URL`, `STATUS` (needs_pr_kaizen), `BRANCH`
- **Lifecycle:**
  1. `gh pr create` OR `gh pr merge` → `kaizen-reflect.sh` writes `needs_pr_kaizen`
  2. Agent files `gh issue create` or declares `KAIZEN_NO_ACTION` → `pr-kaizen-clear.sh` clears state
  3. `enforce-pr-kaizen.sh` blocks non-kaizen PreToolUse(Bash) while `needs_pr_kaizen` exists

### Post-merge workflow state

- **Location:** `/tmp/.pr-review-state/` (same directory, `post-merge-` prefix)
- **Format:** Plain key=value files
- **Fields:** `PR_URL`, `STATUS` (awaiting_merge|needs_post_merge), `BRANCH`
- **Lifecycle:**
  1. `gh pr merge` → `pr-review-loop.sh` writes `needs_post_merge` (direct merge) or `awaiting_merge` (`--auto`)
  2. `gh pr view` confirms MERGED → `post-merge-clear.sh` promotes `awaiting_merge` to `needs_post_merge`
  3. Agent runs `/kaizen` → `post-merge-clear.sh` clears state
  4. `enforce-post-merge-stop.sh` blocks Stop while `needs_post_merge` exists

### Cross-worktree isolation rule

A hook running in worktree A must NEVER read, modify, or block based on state from worktree B. All state file iteration MUST go through `state-utils.sh` functions. Files without a BRANCH field are skipped.

## Relationship to the Cases System

kAIzen and Cases are **two separate but complementary systems**:

- **kAIzen** = developer discipline enforcement (review, testing, worktree isolation, reflection)
- **Cases** = work management (lifecycle, containers, routing, cost tracking)

### Tightly coupled

| Integration | How |
|-------------|-----|
| Worktree isolation | Cases create worktrees; kAIzen hooks enforce all dev happens in them |
| Cross-worktree state isolation | Hook state files are branch-scoped; parallel cases never contaminate each other |
| PR review gate | Review state machine uses branch name to scope to current case's worktree |

### Loosely coupled

| Integration | How |
|-------------|-----|
| GitHub issue linking | `kaizen-reflect.sh` prompts to file issues; cases store a `github_issue` field |
| Dev case suggestion | Reflection prompts agent to suggest dev cases for improvements found |

### Independent

| Cases feature | kAIzen feature |
|---|---|
| Case lifecycle (SUGGESTED through PRUNED) | PR review state machine |
| Container spawning and mounts | Test coverage checks |
| Message routing to cases | Dirty file enforcement |
| Cost/time tracking | Verification section checks |
| Worktree locks and heartbeats | Session-start WIP detection |
| Case sync to GitHub Issues (CaseSyncAdapter) | Kaizen reflection prompts |

### Future generalization

kAIzen is currently tied to **git worktrees**, **GitHub PRs**, and **GitHub Issues**. These are the right defaults but could be abstracted:

- GitHub Issues -> MCP tool abstraction (any ticket backend)
- GitHub PRs -> MCP tool abstraction (any code review system)
- Git worktrees -> any workspace isolation mechanism

The Cases system already has a `CaseSyncAdapter` interface for backend-agnostic ticket sync. A similar adapter pattern could generalize kAIzen's dependencies.

## Portability Strategy

The right migration target is not "find a Codex replacement for every Claude hook event." The right target is:

1. Move command-centric checks to git hooks.
2. Move PR policy and merge policy to CI and branch protection.
3. Move multi-step guided workflows to MCP tools.
4. Move high-cost invariants to architecture.
5. Keep agent-runtime-native reminders only where they are additive rather than essential.

See `docs/hook-portability-matrix.md` for per-hook analysis and `docs/hook-migration-plan.md` for the phase plan.

## Design Rule

If a control exists only because a specific agent runtime offers a convenient event hook, it is not yet at its strongest form.

Prefer the strongest portable layer that preserves the intended workflow:

- architecture over hooks
- hooks over instructions
- structured tools over agent memory

Claude hooks remain useful, but they should be treated as one adapter for the control system, not the control system itself.
