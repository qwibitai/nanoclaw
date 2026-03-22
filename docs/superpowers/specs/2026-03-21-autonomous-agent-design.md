# Autonomous Agent Design

## Problem

The NanoClaw agent (Jarvis) is purely reactive — it only acts when triggered by a message. The user wants the agent to proactively follow up on conversations, maintain a knowledge base, work through goals, and handle routine tasks without being asked.

## Goals

1. Agent periodically reviews its state and decides what to do
2. Clear autonomy tiers define what the agent can do without asking
3. Agent proactively extracts and organizes knowledge from conversations
4. Architecture supports future multi-group orchestration without requiring it now

## Non-Goals

- Multi-group orchestration (future, but door left open)
- New infrastructure or message types — uses existing scheduled tasks
- Custom UI or dashboard for autonomous activity

## Design

### 1. Autonomous Think Loop

Two scheduled tasks running in `discord_general` with `context_mode: 'group'` (shares session/conversation history):

**Fast loop — every 30 minutes:**
- Check watched PRs for new comments needing response
- Detect conversations that went quiet mid-thread (agent was asked something, never responded due to error/timeout)
- Check for failed tasks that should be retried
- Act immediately on anything found, per autonomy tiers

**Deep loop — every 4 hours:**
- Review recent conversations and extract knowledge (decisions, preferences, project facts, people context)
- Read and work through the goals list (`knowledge/goals.md` in the group folder)
- Organize and update the knowledge base
- Compile a digest of all autonomous actions taken since last check-in and post to Discord

Both loops are standard scheduled tasks — no new infrastructure. The intelligence is in the prompts and the skill they reference.

**Failure handling:** If a think loop run fails (timeout, API error, crash), the task scheduler logs the error and computes the next run time normally — no special backoff. If the same loop fails 3 consecutive times, the skill instructs the agent to post a brief error notice to Discord on the next successful run so the user is aware.

**Feedback loop prevention:** The think loop MUST ignore its own prior output. The skill explicitly instructs: "Skip any messages you posted during a previous think loop run. Do not follow up on your own digests, do not treat your own autonomous actions as 'stale conversations.' Only act on messages from humans or from other systems (PR comments, CI notifications, etc.)."

### 2. Autonomy Tiers (Container Skill)

A container skill at `container/skills-catalog/local/autonomous-think/SKILL.md`. Since skill loading is per-group (not per-task), this skill will be visible during regular conversations too — this is acceptable and helps the agent maintain consistent behavior.

**Tier 1 — Do immediately (no approval):**
- Follow up on stale conversations
- Retry failed tasks
- Read/search code and files
- Update knowledge base entries
- Post digest summaries to Discord
- Respond to PR review comments on PRs the agent created
- Push commits to feature branches the agent created
- Create GitHub issues from discovered problems

**Tier 2 — Do with notification (act, then mention in digest):**
- Create PRs for the agent's own work
- Post comments on others' PRs
- Schedule new tasks
- Reorganize knowledge base structure

**Tier 3 — Ask first (post to Discord and wait for user response):**
- Merge or close PRs
- Delete files or branches
- Message outside Discord
- Any action with significant cost
- Anything the agent is uncertain about

**Tier 4 — Never (must go through PR to change):**
- Modify its own CLAUDE.md or autonomy tiers
- Change NanoClaw system configuration
- Modify NanoClaw source code without a PR

**Default behavior:** When in doubt, ask. The agent should bias toward asking over acting, especially early on. Trust expands over time by updating the tiers via PR.

### 3. Knowledge Base

Per-group knowledge stored in the group's filesystem:

```
{group_folder}/knowledge/
  goals.md           # Active and completed goals
  projects/          # Architecture decisions, how things work, gotchas
  people/            # Who works on what, preferences, communication style
  decisions/         # What was decided, why, when, context
  status/            # What's in progress, blocked, completed
```

Each entry is a markdown file with:
- A descriptive filename (e.g., `nanoclaw-ipc-redesign.md`)
- Date of creation/last update
- Source reference (which conversation or event it came from)
- The knowledge itself, concise and factual

The deep loop reviews recent conversations and creates/updates entries. The agent also updates knowledge opportunistically during regular conversations when it learns something significant.

The agent creates the knowledge directories on first run if they don't exist — no special initialization needed since the group folder is writable.

**Why per-group:** Each group's knowledge is scoped to its context. Future multi-group orchestration can read across groups via the global mount (main has project-wide read access).

### 4. Digest Format

Posted to Discord at the end of each deep loop run via the `send_message` MCP tool with `isScheduled` flag (posts to main channel, not a thread):

```
**Autonomous Activity Digest**

**Actions taken:**
- Followed up on PR #42 — addressed reviewer comment about error handling
- Retried failed task "weekly-report" — succeeded this time
- Created issue #15 for stale dependency detected in package.json

**Knowledge base updates:**
- Added: projects/nanoclaw-ipc-redesign.md (from today's conversation)
- Updated: status/pr-tracker.md (3 PRs now merged)

**Goals progress:**
- [x] Set up monitoring dashboard (completed)
- [ ] Retry logic for webhook handler (in progress, PR #44 open)

**Next check-in:** 4 hours
```

If nothing happened, no digest is posted (avoid noise).

### 5. Goals File

`{group_folder}/knowledge/goals.md` — a simple markdown checklist:

```markdown
# Goals

## Active
- [ ] Finish implementing retry logic for webhook handler
- [ ] Review open PRs daily
- [ ] Set up monitoring dashboard

## Completed
- [x] Migrate to processed flag system (2026-03-21)
```

The agent updates this file as it makes progress. The user can edit it directly or ask the agent to add/remove goals via Discord conversation.

### 6. Multi-Group Orchestration (Future Door)

No code built for this now. Design constraints that keep the door open:

- The autonomous-think skill is written generically — references `{group_folder}` paths, not hardcoded group names
- Scheduled tasks already support `targetJid` for cross-group dispatch
- Goals file format works for any group
- Knowledge base structure is consistent across groups
- Digest posting uses `send_message` MCP tool with `isScheduled` flag

A future orchestrator in `main` could: read all groups' knowledge bases, maintain global goals, dispatch tasks to specific groups based on context.

## Implementation Scope

### What to build:

1. **Container skill:** `container/skills-catalog/local/autonomous-think/SKILL.md` — autonomy tiers, think loop instructions, knowledge base guidelines, digest format, feedback loop prevention
2. **Initial goals file:** `groups/discord_general/knowledge/goals.md` — seed with current priorities
3. **Knowledge base directories:** `groups/discord_general/knowledge/{projects,people,decisions,status}/`
4. **Scheduled tasks:** Two tasks created via the agent's MCP tools (fast loop + deep loop) — these are data, not code
5. **Rebuild container:** `./container/build.sh` to include the new skill

### What NOT to build:

- No new TypeScript code in NanoClaw core
- No new IPC message types
- No changes to the task scheduler
- No changes to container-runner or mount system
- No multi-group orchestration code

### Files created/modified:

| File | Action |
|------|--------|
| `container/skills-catalog/local/autonomous-think/SKILL.md` | Create — the skill with autonomy tiers, loop instructions, KB guidelines |
| `groups/discord_general/knowledge/goals.md` | Create — initial goals list |
| `groups/discord_general/knowledge/{projects,people,decisions,status}/` | Create — directory structure |
| `container/skills-catalog/catalog.json` | Auto-updated by `generate-catalog.ts` during build |
