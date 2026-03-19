# Horizon: Worktree-First Infrastructure

*"Isolation prevents contamination. Your worktree, your state, your problem."*

## Problem

NanoClaw mandates worktree-first development but the tooling was built assuming main checkout. Every new CLI tool, path resolver, or file-creating utility faces the same class of bug: it works from main, breaks from worktrees. The hooks layer solved this with `state-utils.sh`. The TypeScript tooling layer hasn't.

## Taxonomy

| Level | Name | Description | Status |
|-------|------|-------------|--------|
| L0 | Main-checkout assumed | Tools use `process.cwd()` or relative paths. Only work from main. | Was here |
| L1 | Ad-hoc fixes | Individual tools detect worktrees case-by-case. | **Current** |
| L2 | Shared resolution library | Single `git-paths.ts` utility. All tools import it. | **Next step** |
| L3 | Enforced usage | CI/lint flags `process.cwd()` in tool code. New tools can't ship without shared resolver. | Visible |
| L4 | Integration-tested | "Works from worktree" is a test suite dimension for CLI tools. | Visible |
| L5 | Policy-as-code | No code path uses raw `process.cwd()` for repo root. Always resolves via git. | Horizon |

## You Are Here

**L0 → L1.** Hooks layer is at L2 (`state-utils.sh`). TypeScript tooling is at L0.

## Full Spec

See [`docs/worktree-first-tooling-spec.md`](../worktree-first-tooling-spec.md) for problem analysis, incidents, current state assessment, and L2 implementation approach.
