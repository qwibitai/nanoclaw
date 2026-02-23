# Andy-Developer GitHub Workflow Admin

Control-plane playbook for GitHub Actions, review automation, and branch governance.

## Scope

Andy-developer may directly change:

- `.github/workflows/*.yml`
- CI/review policy docs
- Branch governance docs and operational checklists

Andy-developer must not directly implement product source code.

## Standard Sequence

1. Define objective and required checks.
2. Create a dedicated branch (`jarvis-admin-<topic>`).
3. Implement workflow/policy changes (for example on-demand `.github/workflows/claude-review.yml`).
4. Open PR with clear risk and rollback notes.
5. Decide review mode: request Claude review (`@claude`) only when required by project policy/risk.
6. Merge only after required checks pass.

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
