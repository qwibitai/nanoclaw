---
name: pr-test-plan
description: Generate a high-level, human-readable test plan for a PR to qwibitai/nanoclaw. Covers what needs testing, why, and any special requirements — not the detailed how. The testing agent on the VM handles execution. Use when the PR flow reaches the test planning stage.
---

# PR Test Plan Writer

You receive a PR and produce a high-level, human-readable test plan. This plan is for humans to review and approve before the testing agent picks it up. It covers what needs testing and why, not the step-by-step execution — the testing agent on the VM figures that out from the plan directly.

## Reading the PR

Read the full diff and description. Don't rely on labels or metadata — read the code and understand what's actually happening. Identify:

- **What files changed** — source code, config, container, tests, docs, CI
- **What the change does** — bug fix, new feature, refactor, dependency update, security hardening
- **What systems it touches** — channels, containers, IPC, routing, database, authentication, scheduling
- **What could break** — side effects, shared state, concurrency, config changes that affect other components

## Depth

The nature of the change determines how deep the plan goes. Use industry judgment — a security change is sensitive by nature and needs to be sealed before merge. An architecture change needs broad coverage across happy paths and environments but it's hard to cover every edge case. A docs change needs very little.

| Depth | When | What the plan looks like |
|-------|------|--------------------------|
| **Thorough** | Security, architecture, core flow changes | Multiple test areas, scenarios, security validation, special requirements |
| **Moderate** | Features, core bug fixes, runtime dependency changes | Key scenarios, a few edge cases, regression check |
| **Light** | Simple bug fixes, config changes, test file changes | Verify it works, check for regressions |
| **Minimal** | Docs, CI/tooling, version bumps | Build check, quick verification |

Before finalizing, assess each test area's importance. Test areas that are medium-high importance or above should stay in the plan — these cover failures that would be invisible from end-to-end tests, like privilege escalation via IPC, distinct auth code paths, or security-sensitive regex patterns. Low-importance sections can be cut to keep the plan focused — API response shape variations, UI polish features, redundant build checks.

## Test plan format

```markdown
# Test Plan: PR #<number> — <short title>

**PR:** <link>
**Branch:** <branch name>
**What changed:** <1-2 lines>
**Depth:** <Thorough / Moderate / Light / Minimal>
**Date:** <YYYY-MM-DD>
```

### Summary table (moderate and thorough plans only)

For moderate and thorough plans, add a summary table after the header. Skip this for light and minimal plans — they're short enough to scan as-is.

| # | What's being tested | Priority | Type | Requires |
|---|---------------------|----------|------|----------|
| 1 | One-line description | Must pass / Should pass / Nice to have | E2E / Security / API / Integration / Lifecycle / Regression | capability tags or — |

### Prerequisites

Only non-standard setup — container rebuild, specific channels, new env vars, test data, config changes. If standard, say so.

### What's being tested

Describe the features and flows that need testing at a high level. Lead with the end-to-end perspective — does this work the way a user would experience it? Then list the specific areas that need verification.

For each test area, include:
- **What** — the feature or flow being tested, in one or two lines
- **Why it matters** — what could go wrong if this isn't tested
- **Priority** — must pass, should pass, or nice to have

Don't include exact commands, scripts, or expected log output here — that's the pr-testing skill's job.

### Scenarios and test cases

For moderate and thorough plans, outline the key scenarios. These are the situations that need to be exercised, described at a level a human can review and say "yes, that covers it" or "you're missing X."

For bug fix PRs:
- Verify the fix works from a user's perspective
- Reproduce on main — only if the PR describes a reproduction scenario or it's a core flow
- Regression check — what else could this break?

For feature PRs:
- End-to-end usage through the actual interface
- Happy path scenarios
- Edge cases worth covering
- Backwards compatibility considerations

For architecture/security PRs:
- Blocker check — the most basic thing that must work
- End-to-end — does the system still work from a user's perspective?
- Security-specific scenarios (auth boundaries, credential handling, privilege escalation)
- Lifecycle scenarios (restart, recovery, state persistence)

### Special testing requirements

Flag anything the testing agent needs to know beyond normal testing:

- **Platform compatibility** — if the change behaves differently across Linux, WSL, macOS, note which platforms need separate test runs
- **Database migration** — if the PR adds or modifies schema, note that migration path and fresh install both need coverage
- **Environment-specific setup** — if testing requires Tailscale, a reverse proxy, multiple devices, or other non-standard infrastructure
- **Security validation** — if credentials, tokens, or secrets are involved, note that isolation and redaction need explicit verification
- **Concurrency** — if the change involves parallel execution, scheduling, or shared state, note that race conditions need testing
- **Multi-channel** — if the change could affect other channels, note which ones need regression checks

If there are no special requirements, omit this section.

### Pass/fail criteria

- **Must pass** — the thing the PR is supposed to fix or enable
- **Should pass** — related features that could be affected
- **Nice to have** — edge cases, optional scenarios

## Capability tagging

Each test area in the summary table gets a `Requires` column listing what the test environment needs beyond a standard build/test VM. Use freeform, descriptive tags. If a test area only needs build + unit tests + code access, use `—`.

Examples of capability tags:
- `telegram-channel` — needs an active Telegram group with a connected bot
- `discord-channel` — needs an active Discord server with a connected bot
- `media-send` — needs ability to send images/files through a real channel
- `sentry-credentials` — needs SENTRY_AUTH_TOKEN and SENTRY_ORG configured
- `clean-setup` — needs a VM with no nanoclaw installed (for testing the setup wizard)
- `multi-channel` — needs more than one active channel simultaneously
- `oauth-credentials` — needs OAuth tokens for a specific service

Tags are freeform — use whatever describes the requirement clearly. Keep them short and consistent. Multiple tags are comma-separated.

The testing agent uses these tags to:
1. Select the right VM template (bare vs telegram-connected vs clean-setup)
2. Set realistic expectations — a must-pass item requiring `telegram-channel` on a bare VM is a known coverage gap, not a surprise
3. Report honestly — items whose requirements weren't met get `Method: Code review` or `Method: Skipped` in results

The purpose of the test plan is to verify that the PR does what it claims, doesn't break what it touches, and leaves the user experience working normally. Tag each test area for what it actually requires to be tested properly — if the environment can't satisfy that, an honest `Skipped` result is more valuable than a downgraded test that passes on paper but never exercised the real flow.

## Writing style

Write for a human who needs to understand and approve the testing approach in a few minutes. Keep descriptions at the feature/flow level, not the implementation level. A human should read this and know what's being tested and why without needing to read the PR diff.

## After generating the test plan

Save the plan to the agent's group directory so the host can forward it to the test orchestrator:

```bash
cat > /workspace/agent/PR-{number}-Test-Plan.md << 'PLAN'
(paste the full test plan here)
PLAN
```

The file name **must** follow the pattern `PR-{number}-Test-Plan.md` (e.g., `PR-1702-Test-Plan.md`). The host watches `groups/pr-*/` for these files and SCPs new plans to `pr-factory-orchestrator.exe.xyz:~/inbox/`.

## Notifying the thread

After saving the plan file, send a short summary to the thread — not the full plan. One or two lines:

```
Test plan saved: PR #<number> — <Depth>, <N> test areas (<list the must-pass items briefly>)
```

Example: `Test plan saved: PR #1702 — Moderate, 5 test areas (follow-up message handling, happy path regression)`

## What not to include

- Exact commands, scripts, or curl calls — the pr-testing skill generates those
- Expected log lines or DB query results — those are execution details
- Standard setup steps (clone, npm install, Docker)
- Code review feedback or implementation suggestions