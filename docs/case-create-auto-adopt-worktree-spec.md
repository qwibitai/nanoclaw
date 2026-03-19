# Case Creation Auto-Adopt Worktree — Specification

## 1. Problem Statement

The case system assumes it is the sole worktree lifecycle manager. When `case_create` runs, it unconditionally creates a new git worktree — even when the caller is already inside one. This produces duplicate worktrees, orphaned branches, and requires manual DB surgery to fix.

**Kaizen #112 added manual flags** (`--branch-name`/`--worktree-path` for CLI, `branchName`/`worktreePath` for IPC/MCP) that let callers explicitly say "use this existing worktree." But this is a Level 1 fix — it shifts the burden to the caller. Every new tool that creates worktrees (Claude Code's `EnterWorktree`, future CI tools, other agents) would need to know about and pass these flags.

**The real fix:** case creation should auto-detect that it's already running inside a worktree and adopt it. The information is already available from git.

### Concrete incidents

| Date | What broke | Impact | Root cause |
|------|-----------|--------|------------|
| 2026-03-19 (kaizen #112) | `cli-kaizen.js case-create` from worktree created nested worktree | 3 IPC attempts + manual DB surgery per case, orphaned worktrees | `createCaseWorkspace` unconditionally calls `git worktree add` |
| 2026-03-19 (kaizen #112) | Same bug occurred twice in one session | ~15 min wasted total | No detection of "already in a worktree" |

### What exists after #112

The manual flags work correctly. If a caller passes `--branch-name` and `--worktree-path` (CLI) or sets `branchName`/`worktreePath` (IPC), `resolveExistingWorktree()` validates the path exists and returns workspace info without creating anything.

But callers who don't know about the flags (or forget them) still get the old behavior: a duplicate worktree.

## 2. Desired End State

When `case_create` is called from inside an existing worktree:
1. It detects that `process.cwd()` (or the equivalent for IPC) is a worktree, not the main checkout
2. It uses the current worktree path and branch name automatically
3. It does NOT create a new worktree
4. The case record is linked to the existing worktree

When `case_create` is called from the main checkout:
- Behavior is unchanged — it creates a new worktree as before

When explicit `--branch-name`/`--worktree-path` flags are passed:
- They take precedence over auto-detection (already implemented in #112)

**Out of scope:**
- Worktree cleanup/lifecycle management (separate concern)
- Multi-case-per-worktree support (not needed)
- Container-side auto-detection (containers have different git topology)

## 3. Architecture

### Detection mechanism

Git provides everything needed:

```bash
# Are we in a worktree? Compare git-common-dir to the default .git
git rev-parse --git-common-dir   # /path/to/main/.git (always)
git rev-parse --show-toplevel    # /path/to/worktree (if in worktree)
git rev-parse --abbrev-ref HEAD  # current branch name
```

If `show-toplevel` is not a parent of `git-common-dir`, we're in a worktree. The worktree path is `show-toplevel`, the branch is `abbrev-ref HEAD`.

### Where detection runs

There are three entry points for case creation. Each needs different handling:

| Entry point | Runs where | Can use `process.cwd()` | Auto-detect approach |
|------------|-----------|------------------------|---------------------|
| `cli-kaizen.ts` (CLI) | Host, directly | Yes — the CLI runs in the caller's cwd | Detect at startup via git commands |
| `ipc-cases.ts` (IPC) | Host, via harness | No — harness always runs from main checkout | Caller must pass flags (already works via #112) |
| `ipc-mcp-stdio.ts` (MCP) | Container | No — container has different git topology | Caller must pass flags (already works via #112) |

**Key insight:** Auto-detection only makes sense for the CLI path. IPC and MCP callers don't share `process.cwd()` with the case creation logic — the harness process runs from the main checkout regardless of where the requesting agent is. The #112 flags already cover those paths.

### Implementation

In `cli-kaizen.ts`, before workspace creation:

```typescript
// Auto-detect: if running from inside a worktree and no explicit flags,
// adopt the current worktree
if (!branchName && !worktreePath) {
  const detected = detectCurrentWorktree();
  if (detected) {
    resolved = deps.resolveWorktree(detected.worktreePath, detected.branchName);
  }
}
```

The `detectCurrentWorktree()` function:

```typescript
function detectCurrentWorktree(): { worktreePath: string; branchName: string } | null {
  try {
    const gitCommonDir = execSync('git rev-parse --git-common-dir', { encoding: 'utf-8' }).trim();
    const toplevel = execSync('git rev-parse --show-toplevel', { encoding: 'utf-8' }).trim();
    const mainRoot = path.dirname(path.resolve(gitCommonDir));

    // If toplevel equals main root, we're in the main checkout — no auto-adopt
    if (path.resolve(toplevel) === mainRoot) return null;

    const branchName = execSync('git rev-parse --abbrev-ref HEAD', { encoding: 'utf-8' }).trim();
    return { worktreePath: toplevel, branchName };
  } catch {
    return null;
  }
}
```

This function belongs in `cases.ts` (near `resolveExistingWorktree`) or in the future `git-paths.ts` utility proposed by the worktree-first spec.

## 4. What Exists vs What Needs Building

### Already Solved

| Capability | Current implementation | Status |
|------------|----------------------|--------|
| Manual worktree adoption | `resolveExistingWorktree()` + CLI/IPC/MCP flags | Done (#112) |
| Worktree path validation | `resolveExistingWorktree()` checks `fs.existsSync()` | Done (#112) |
| Fallback to new worktree | `resolved \|\| createCaseWorkspace()` pattern | Done (#112) |

### Needs Building

| Component | What | Why it doesn't exist yet |
|-----------|------|-------------------------|
| `detectCurrentWorktree()` | Git-based worktree detection function | #112 focused on explicit flags, not auto-detection |
| CLI auto-adopt | Call `detectCurrentWorktree()` before workspace creation in `cli-kaizen.ts` | Same |
| Tests | Unit tests for detection (in worktree vs main checkout) | Same |

## 5. Open Questions

1. **Should auto-detect be on by default or opt-in?** The risk of auto-detecting is that someone running `case-create` from a worktree that belongs to a *different* case might accidentally link to the wrong worktree. Mitigation: check if the worktree already has an active case linked to it, and if so, don't auto-adopt (treat it as "occupied"). Lean: on by default with the occupied-check guard.

2. **Should this live in `cases.ts` or a future `git-paths.ts`?** The worktree-first spec (kaizen #145) proposes `git-paths.ts` as a shared resolution library. `detectCurrentWorktree()` is a natural fit there. But it could ship in `cases.ts` now and move later. Lean: ship in `cases.ts` now, move when `git-paths.ts` is built.

3. **What about the `--no-auto-detect` escape hatch?** If auto-detection causes surprises, callers need a way to force new worktree creation. A `--new-worktree` flag (or `forceNewWorktree` IPC field) would explicitly bypass detection. Lean: add it, default off.

## 6. Relationship to Other Work

- **Kaizen #112 (done):** The manual flags this spec builds on top of. Auto-detect is the next step.
- **Kaizen #145 (worktree-first tooling spec):** The broader initiative. `detectCurrentWorktree()` is a concrete contribution to L2 of that taxonomy. If `git-paths.ts` ships first, detection goes there.
- **Kaizen #143 (cli-kaizen DB path):** Fixing `STORE_DIR` resolution from worktrees. Related but orthogonal — that's about which DB to write to, this is about which worktree to link.
