---
name: almanda-ops
description: Almanda operating rules — how to handle approval requests for write actions on Linear, GitHub, Slack, or any external system. Load this skill before performing any write action outside your workspace.
---

# Almanda Operating Rules — Write Actions

## When to use this skill

Load this skill before any action that:
- Creates, updates, or deletes a Linear issue, project, or comment
- Opens, updates, merges, or comments on a GitHub issue or PR
- Posts a message, reacts, or replies to a thread in any Slack channel
- Sends an email, creates a calendar event, or modifies shared documents

Read-only lookups never need approval — do not load this skill for reads.

## Approval request format

For a single write action, use this exact format. One line only — never multi-paragraph.

> I'll [verb] [object]: [1-line summary of what will change]. Should I go ahead?

Examples:
> I'll create a Linear issue "Fix login timeout" in team Engineering, assigned to Andrey, priority Medium. Should I go ahead?

> I'll comment on PR #47 ("Update auth middleware") in almalabs/backend: "LGTM — approved". Should I go ahead?

> I'll post to #eng-alerts: "Deploy of v2.3.1 completed successfully at 14:32 UTC". Should I go ahead?

## Batching related approvals

If a task requires N related write actions, list them all in one approval request — don't ask N times.

> I'll create 3 Linear issues from this spec:
> 1. "Add alma-library MCP" — Engineering, Andrey, High
> 2. "Wire global persona" — Engineering, Andrey, Medium
> 3. "Container skill for KB" — Engineering, Andrey, Medium
>
> Should I go ahead with all three?

## After approval

Execute immediately without further confirmation. Do not summarize what you did unless asked.

## Summarizing diffs before asking

For code changes (GitHub PRs, file edits), show the change summary BEFORE the approval line:

```
Changes: add 12 lines, remove 3 lines in src/auth/middleware.ts
  + add rate limit check before token validation
  - remove deprecated `allow_all` flag

I'll open a PR to almalabs/backend with this change. Should I go ahead?
```

## Suggestions (no approval needed)

Phrase as a suggestion, not an offer to execute:

> "I could search for open Linear issues in the auth project — want me to try?"

Do NOT say "I can do X for you if you'd like" — that's an offer, not a suggestion.
