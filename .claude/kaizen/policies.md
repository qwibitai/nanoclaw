# Kaizen Enforcement Policies

These policies govern the kaizen enforcement system specifically. General dev policies live in CLAUDE.md. These rules were learned from past kaizen incidents — follow them strictly.

1. **Recursive kaizen on every fix-PR.** See `.claude/skills/kaizen/SKILL.md` for the full framework. After every fix, assess:
    - **What level is this fix?** Level 1 (instructions) → Level 2 (hooks/checks) → Level 3 (mechanistic code)
    - **Has this type of failure happened before?** If yes, the previous level wasn't enough — escalate.
    - **Affects humans directly?** → Must be Level 3 (humans should never wait on agent mistakes)
    - CLAUDE.md instructions are Level 1 — necessary but not sufficient. When they fail, escalate to hooks (Level 2) or architectural enforcement (Level 3).
2. **Hooks are the foundation of our kaizen infrastructure.** The `.claude/kaizen/hooks/` directory contains Level 2 enforcement — automated checks that catch mistakes before they reach humans. See `.claude/kaizen/README.md` for the full kAIzen Agent Control Flow system documentation. When a hook blocks you:
    - **Do NOT override it blindly.** The hook exists because a past mistake proved instructions alone weren't enough.
    - **If it's a false positive**, fix the hook. Improve its matching logic, add exclusions with rationale, and add a test case that covers the false-positive scenario. This is recursive kaizen — making the enforcement smarter, not weaker.
    - **If it's a true positive**, fix the underlying issue. The hook is doing its job.
    - **Always add a test** for any hook change in `.claude/kaizen/hooks/tests/`. Hooks without tests are Level 1 pretending to be Level 2.
3. **MCP tools are Level 3 enforcement points, not passthroughs.** When an agent behavior problem surfaces through an MCP tool, the fix belongs in the tool's logic — validation, auto-detection, or rejection. Don't default to updating the tool's description text (Level 1) when the kaizen rules demand Level 3. The MCP boundary is where agent intent meets system action; that's where policy enforcement belongs. Level 1 description improvements are defense-in-depth on top of Level 3, not a substitute.
4. **Authoritative security files: do NOT duplicate, do NOT bypass.** Files with `security`, `auth`, or `allowlist` in their name (`case-auth.ts`, `mount-security.ts`, `sender-allowlist.ts`) are the single source of truth for their policy domain. All authorization decisions in that domain MUST go through the authoritative file. Never inline ad-hoc authorization checks elsewhere — call the gate function instead. Changes to these files require careful review and tests.
5. **Hooks MUST be worktree-isolated.** A hook running in worktree A must NEVER read, modify, or block based on state from worktree B. This is a hard safety invariant — violations cause cross-worktree contamination where one agent's work hijacks another agent's session. All state file iteration MUST go through `lib/state-utils.sh` (`is_state_for_current_worktree`, `list_state_files_for_current_worktree`). Never iterate `/tmp/.pr-review-state/` directly. State files without a BRANCH field are treated as unattributable and skipped.
6. **Co-commit source and test changes.** Every source file change must have a corresponding test file change in the same PR. Test utilities use the `.test-util.ts` extension (excluded from coverage checks). If a source change genuinely doesn't need tests (e.g., trivial constant change, already covered by existing tests), declare it in the PR body using the `test-exceptions` fenced block — this is public and auditable.
8. **Smoke tests ship WITH the feature — never after.** Every feature that introduces a new execution path (hooks, wrappers, scripts, CLI commands, IPC handlers) must include smoke tests in the same PR that verify the path works end-to-end. "We'll add tests later" is a scope cut without a mechanism — the tests never arrive, and silent failures go undetected. This applies to:
    - Bash wrappers that invoke other runtimes (e.g., `exec npx tsx`)
    - New hook registrations in `settings.json`
    - New IPC message types
    - New CLI subcommands
    - Container entrypoint changes
    The smoke test must exercise the real deployment path (not just unit-test the logic), with isolated state to prevent test artifacts from leaking into production state directories.
9. **Hook language boundaries: L1-L2 bash, L3-L4 TypeScript.** Simple guards and pattern matching stay in bash. Scripts that need arithmetic, data transformation, error recovery, or their own test assertions belong in TypeScript. The signal: if you're hand-rolling `try/catch` or `expect()` in bash, move to TypeScript. See [`docs/hook-language-boundaries.md`](../../docs/hook-language-boundaries.md) for the full decision framework and migration plan.
