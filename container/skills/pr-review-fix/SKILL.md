---
name: pr-review-fix
description: Review bug fix and security fix PRs. Activates after pr-triage identifies a Fix and decides REVIEW. Checks safety, root cause, and regression risk.
---

# Fix PR Review

Runs after triage identifies a Fix PR and decides REVIEW. Triage report, PR metadata, and diff are in context.

Your job: verify the fix is safe, addresses the root cause, and won't regress the happy path. Post a compact review.

## Before You Start

Extract from context (provided by triage):
- **PR number**, **title**, **author**
- **Repository** (owner/repo)
- **Diff** (may be truncated — see below)

## Truncated Diff Handling

Diff is capped at 50,000 characters. If truncated, fetch files:

```bash
gh api repos/{owner}/{repo}/pulls/{number}/files --jq '.[].filename'
gh api "repos/{owner}/{repo}/contents/{path}?ref={head_branch}" --jq '.content' | base64 -d
```

## Stage 1: Safety

Hard gates. Any failure = REJECT.

1. **Secret exposure** — Does the fix introduce logging of secrets, tokens, or credentials? Does it weaken existing secret handling?
2. **Credentials in container** — Does the fix place API keys, tokens, or credentials into the container (e.g. `settings.json`, env injection, hardcoded values)? This is an architectural violation — credentials must never live inside the container. Two supported alternatives exist: OneCLI (agent vault) and `/use-native-credential-proxy`. Any PR that puts credentials in the container must be REJECTED with a pointer to these alternatives.
3. **Scope** — Is the diff limited to the fix? Flag unrelated refactoring, new features, debug code, or dependency changes bundled in.

## Stage 2: Root Cause

Users almost always misdiagnose the bug. This is the core of the review.

1. **Root cause identified** — Does the PR explain what caused the bug? Is the explanation consistent with the diff?
2. **Fix matches cause** — Does the change address the root cause, or patch a symptom? Symptom-patching: null checks around crashes instead of fixing why the value is null, try/catch to swallow errors instead of preventing them.
3. **Desired vs actual behavior** — Is it clear what the code does today vs what it should do? If the PR doesn't explain this, flag it.

## Stage 3: Regression Risk

Edge case fixes often break the normal flow.

1. **Happy path impact** — Does the fix touch code that runs on every request or message? What's the blast radius?
2. **Edge case scoping** — Is the fix conditional (only triggers in the edge case) or does it change default behavior for all cases?
3. **Test coverage** — Does the PR include a test that reproduces the bug? A fix without a regression test is a flag.

## Output Format

Post a compact review:

```
**Fix Review: [#{number} — {title}]({PR URL})**

**Safety:** PASS
**Root Cause:** PASS
**Regression:** NEEDS WORK
- Modifies message loop error handling — affects all channels

**Action:** NEEDS CHANGES — scope error handling change to affected channel only
```

Rules:
- Sections that PASS: one word, no bullet list
- Only sections with issues get bullets — short, specific, actionable
- One-line **Action** at the bottom with recommendation and reason

## Decision Criteria

- **MERGE** — all checks pass
- **NEEDS CHANGES** — safety passes, but root cause or regression issues. Be specific.
- **REJECT** — safety failure, or fix is fundamentally wrong (patches symptom with high regression risk)

After posting the review report:
- If your action is **MERGE** or **NEEDS CHANGES**: run `/pr-test-plan` to generate a test plan, then send it using `send_message` with `channel: "discord-tester"` so it posts under the Tester bot identity.
- If your action is **REJECT**: stop. No test plan needed.
