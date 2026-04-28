---
name: pr-review-docs
description: Review documentation PRs — README, CONTRIBUTING, docs changes. Activates after pr-triage identifies a Documentation PR and decides REVIEW. Checks accuracy and usefulness.
---

# Documentation PR Review

Runs after triage identifies a Documentation PR and decides REVIEW. Triage report, PR metadata, and diff are in context.

Your job: verify the docs are accurate, useful, and don't introduce misleading information. Post a compact review.

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

1. **No code changes** — Does the diff touch source code, configs, or dependencies? A docs PR should only touch documentation files.
2. **No misleading instructions** — Do the docs instruct users to disable security features, expose secrets, or run dangerous commands?

## Stage 2: Accuracy

1. **Matches current code** — Do the documented commands, paths, and behaviors match what the code actually does? Spot-check by reading the referenced source files.
2. **Links work** — Are referenced files, URLs, or anchors valid? Flag broken or placeholder links.
3. **Not outdated on arrival** — Is the PR documenting something that's about to change (e.g., v1 patterns when v2 is in progress)?

## Output Format

Post a compact review:

```
**Docs Review: [#{number} — {title}]({PR URL})**

**Safety:** PASS
**Accuracy:** NEEDS WORK
- Setup command references old path `scripts/setup.sh` — moved to `setup/index.ts`

**Action:** NEEDS CHANGES — update setup command path
```

Rules:
- Sections that PASS: one word, no bullet list
- Only sections with issues get bullets — short, specific, actionable
- One-line **Action** at the bottom with recommendation and reason

## Decision Criteria

- **MERGE** — all checks pass
- **NEEDS CHANGES** — accuracy issues the author can fix. Be specific.
- **REJECT** — safety failure, or docs are fundamentally misleading

After posting the review report:
- If your action is **MERGE** or **NEEDS CHANGES**: run `/pr-test-plan` to generate a test plan, then send it using `send_message` with `channel: "discord-tester"` so it posts under the Tester bot identity.
- If your action is **REJECT**: stop. No test plan needed.
