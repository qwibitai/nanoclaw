# Worktree-First Dev Tooling — Specification

## 1. Problem Statement

NanoClaw mandates worktree-first development: "All dev work MUST be in a case with its own worktree. Never modify code in main checkout." This is enforced by L2 hooks (`enforce-case-exists.sh`, `enforce-worktree-writes.sh`). But the dev tooling itself — the CLI tools, path resolution, and file management that agents use to create cases and work within them — assumes it runs from the main checkout.

**The result:** agents follow the policy (work in worktrees) but the tools they need to set up that work break when called from worktrees. The hooks enforce isolation at the edit layer, but the infrastructure layer hasn't caught up.

### Concrete incidents

| Date | What broke | Impact | Root cause |
|------|-----------|--------|------------|
| 2026-03-19 (kaizen #139) | `cli-kaizen.js case-create` from worktree printed success JSON but case wasn't persisted to DB | ~5 min manual DB fix | `config.ts` resolves `STORE_DIR` via `process.cwd()`, which pointed to the worktree |
| 2026-03-19 (kaizen #139) | `.worktree-lock.json` created in worktree root, blocked push via dirty-files hook | ~1 min manual cleanup | File not in `.gitignore` |

### Why this is a horizon, not a feature

Every new CLI tool, every new path-dependent utility, every new file created during case setup will face the same question: "does this work when called from a worktree?" Point-fixing #143 and #144 solves today's bugs. But without a shared pattern, the next tool will have the same class of bug.

The hooks layer learned this lesson and built `state-utils.sh` — a shared library that all hooks use for worktree-safe state file access. The CLI/infrastructure layer has no equivalent.

## 2. Taxonomy: Worktree-First Infrastructure Levels

| Level | Name | What it means | Status |
|-------|------|--------------|--------|
| **L0** | Main-checkout assumed | Tools hardcode `process.cwd()` or relative paths. Only work from main. | Was here |
| **L1** | Ad-hoc fixes | Individual tools detect worktrees and resolve paths case-by-case. Each tool has its own `git rev-parse --git-common-dir` logic. | **Current** |
| **L2** | Shared resolution library | A single utility (like `state-utils.sh` for hooks, but for TypeScript tooling) resolves "main checkout root," "DB path," "worktree root." All tools import it. | **Next step** |
| **L3** | Enforced usage | A CI check or lint rule detects `process.cwd()` or bare path resolution in CLI/tool code and flags it. New tools can't ship without using the shared resolver. | Visible from here |
| **L4** | Integration-tested | Worktree-from-worktree scenarios (nested worktrees, CLI called from worktree) are part of the test suite. The test ladder covers "does this tool work from a worktree?" as a standard dimension. | Visible from here |
| **L5** | Policy-as-code | The worktree-first mandate is enforced architecturally — the tooling simply doesn't have a code path that uses `process.cwd()` for repo root. It always resolves via git. | Horizon |

## 3. You Are Here

**L0 → L1.** The hooks layer is at L2 (shared `state-utils.sh`). The TypeScript tooling layer is at L0-L1 — `config.ts` uses `process.cwd()`, `cli-kaizen.ts` inherits that, and individual hooks do their own `git rev-parse` ad-hoc.

## 4. Current State — What Exists

### Already solved (hooks layer — L2)

| Component | How it's worktree-aware | Mechanism |
|-----------|------------------------|-----------|
| `state-utils.sh` | `BRANCH=` field filters state files by current worktree | Shared library, all hooks use it |
| `enforce-case-exists.sh` | Resolves main root via `dirname "$(git rev-parse --git-common-dir)"` | Per-hook, but correct |
| `enforce-worktree-writes.sh` | Same pattern — resolves main root, blocks edits there | Per-hook, but correct |
| State files in `/tmp/.pr-review-state/` | Attributed to branch, filtered by `is_state_for_current_worktree()` | Shared library with tests |

### Not solved (TypeScript tooling layer — L0)

| Component | What breaks | Why |
|-----------|------------|-----|
| `config.ts` `PROJECT_ROOT` | Resolves to worktree root instead of main checkout | `process.cwd()` |
| `config.ts` `STORE_DIR` | DB path points to worktree's `store/` (doesn't exist) | Derived from `PROJECT_ROOT` |
| `cli-kaizen.ts` | Case creation succeeds in memory but DB write goes to wrong path | Imports `STORE_DIR` from config |
| `cases.ts` `WORKTREES_DIR` | Would create nested worktrees if `PROJECT_ROOT` is already a worktree | Derived from `PROJECT_ROOT` |
| `.worktree-lock.json` | Created in worktree root, triggers dirty-files hook | Not in `.gitignore` |

## 5. L2: Shared Resolution Library (next step)

**Problem:** Multiple TypeScript files need "where is the main checkout root?" and "where is the DB?" Currently each resolves this independently (or doesn't).

**Solution:** A single TypeScript utility — `src/git-paths.ts` — that provides:

```typescript
// Always returns the main checkout root, whether called from main or a worktree
export function getMainCheckoutRoot(): string;

// Returns the canonical store/messages.db path (always in main checkout)
export function getStorePath(): string;

// Returns true if the current process is running from a worktree
export function isWorktree(): string;
```

**Implementation approach:**
- Use `git rev-parse --git-common-dir` (the same pattern hooks use)
- If `git-common-dir` equals `.git`, we're in main → `process.cwd()` is correct
- Otherwise, `dirname(git-common-dir)` gives the main checkout root
- `config.ts` imports from `git-paths.ts` instead of using raw `process.cwd()`

**Why this is the right level:** It's the TypeScript equivalent of what `state-utils.sh` did for bash hooks. One library, tested once, used everywhere. The pattern already proved itself — we're extending it to a new layer.

### Point fixes included in L2

- **#143:** `cli-kaizen.ts` uses `getStorePath()` instead of `STORE_DIR` → DB writes always go to main checkout
- **#144:** Add `.worktree-lock.json` to `.gitignore`
- **`config.ts`:** `PROJECT_ROOT = getMainCheckoutRoot()` instead of `process.cwd()`

### What L2 does NOT solve

- No enforcement that new code uses `git-paths.ts` — a developer could still write `process.cwd()` in a new tool
- No integration test that runs CLI from a worktree
- The resolution is a function call, not an architectural constraint — it can be forgotten

## 6. L3-L4: Enforcement and Testing (visible from here)

**L3 — Lint/CI enforcement:**
- A CI check (or grep-based hook) that flags `process.cwd()` usage in `src/` files outside of `git-paths.ts`
- Similar to how kaizen #137 proposes CI checks for mutation hook registrations without tests

**L4 — Integration tests:**
- Test that `getMainCheckoutRoot()` returns the right path when called from a worktree
- Test that `cli-kaizen.js case-create` persists to the correct DB when run from a worktree
- Add "works from worktree" as a dimension in the test ladder

These levels are described as problems, not solutions. The specific mechanism will be clearer after L2 is implemented and we see what failure modes remain.

## 7. Open Questions

1. **Should `config.ts` always resolve to main checkout?** Currently `PROJECT_ROOT = process.cwd()` which is correct for the running harness (always started from main). If we change it to `getMainCheckoutRoot()`, does that break anything for the production process? Likely not — the harness always runs from main — but needs verification.

2. **Should `git-paths.ts` shell out to `git` or use a library?** Shelling out to `git rev-parse` is simple and matches the hook pattern. A library like `simple-git` adds a dependency. Lean: shell out — it's one command, fast, and consistent with hooks.

3. **Where should `.worktree-lock.json` live instead?** Options: (a) keep in worktree root but `.gitignore` it, (b) move to `/tmp/` or `store/` where it's naturally outside git. Lean: (a) is simplest — the file is useful where it is, just needs to be ignored.

## 8. Relationship to Other Horizons

- **Autonomous Kaizen (L6+):** When agents autonomously select and implement work, they'll always be in worktrees. Reliable worktree tooling is a prerequisite for autonomous operation.
- **Test Ladder (#84):** "Works from worktree" is a testability dimension that should be added to the ladder for CLI tools.
- **Incident-Driven Kaizen:** The incidents from kaizen #139 are the data that motivated this spec. Future incidents of "tool X broke in worktree" should be tagged to this horizon for tracking.
