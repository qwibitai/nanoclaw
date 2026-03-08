# Andy-Developer GitHub Workflow Admin

Control-plane playbook for GitHub Actions, review automation, and branch governance.

## Scope

Andy-developer may directly change:

- `.github/workflows/*.yml`
- CI/review policy docs
- Branch governance docs and operational checklists
- Pre-seeded worker branches (`jarvis-*`) created from an approved `base_branch`

Andy-developer must not directly implement product source code.

## Project Board Split

Use separate boards only when they represent different domains:

- `NanoClaw Platform`:
  - NanoClaw functionality and features
  - runtime/worker contracts
  - SDK/tooling adoption
  - GitHub governance/control-plane changes
- `Andy/Jarvis Delivery`:
  - user-provided project work
  - project delivery tasks and follow-ups

Rules:

1. one execution item belongs to one board only
2. if delivery work is blocked by platform work, create a linked platform Issue instead of duplicating the item on both boards
3. SDK/tooling discussions promote to `NanoClaw Platform` by default unless explicitly scoped to project delivery
4. `Andy/Jarvis Delivery` board state is host-managed from runtime request/worker transitions, not worker-authored GitHub edits

## Standard Sequence

1. Define objective and required checks.
2. Create a dedicated branch (`jarvis-admin-<topic>`).
3. Implement workflow/policy changes (for example on-demand `.github/workflows/claude-review.yml`).
4. Open PR with clear risk and rollback notes.
5. Decide review mode: request Claude review (`@claude`) only when required by project policy/risk.
6. Merge only after required checks pass.

## NanoClaw Platform Claude Loop

Use the dedicated Claude `/loop` lane only for `NanoClaw Platform` issues that are already decision-complete.

Required runtime surfaces:

- `.claude/commands/platform-pickup.md`
- `scripts/workflow/platform-loop.js`
- `scripts/workflow/start-platform-loop.sh`
- `scripts/workflow/check-platform-loop.sh`
- `launchd/com.nanoclaw-platform-loop.plist`

Operating rules:

1. the loop claims only one `Ready for Dispatch` platform issue at a time
2. if any platform item is already `Review Queue`, the loop must no-op
3. the loop must move active implementation to `Claude Running`
4. the loop must move review-ready PRs to `Review Queue`
5. on ambiguity or failed required checks, the loop must move the item to `Blocked` with a concrete `Next Decision`
6. Codex is the default review lane after the loop finishes implementation
7. merge remains human-only

CLI mode rule:

1. use an interactive Claude Code session for `/loop`
2. do not use `claude -p` to invoke `/platform-pickup`, because headless mode is for non-interactive prompts and interactive slash commands are unavailable there

## Requirement-Based Review Decision

| Profile | `@claude` Review |
|---------|------------------|
| Low-risk internal change | Optional |
| Standard product change | On-demand (recommended) |
| High-risk/compliance/security-sensitive | Required |

Andy-developer owns this decision for each project/repository.

## Workflow Bundle Selection

| Bundle | Include |
|--------|---------|
| Minimal | build/test only |
| Standard | build/test + optional `claude-review` workflow |
| Strict | standard + policy/security checks + stricter merge gates |

Choose the smallest bundle that still satisfies project requirements.

## Required Checks for Mainline Governance

- TypeScript compile/build checks
- Test suite checks
- Any contract/guardrail checks for dispatch/review flow

## Branch Governance Baseline

- `main` is PR-only.
- Required checks must pass before merge.
- Direct pushes to `main` are blocked.
- Include administrators in protection/ruleset.

## Evidence Format for Admin Changes

When reporting completion, include:

- changed workflow file list
- affected required checks
- proof of latest check status
- rollback command or revert PR reference
