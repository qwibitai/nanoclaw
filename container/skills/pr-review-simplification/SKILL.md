---
name: pr-review-simplification
description: Review simplification PRs — code reduction without behavior change. Activates after pr-triage identifies a Simplification and decides REVIEW. Checks safety, behavior preservation, and that the code actually got simpler.
---

# Simplification PR Review

Runs after triage identifies a Simplification PR and decides REVIEW. Triage report, PR metadata, and diff are in context.

Your job: verify the simplification is safe, preserves existing behavior, and actually makes the code simpler. Post a compact review.

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

1. **No hidden features** — Does the diff sneak in new behavior, new dependencies, or new capabilities disguised as simplification?
2. **Scope** — Is the diff limited to simplification? Flag unrelated fixes, feature additions, or config changes bundled in.

## Stage 2: Behavior Preservation

The whole point of a simplification is that nothing changes for users.

1. **Same behavior** — Does the simplified code still handle the same inputs and produce the same results? Look for dropped edge cases, changed defaults, or removed error handling that callers depend on.

## Stage 3: Simplification Value

Not every deletion makes code simpler. Verify the change is a real improvement.

1. **Net reduction** — Does the diff remove more than it adds? A "simplification" that grows the codebase is suspicious.
2. **Readability improved** — Is the result easier to understand, not just shorter? Replacing clear verbose code with clever one-liners is not simplification.
3. **No premature abstraction** — Does it replace concrete code with abstractions that aren't justified by multiple use sites?

## Output Format

Post a compact review:

```
**Simplification Review: [#{number} — {title}]({PR URL})**

**Safety:** PASS
**Behavior:** PASS
**Value:** NEEDS WORK
- Replaces explicit error handling with generic catch-all — harder to debug

**Action:** NEEDS CHANGES — keep explicit error handling, simplify the happy path only
```

Rules:
- Sections that PASS: one word, no bullet list
- Only sections with issues get bullets — short, specific, actionable
- One-line **Action** at the bottom with recommendation and reason

## Decision Criteria

- **MERGE** — all checks pass
- **NEEDS CHANGES** — safety passes, but behavior or value issues. Be specific.
- **REJECT** — safety failure, or change introduces new behavior disguised as simplification

After posting the review report:
- If your action is **MERGE** or **NEEDS CHANGES**: run `/pr-test-plan` to generate a test plan, then send it using `send_message` with `channel: "discord-tester"` so it posts under the Tester bot identity.
- If your action is **REJECT**: stop. No test plan needed.
