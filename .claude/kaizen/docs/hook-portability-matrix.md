# Hook Portability Matrix

This matrix maps each current Claude hook to the best alternative control layer if the repo wants equivalent behavior outside Claude Code.

See also `.claude/kaizen/README.md`.

| Hook | Current event | Current role | Best portable target | Target level | Fidelity | Notes |
|------|---------------|--------------|----------------------|--------------|----------|-------|
| `check-wip.sh` | `SessionStart` | Warn on main checkout and surface existing WIP | launcher wrapper (`codex-wt` / `claude-wt`) plus optional startup summary command | 3 | Weaker UX, stronger isolation if launcher is mandatory | No true Codex session-start equivalent |
| `enforce-worktree-writes.sh` | `PreToolUse` on `Edit|Write` | Block source edits in main checkout | mandatory worktree launcher, read-only main checkout, sandbox policy | 3 | Stronger | Best moved to architecture |
| `enforce-case-worktree.sh` | `PreToolUse` on `Bash` | Block commit/push outside worktree | `pre-commit` and `pre-push` git hooks | 2 | Near-equivalent | Clean command-centric translation |
| `check-dirty-files.sh` | `PreToolUse` on `Bash` | Force explicit handling of dirty files before PR/push | `pre-push` git hook, MCP `create_pr` tool, optional CI advisory on merge | 2 / 2.5 | Partial | `gh pr create` is not a git hook event |
| `check-test-coverage.sh` | `PreToolUse` on `Bash` | Warn on PR create, block merge when source changed without test changes | `pre-push` advisory plus CI required check | 2 | Same or stronger at merge boundary | CI is the durable enforcement layer |
| `check-verification.sh` | `PreToolUse` on `Bash` | Require `Verification` section in PR body and remind on merge | GitHub Action for PR body policy, post-merge notifier | 2 | Same merge gate, weaker local UX | Good CI policy candidate |
| `pr-review-loop.sh` | `PostToolUse` on `Bash` | Maintain review state across PR create, diff, push, merge | MCP review workflow tool | 2.5 | Partial to near-equivalent | Needs a stateful tool, not a simple hook |
| `enforce-pr-review.sh` | `PreToolUse` on `Bash` | Block unrelated commands until self-review is completed | MCP review workflow plus restricted wrapper commands | 2.5 / 3 | Partial | Git hooks cannot block arbitrary later commands |
| `kaizen-reflect.sh` | `PostToolUse` on `Bash` | Prompt reflection after PR create/merge and notify leads after merge | PR template, GitHub Action comment, post-merge notifier, MCP merge tool | 1 / 2 / 2.5 | Partial | Reflection prompt is portable, transcript immediacy is not |
| `verify-before-stop.sh` | `Stop` | Block agent completion if code changed without typecheck/tests | `pre-push`, CI, MCP `mark_done` tool | 2 / 2.5 | Partial | No Codex-native stop hook equivalent |
| `check-cleanup-on-stop.sh` | `Stop` | Warn about orphaned worktree cleanup | launcher/worktree manager, periodic cleanup job, advisory command | 1 / 3 | Partial | Better as automation than stop-time reminder |

## Recommended target stack

If the goal is to preserve the current development flow outside Claude, the best target stack is:

- Level 2 via git hooks
  - worktree-only commit/push
  - dirty-file push gate
  - local verification
- Level 2 via CI / branch protection
  - PR body requirements
  - test and verification policy
- Level 2.5 via MCP
  - PR creation workflow
  - self-review workflow
  - mark-done workflow
  - post-merge maintenance workflow
- Level 3 via architecture
  - mandatory worktree launcher
  - main-checkout source write protection
  - structural trust-boundary enforcement

## Key takeaway

The least portable parts of the current hook system are the Claude lifecycle events:

- `SessionStart`
- `PostToolUse`
- `Stop`
- arbitrary command gating across multiple later actions

The most portable parts are the policy decisions themselves:

- worktree isolation
- explicit review
- verification before shipping
- no dirty forgotten files
- post-merge accountability

Those policies should be treated as the stable design. Claude hooks are only one implementation strategy.
