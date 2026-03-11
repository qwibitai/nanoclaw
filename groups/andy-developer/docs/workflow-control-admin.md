# Andy-Developer Workflow Control Admin

Control-plane playbook for the current separation of concerns:

- `Linear` owns issue state, ownership, triage, and platform pickup readiness.
- `Notion` owns shared specs, decisions, research, and nightly rolling context pages.
- `GitHub` owns code review, PRs, Actions, and branch protection.
- repo files own execution contracts and machine artifacts only.

## Scope

Andy-developer may directly change:

- `.github/workflows/*.yml`
- CI and review policy docs
- branch governance docs and operational checklists
- control-plane automation scripts for platform pickup and nightly evaluation
- pre-seeded worker branches (`jarvis-*`) created from an approved `base_branch`

Andy-developer must not directly implement product source code.

## Surface Split

Use exactly one authoritative surface per concern:

- `Linear`: active execution issues, ownership, triage, `Ready` gating, and project state
- `Notion`: shared specs, decisions, research, and nightly shared-context pages
- `GitHub`: branches, PRs, reviews, CI, and merge governance
- repo files: dispatch contracts, catalogs, incidents, diagnostics, and evidence

Do not recreate issue state anywhere outside Linear.

## Standard Sequence

1. Define objective and required checks.
2. Create a dedicated branch (`jarvis-admin-<topic>`).
3. Implement workflow or policy changes.
4. Open a PR with clear risk and rollback notes.
5. Decide review mode: request Claude review only when required by project policy or risk.
6. Merge only after required checks pass.

## Sparse Daytime Platform Pickup Lane

Use the daytime Claude pickup lane only for Linear issues in the `nanoclaw` project that are already decision-complete.

Required runtime surfaces:

- `.claude/commands/platform-pickup.md`
- `scripts/workflow/run-platform-claude-session.sh`
- `scripts/workflow/platform-loop.js`
- `scripts/workflow/platform-loop-sync.sh`
- `scripts/workflow/start-platform-loop.sh`
- `scripts/workflow/trigger-platform-pickup-now.sh`
- `scripts/workflow/check-platform-loop.sh`
- `launchd/com.nanoclaw-platform-loop.plist`

Operating rules:

1. the pickup lane reads and mutates Linear issue state only
2. Notion context may lead to a Linear issue, but Notion pages never make an issue `Ready`
3. before an issue can be marked `Ready`, Codex must normalize scope, acceptance, checks, evidence, blocked conditions, and the `Ready Checklist` on the Linear issue
4. the lane claims only one `Ready` platform issue at a time
5. if any Claude-owned platform item is already `Review`, the lane must no-op
6. the lane writes pickup, review, and blocker outcomes back to the Linear issue and linked PR
7. the lane never edits user project files directly outside the scoped pickup worktree
8. the lane keeps GitHub changes limited to branch, PR, and CI surfaces
9. the lane uses an ephemeral worktree per pickup and removes it automatically after Claude exits when the worktree is clean
10. if the session ends with a dirty worktree, the retained path must be called out in the blocker or handoff note

Scheduler rules:

1. the launchd job is sparse, not hourly
2. scheduled pickups run at `10:00` and `15:00` Asia/Kolkata
3. `scripts/workflow/check-platform-loop.sh` starts a pickup only when another pickup is not already running
4. `scripts/workflow/trigger-platform-pickup-now.sh` is the manual one-shot trigger

## Nightly Improvement Lane

Use the nightly Claude lane for upstream and tooling evaluation only.

Required runtime surfaces:

- `.claude/agents/nightly-improvement-researcher.md`
- `.claude/commands/nightly-improvement-eval.md`
- `scripts/workflow/nightly-improvement.js`
- `scripts/workflow/start-nightly-improvement.sh`
- `launchd/com.nanoclaw-nightly-improvement.plist`
- `.nanoclaw/nightly-improvement/state.json`

Nightly rules:

1. nightly work is research-only and never creates Linear issues or PRs directly
2. scheduled execution is headless via `claude -p`, not an interactive Terminal session
3. the scheduled lane uses the `nightly-improvement-researcher` subagent with model `sonnet`
4. nightly research starts from deterministic scan output, not open-ended browsing
5. previously evaluated upstream heads and tool versions are skipped unless explicitly forced
6. nightly output updates at most one upstream Notion page and one tooling Notion page
7. every nightly decision block uses `Agent Label: Claude Code` with `pilot`, `defer`, or `reject`
8. Codex performs the morning triage and selective promotion into Linear

## Requirement-Based Review Decision

| Profile | `@claude` Review |
|---------|------------------|
| Low-risk internal change | Optional |
| Standard product change | On-demand |
| High-risk/compliance/security-sensitive | Required |

Andy-developer owns this decision for each project or repository.

## Workflow Bundle Selection

| Bundle | Include |
|--------|---------|
| Minimal | build and test only |
| Standard | build and test plus optional `claude-review` workflow |
| Strict | standard plus policy or security checks and stricter merge gates |

Choose the smallest bundle that still satisfies project requirements.

## Required Checks for Mainline Governance

- TypeScript compile and build checks
- test suite checks
- any contract or guardrail checks for dispatch and review flow

## Branch Governance Baseline

- `main` is PR-only
- required checks must pass before merge
- direct pushes to `main` are blocked
- include administrators in protection or ruleset coverage

## Evidence Format for Admin Changes

When reporting completion, include:

- changed workflow file list
- affected required checks
- proof of latest check status
- rollback command or revert PR reference
