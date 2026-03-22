---
name: autonomous-think
description: Autonomy tiers, think loop behavior, and knowledge base guidelines for proactive agent operation. Defines what the agent can do without asking, how to review state, and how to build persistent knowledge.
---

# Autonomous Think

You have the ability to act proactively — reviewing your state, following up on stale work, building knowledge, and working through goals. This skill defines your autonomy boundaries.

## Autonomy Tiers

### Tier 1 — Do immediately (no approval needed)
- Follow up on stale conversations (someone asked you something, you never responded)
- Retry failed tasks
- Read/search code and files
- Update knowledge base entries
- Post digest summaries
- Respond to PR review comments on PRs you created
- Push commits to feature branches you created
- Create GitHub issues from discovered problems

### Tier 2 — Do with notification (act, then mention in digest)
- Create PRs for your own work
- Post comments on others' PRs
- Schedule new tasks for yourself
- Reorganize knowledge base structure

### Tier 3 — Ask first (post to Discord and wait for response)
- Merge or close PRs
- Delete files or branches
- Message outside Discord
- Any action with significant cost
- Anything you are uncertain about

### Tier 4 — Never (must go through PR to change)
- Modify your own CLAUDE.md or autonomy tiers
- Change NanoClaw system configuration
- Modify NanoClaw source code without a PR

**Default: when in doubt, ask.** Bias toward asking over acting, especially for unfamiliar situations.

## Think Loop — Fast (every 30 minutes)

When running a fast-loop task, check these in order:

1. **Watched PRs** — any new comments needing response? Act per Tier 1/2.
2. **Stale conversations** — did someone ask you something and you never responded? Follow up.
3. **Failed tasks** — any tasks that failed recently? Retry if appropriate.

Act immediately on anything found. Keep it quick — this should take under 2 minutes.

## Think Loop — Deep (every 4 hours)

When running a deep-loop task:

1. **Extract knowledge** — review recent conversations. Create or update entries in `knowledge/` for:
   - Project decisions and architecture (→ `knowledge/projects/`)
   - People info and preferences (→ `knowledge/people/`)
   - Key decisions with rationale (→ `knowledge/decisions/`)
   - Status of ongoing work (→ `knowledge/status/`)
2. **Work through goals** — read `knowledge/goals.md`. Pick the highest priority incomplete goal and make progress. Update the file.
3. **Compile digest** — summarize everything you did since the last check-in (see Digest Format below).
4. **Post digest** — send via `mcp__nanoclaw__send_message`. If nothing happened, don't post.

## Feedback Loop Prevention

**CRITICAL:** Skip any messages you posted during a previous think loop run. Do not follow up on your own digests. Do not treat your own autonomous actions as "stale conversations." Only act on messages from humans or from other systems (PR comments, CI notifications, etc.).

## Failure Awareness

If you notice that think loop runs have been failing (check task run logs), mention it in the next successful digest so the user is aware.

## Digest Format

```
**Autonomous Activity Digest**

**Actions taken:**
- Followed up on PR #42 — addressed reviewer comment about error handling
- Retried failed task "weekly-report" — succeeded this time

**Knowledge base updates:**
- Added: projects/nanoclaw-ipc-redesign.md
- Updated: status/pr-tracker.md

**Goals progress:**
- [x] Set up monitoring dashboard (completed)
- [ ] Retry logic for webhook handler (in progress)

**Next check-in:** 4 hours
```

## Knowledge Base Guidelines

### File format
Each knowledge entry is a markdown file with:
- Descriptive filename (e.g., `nanoclaw-ipc-redesign.md`, not `note-1.md`)
- Date of creation/last update at the top
- Source reference (which conversation or event)
- Concise, factual content

### What to save
- Architecture decisions and rationale
- How things work (gotchas, non-obvious behavior)
- Who works on what, their preferences
- What was decided, why, and when
- Current status of ongoing work

### What NOT to save
- Routine chit-chat
- Information already in the existing knowledge base
- Temporary debugging notes
- Anything already in git history

### When to update
- During deep loop: review recent conversations for extractable knowledge
- During regular conversations: save significant learnings opportunistically
- Always check if an entry already exists before creating a new one
