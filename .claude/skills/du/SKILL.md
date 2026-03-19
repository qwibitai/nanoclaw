---
name: du
description: Worktree disk usage analysis and safe cleanup. Shows worktrees, branches, cases, Docker images, disk usage — with staleness detection and safe removal. Triggers on "du", "disk usage", "cleanup worktrees", "how much space", "clean up", "worktree status", "what's stale".
---

# /du — Worktree Disk Usage & Cleanup

Analyze and clean up NanoClaw worktrees, branches, Docker images, and stale cases. Two modes: analysis (default) and cleanup.

## Safety Invariant

**A lock file — even a stale one — MUST block automated removal.** The 30-minute heartbeat threshold is for IPC, not for "safe to delete." Claude sessions can be suspended for hours and resumed. Only the complete absence of a lock file means no agent is attached.

Cleanup criteria (ALL must be true to remove a worktree):
1. Branch merged into main
2. No dirty files (excluding `.worktree-lock.json`)
3. No unpushed commits
4. **No lock file at all** (not just "stale lock")

## Mode 1: Analysis

### Fast analysis (default when user says "du" or "quick check")

```bash
./scripts/worktree-du.sh analyze --fast
```

Shows: worktree list with branch/lock/state/case status, branch counts, case status counts, stale active cases. Skips: disk sizes, Docker, open PRs.

### Thorough analysis (when user says "thorough", "full", "how much space")

```bash
./scripts/worktree-du.sh analyze
```

Same as fast plus: per-worktree disk sizes, Docker `system df`, VHDX size (WSL), open PRs, total disk usage breakdown.

### Interpreting results

After running the script, provide analysis:

1. **Worktrees with ACTIVE locks** — highlight these. Never suggest removing them.
2. **Worktrees with stale locks** — flag as "possibly abandoned but NOT safe to auto-remove." Ask the user if they want to investigate (check if a Claude session is still running for that worktree).
3. **Merged + clean + no lock** — these are cleanup candidates. Report count and total size.
4. **Dirty or unpushed worktrees** — flag as needing attention. The user may want to commit, push, or discard.
5. **Stale active cases** — cases marked active in DB but whose branch is merged. These indicate the case lifecycle isn't closing properly.
6. **Docker waste** — dangling images, build cache size, VHDX bloat vs actual content.

### Recommendations

Based on analysis, suggest specific actions:
- "N worktrees are merged+clean+unlocked — safe to remove with `./scripts/worktree-du.sh cleanup`"
- "N worktrees have stale locks — check if those Claude sessions are still alive before removing"
- "N active cases have merged branches — their status should be updated to done"
- "Docker has N dangling images and XGB of unreferenced build cache"
- On WSL: "VHDX is XGB but only contains YGB — Z GB reclaimable via compaction"

## Mode 2: Cleanup

### Dry run first (ALWAYS do this before actual cleanup)

```bash
./scripts/worktree-du.sh cleanup --dry-run
```

Show the user what would be removed. **Always run dry-run first and present results before proceeding.**

### Actual cleanup

```bash
./scripts/worktree-du.sh cleanup
```

The script runs 5 phases:
1. **Stale worktrees** — remove merged+clean+unlocked worktrees
2. **Merged branches** — delete branches that are merged and have no worktree
3. **Docker** — prune dangling images + unreferenced build cache (preserves active layers)
4. **Git housekeeping** — `git worktree prune` for stale references
5. **Stale cases** — mark active cases with merged branches as done

### Post-cleanup on WSL

After Docker cleanup, if on WSL, advise the user about VHDX compaction:
```
To reclaim host disk space after Docker cleanup:
1. Close all WSL terminals
2. Run in PowerShell: wsl --shutdown
3. Run in PowerShell (admin): Optimize-VHD -Path "C:\Users\{user}\AppData\Local\Docker\wsl\disk\docker_data.vhdx" -Mode Quick
   OR use diskpart: select vdisk file="...\docker_data.vhdx" → compact vdisk
```

**Do NOT automate this** — it kills all WSL sessions.

## Workflow

1. User asks for analysis → run fast or thorough based on their request
2. Present summary with recommendations
3. If cleanup is warranted, run `--dry-run` first
4. Show dry-run results, ask user to confirm
5. Run actual cleanup only after explicit confirmation
6. Report results

## Edge cases

- **Empty directories in worktrees dir** (not git worktrees) — the script skips these. If found during analysis, mention them: "N empty directories in .claude/worktrees/ — these are not git worktrees and can be removed with rmdir."
- **Worktrees on main branch** — likely broken/accidental creations. Flag for manual review.
- **Nested worktrees** (worktree inside another worktree) — `git worktree prune` handles stale references. Flag any that still exist physically.
