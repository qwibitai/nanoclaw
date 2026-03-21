# Hooks Design — Patterns, Anti-Patterns, and Lessons Learned

This document captures hard-won knowledge about the Claude Code hooks system. It's the reference for anyone writing, debugging, or maintaining hooks.

## Architecture

### Two Independent Systems: Permissions vs Hooks

Claude Code has two enforcement layers that are often confused:

| System | Flag to bypass | What it does |
|--------|---------------|--------------|
| **Permissions** | `--dangerously-skip-permissions` | Auto-approves built-in "Allow this tool?" prompts |
| **Hooks** | `--bare` | Disables custom PreToolUse/PostToolUse/Stop scripts |

**Critical:** `--dangerously-skip-permissions` does NOT bypass hooks. Custom hook `permissionDecision: "deny"` responses still fire and block. This was discovered in kaizen #323 when overnight-dent runs (which use `--dangerously-skip-permissions`) were still blocked by kaizen gates.

`--bare` disables hooks BUT also disables CLAUDE.md, skills, LSP, and other infrastructure. It's a nuclear option, not a surgical one.

### Hook Event Lifecycle

```
User/Agent action
  → PreToolUse hooks fire (can DENY — blocks the action)
  → Tool executes (if not denied)
  → PostToolUse hooks fire (advisory — can set gates but not block retroactively)
  → Stop hooks fire (when agent tries to finish — can block completion)
```

### Gate Pattern

Gates are the primary control flow mechanism:

1. **PostToolUse** creates a state file (e.g., `needs_pr_kaizen`)
2. **PreToolUse** checks for the state file and denies non-allowlisted commands
3. An allowlisted action clears the state file
4. **Stop** hook prevents the agent from finishing with pending gates

This creates a "you must do X before you can do Y" enforcement.

## Writing Hooks

### Language Boundaries

See [`hook-language-boundaries.md`](hook-language-boundaries.md) for the full policy. Summary:

- **Bash hooks** are the execution entry point (Claude Code invokes them)
- **TypeScript** is preferred for complex logic (via `npx tsx` trampolines)
- **Shared libraries** (`lib/*.sh`) provide common functions for bash hooks
- Never mix languages within a single hook's logic — use a trampoline

### Trampoline Pattern

When a hook needs complex logic, use a thin bash wrapper that delegates to TypeScript:

```bash
#!/bin/bash
# thin-hook.sh — trampoline to TypeScript implementation
exec npx tsx "$(dirname "$0")/hook-impl.ts" "$@"
```

The bash script handles Claude Code's hook protocol (stdin JSON, stdout JSON). The TypeScript handles the logic.

### Regex Patterns — The Alternation Trap

**Anti-pattern (kaizen #323):**
```bash
grep -qE "^git[[:space:]]+${subcommand}"
# Where subcommand="diff|log|show|status|branch|fetch"
# Expands to: ^git[[:space:]]+diff|log|show|status|branch|fetch
# The | is top-level alternation! "branch" matches ANYWHERE in the string
```

**Correct pattern:**
```bash
grep -qE "^git[[:space:]]+(${subcommand})"
# Parentheses group the alternation: ^git[[:space:]]+(diff|log|show|...)
```

This bug caused `gh pr merge --delete-branch` to pass through readonly monitoring (the `branch` in `--delete-branch` matched the bare `branch` alternative). Always wrap variable alternation patterns in parentheses.

### Allowlist Design

When a gate blocks commands, it needs an allowlist of commands that ARE permitted during the gate.

**Principles:**
- Allowlist by **intent**, not by syntax. "PR workflow commands" not "commands containing `gh pr`"
- Include **all variants** of an allowed action. `gh pr merge 42`, `gh pr merge URL`, `gh pr merge --squash` are all the same intent
- **Segment-split** before matching (kaizen #172). Commands chained with `|`, `&&`, `;` must have each segment checked independently. Otherwise `npm build && echo KAIZEN_IMPEDIMENTS:` bypasses the gate
- Use `is_gh_pr_command`, `is_git_command` helpers — they handle segment splitting

### State File Conventions

- **Location:** `$STATE_DIR` (defaults to `/tmp/.pr-review-state/`)
- **Format:** `KEY=value` lines (parseable with `grep` + `cut`)
- **Required fields:** `PR_URL`, `STATUS`, `BRANCH`
- **Branch scoping:** State files include `BRANCH=` so hooks can filter to the current worktree
- **Cross-branch lookup:** Active declarations (KAIZEN_IMPEDIMENTS) use `_any_branch` variants since the agent may submit from a different worktree
- **Staleness:** Files older than `MAX_STATE_AGE` (2 hours) are ignored

### Testing Hooks

- **Unit tests:** Each hook has `test-{hook-name}.sh` in `tests/`
- **Integration tests:** `test-hook-interaction-matrix.sh` tests cross-hook behavior
- **Test isolation:** Tests override `STATE_DIR` to a temp directory. Never rely on real state files
- **Mock `gh`:** Create a mock `gh` script in a temp dir and prepend to `PATH`
- **Always test both paths:** the "allowed" path AND the "denied" path

## Anti-Patterns

### 1. Assuming `--dangerously-skip-permissions` Disables Hooks
It doesn't. See "Two Independent Systems" above.

### 2. Unparenthesized Regex Alternation
`grep -qE "^prefix${var}"` where `var` contains `|` creates top-level alternation. Always use `(${var})`.

### 3. Gate Without Allowlist
A gate that blocks ALL commands forces the agent to clear the gate before doing anything — including commands needed to clear the gate. Always include the clearing action in the allowlist.

### 4. Branch-Scoped Lookup for Active Declarations
When an agent actively submits something (KAIZEN_IMPEDIMENTS), use `_any_branch` variants. The agent may have switched worktrees since the gate was created.

### 5. Testing Against Real State
Tests that don't override `STATE_DIR` will interact with real gates from other sessions, producing flaky results that depend on system state.

### 6. Silent Failures in Advisory Hooks
PostToolUse hooks that set gates should log what they're doing. Silent gate creation leads to mysterious blocks later.

## Lessons Learned

| Incident | Lesson | Kaizen |
|----------|--------|--------|
| `--delete-branch` matched `branch` in regex | Always parenthesize regex alternation variables | #323 |
| `--dangerously-skip-permissions` didn't bypass gates | Permissions and hooks are independent systems | #353 |
| Gate re-fired 3x for same PR in one session | Per-PR reflection markers needed | #288 |
| Cross-worktree gate clearing failed | Active declarations need `_any_branch` lookup | #239 |
| `npm build && echo KAIZEN_IMPEDIMENTS:` bypassed gate | Segment-split before matching | #172 |
| Hook tests flaky due to real state files | Always override `STATE_DIR` in tests | #309 |
