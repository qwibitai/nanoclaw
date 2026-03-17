# Hook Design Principles

Principles learned from 10+ incidents of review hooks breaking. These are hard-won invariants — violating any of them leads to enforcement gaps.

## The Three-Layer Enforcement Model

Claude can take three types of actions: **use a tool**, **output text**, or **stop**. Enforcement must cover all three.

```
┌─────────────────┬──────────────────────────────────────┬──────────────────────┐
│ Claude's Action  │ Hook Event That Fires                │ Can Block?           │
├─────────────────┼──────────────────────────────────────┼──────────────────────┤
│ Uses Bash tool   │ PreToolUse (matcher: Bash)           │ Yes (deny)           │
│ Uses Edit/Write  │ PreToolUse (matcher: Edit|Write)     │ Yes (deny)           │
│ Uses Agent       │ PreToolUse (matcher: Agent)          │ Yes (deny)           │
│ Uses Read/Glob   │ PreToolUse (matcher: Read|Glob|Grep) │ Yes, but shouldn't*  │
│ Outputs text     │ (no hook event)                      │ No                   │
│ Stops responding │ Stop                                 │ Yes (block)          │
└─────────────────┴──────────────────────────────────────┴──────────────────────┘
* Read-only tools should be allowed during review — they help the agent review code.
```

**The critical invariant**: If you want to force Claude to do something before it can finish, you MUST have:
1. A **Stop hook** that blocks finishing
2. **PreToolUse hooks** on all tool types that block non-allowed actions
3. An **allowlist** of commands that ARE allowed (the actions you want Claude to take)

Missing any layer creates a gap where Claude can escape the enforcement.

## PostToolUse Is Advisory, Not Blocking

PostToolUse hooks run AFTER the tool executes. They can:
- Write state files (side effects)
- Output text to Claude's context (advisory)
- Signal that something happened

They CANNOT:
- Prevent Claude from responding to the user
- Force Claude to act on their output
- Block Claude's next action (that's PreToolUse's job)

**Rule**: Never rely on PostToolUse to control Claude's behavior. Use it ONLY for state management and informational output. Enforcement goes in PreToolUse and Stop hooks.

## The State Machine Pattern

The review enforcement uses a state machine stored in files:

```
                  gh pr create
                       │
                       ▼
               ┌───────────────┐
               │ needs_review  │◄─── git push (from passed)
               │               │
               └───────┬───────┘
                       │ gh pr diff
                       ▼
               ┌───────────────┐
               │    passed     │
               │               │
               └───────┬───────┘
                       │ git push (round > MAX)
                       ▼
               ┌───────────────┐
               │   escalated   │
               │               │
               └───────────────┘

Gate behavior:
  needs_review → Stop blocked, non-review tools blocked
  passed       → All tools allowed, stop allowed
  escalated    → All tools allowed, stop allowed
```

**Rule**: Every hook reads state from the same state files. PostToolUse writes state. PreToolUse and Stop read state. This separation ensures consistency.

## Cross-Worktree Isolation

Multiple Claude agents can run in different worktrees simultaneously. Each has its own branch.

**The golden rule**: A hook in worktree A must NEVER read, modify, or block based on state from worktree B.

Implementation:
1. State files include a `BRANCH=` field
2. All hooks use `list_state_files_for_current_worktree()` from `lib/state-utils.sh`
3. Files without `BRANCH=` are skipped (legacy safety)
4. Files older than `MAX_STATE_AGE` are skipped (staleness safety)

**Rule**: NEVER iterate state files directly. Always go through `state-utils.sh`.

## Hook Registration Checklist

When adding enforcement for a new behavior:

- [ ] **Stop hook** — Can Claude escape by just stopping?
- [ ] **PreToolUse on Bash** — Can Claude escape by running a Bash command?
- [ ] **PreToolUse on Edit|Write** — Can Claude escape by editing files?
- [ ] **PreToolUse on Agent** — Can Claude escape by spawning a subagent?
- [ ] **Allowlist** — What actions SHOULD Claude take? (these must pass through)
- [ ] **State cleanup** — When does the enforcement end?
- [ ] **Cross-worktree** — Does it use `state-utils.sh`?
- [ ] **Staleness** — Does old state expire?
- [ ] **Tests** — Unit tests for each hook + E2E test for the full lifecycle

## Output Format Reference

### PreToolUse (blocks tool)
```json
{
  "hookSpecificOutput": {
    "hookEventName": "PreToolUse",
    "permissionDecision": "deny",
    "permissionDecisionReason": "Human-readable reason with instructions"
  }
}
```
Exit 0 with this JSON. Exit 2 also blocks (stderr becomes reason).

### Stop (blocks stopping)
```json
{
  "decision": "block",
  "reason": "Human-readable reason with instructions"
}
```
Exit 0 with this JSON. The `reason` field is required when blocking.

### PostToolUse (advisory only)
Plain text output on stdout. Gets appended to tool result. Exit 0 always.

## The PR Review Enforcement System

Four hooks working together:

| Hook | Event | Role |
|------|-------|------|
| `pr-review-loop.sh` | PostToolUse (Bash) | State management: creates/updates/cleans state files |
| `enforce-pr-review.sh` | PreToolUse (Bash) | Blocks non-review Bash commands when `needs_review` |
| `enforce-pr-review-tools.sh` | PreToolUse (Edit\|Write, Agent) | Blocks file edits and subagents when `needs_review` |
| `enforce-pr-review-stop.sh` | Stop | Blocks Claude from finishing when `needs_review` |

The Stop hook is the **keystone** — without it, Claude can simply respond with text and stop, never triggering any PreToolUse hooks.

## Testing Requirements

Every enforcement system MUST have:

1. **Unit tests per hook** — Each hook tested in isolation with all state combinations
2. **E2E lifecycle test** — The full state machine exercised end-to-end
3. **Cross-worktree tests** — Verify isolation between branches
4. **Legacy/stale tests** — Verify old state doesn't cause false positives
5. **Allowlist tests** — Verify allowed actions pass through

Test file naming: `test-{hook-name}.sh` for unit tests, `test-{system}-e2e.sh` for integration.
