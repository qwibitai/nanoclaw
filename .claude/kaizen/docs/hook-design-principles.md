# Autonomous Guardrailed Dev Workflow

How NanoClaw dev agents work autonomously with quality enforcement at every step. The agent completes the full cycle — worktree, code, test, PR, review, merge, sync — without human intervention. Hooks enforce quality gates that the agent cannot bypass.

## The Full Dev Cycle

```
SessionStart
  │  check-wip.sh warns about in-progress work
  ▼
Worktree Creation
  │  enforce-case-worktree.sh blocks commits outside worktrees
  │  enforce-worktree-writes.sh blocks edits to main checkout
  ▼
Development
  │  check-dirty-files.sh tracks uncommitted changes
  │  check-verification.sh enforces path tracing before fixes
  ▼
Testing & Commit
  │  check-test-coverage.sh blocks merges without tests
  │  verify-before-stop.sh blocks stop if TypeScript doesn't compile / tests fail
  ▼
PR Creation (gh pr create)
  │  pr-review-loop.sh (PostToolUse) writes STATUS=needs_review
  │  enforce-pr-review-stop.sh (Stop) blocks agent from finishing
  │  enforce-pr-review.sh (PreToolUse/Bash) blocks non-review commands
  │  enforce-pr-review-tools.sh (PreToolUse/Edit|Write|Agent) blocks edits
  │  ─── agent is FORCED to run gh pr diff and complete review ───
  │  Up to 4 rounds of review. If issues remain → escalate to human.
  ▼
Merge (autonomous)
  │  gh pr merge --auto --squash --delete-branch
  │  Wait for CI (gh run watch / gh pr checks --watch)
  │  Verify state=MERGED
  │  If CI fails → fix, push (auto-merge retries automatically)
  │  If branch behind → merge main, push (auto-merge retries)
  ▼
Post-Merge
  │  Sync main: git fetch origin main && git merge origin/main
  │  kaizen-reflect.sh (PostToolUse) prompts for process improvement
  │  check-cleanup-on-stop.sh verifies worktree cleanup
  ▼
Done
```

Every arrow is enforced by hooks. The agent cannot skip steps — hooks block tool calls, block stopping, and funnel the agent through the correct path. The only escape is escalation to a human after max retries.

## Hook Enforcement Levels

| Level | Mechanism | Durability | Example |
|-------|-----------|-----------|---------|
| 0 | Claude's training | Unreliable | "Always review PRs" |
| 1 | CLAUDE.md instructions | Fragile — agent can forget | "After gh pr create, run gh pr diff" |
| 2 | PostToolUse hooks | Advisory — agent can ignore | pr-review-loop.sh outputs checklist |
| 3 | PreToolUse + Stop hooks | Enforced — agent cannot bypass | enforce-pr-review-stop.sh blocks stopping |

**Level 3 is the only reliable enforcement.** Levels 0-2 are useful for context but must never be the sole mechanism for anything important. If an instruction matters, it must be backed by a Level 3 hook.

## Merge Workflow (Autonomous)

Branch protection has `strict: true` status checks. Auto-merge is enabled. The agent handles the full merge loop:

1. **Queue**: `gh pr merge <url> --repo Garsson-io/nanoclaw --squash --delete-branch --auto`
2. **Wait**: `gh pr checks <url> --repo Garsson-io/nanoclaw --watch` or `gh run watch <id>`
3. **Verify**: `gh pr view <url> --json state --jq .state` → expect `MERGED`
4. **Sync**: `git -C /home/aviadr1/projects/nanoclaw fetch origin main && git -C /home/aviadr1/projects/nanoclaw merge origin/main --no-edit`

**Failure handling** (agent does this autonomously, no human needed):
- **CI fails**: fix the issue, commit, push. Auto-merge stays queued, CI re-runs.
- **Branch behind main**: `git fetch origin main && git merge origin/main --no-edit && git push`. CI re-runs, auto-merge retries.
- **Auto-merge not completing**: check `gh pr view --json mergeStateStatus` and fix.

**Do NOT ask the user** for merge issues — handle them. Only escalate after multiple failed retries with different root causes.

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

### Post-Review and Post-Merge Summaries

`pr-review-loop.sh` also handles agent communication at two key milestones:

**Review passed** (state → `passed` after `gh pr diff`):
- Prompts the agent to summarize what the PR achieves
- Reports the PR is ready to merge with the URL
- Reminds the agent to classify the post-merge action needed (none, build+restart, container rebuild)

**Merge complete** (`gh pr merge` succeeds):
- Prompts the agent to summarize what was achieved and its impact
- Reminds the agent to classify the change and state what deployment action is needed
- Reminds the agent to sync local main

This ensures the user always gets a clear status report at both milestones, and the agent considers deployment implications before declaring done.

## Testing Requirements

Every enforcement system MUST have:

1. **Unit tests per hook** — Each hook tested in isolation with all state combinations
2. **E2E lifecycle test** — The full state machine exercised end-to-end
3. **Cross-worktree tests** — Verify isolation between branches
4. **Legacy/stale tests** — Verify old state doesn't cause false positives
5. **Allowlist tests** — Verify allowed actions pass through

Test file naming: `test-{hook-name}.sh` for unit tests, `test-{system}-e2e.sh` for integration.

## CI Policy Enforcement (Level 3)

CI workflows are the highest enforcement level — they run on every PR and cannot be bypassed by the agent. They complement hooks (which enforce during development) by enforcing at merge time.

### Test coverage policy (pr-policy)

Every changed source file must have a corresponding test file change in the same PR. This is checked by the `pr-policy` job in `.github/workflows/ci.yml`.

**Exclusion patterns** (not considered source files):
- `.test.ts`, `.spec.ts` — test files
- `.test-util.ts` — test utility files
- `.config.`, `vitest.` — configuration files
- `.claude/`, `container/agent-runner/`, `.husky/` — infrastructure directories

**Escape hatch**: `test-exceptions` fenced block in the PR body. When a source file change genuinely doesn't need test changes, the author declares it publicly:

````markdown
```test-exceptions
src/ipc.ts: 2-line field addition, covered by existing insertCase tests
src/config.ts: constant change, no logic to test
```
````

Properties:
- Visible in PR body — reviewer sees every exemption
- Unique fence language — no false positives from other code blocks
- `file: reason` format — structured, parseable
- Preserved in git history via PR body — auditable
- No elevated permissions needed — but justification is public

**When NOT to use test-exceptions**:
- New functions or methods — always need tests
- Logic changes — always need tests
- Bug fixes — the test proves the fix works

### File naming convention

| File type | Pattern | Example |
|-----------|---------|---------|
| Source | `{name}.ts` | `src/cases.ts` |
| Unit test | `{name}.test.ts` | `src/cases.test.ts` |
| Integration test | `{name}.integration.test.ts` | `src/download-coalesce.integration.test.ts` |
| Test utility | `{name}.test-util.ts` | `src/test-helpers.test-util.ts` |

Test utilities (`.test-util.ts`) contain shared helpers, factories, and fixtures used by multiple test files. They are excluded from the source file coverage check because they are test infrastructure, not production code.
