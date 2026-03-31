# Self-Reflection Loop Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Agent learns from PR outcomes, respects shared constraints, enforces task count caps, requires approval for expensive operations, and proactively schedules useful work.

**Architecture:** Two TypeScript changes (config constant + IPC guard), three markdown files (constraints, PR outcomes, updated autonomous-think skill), and one CLAUDE.md update. No new database tables or IPC types.

**Tech Stack:** TypeScript (config + IPC), Markdown (skills + knowledge files), existing `gh` CLI for PR outcome checking.

---

### Task 1: Add task count cap config and enforce in IPC

**Files:**
- Modify: `src/config.ts`
- Modify: `src/ipc.ts`
- Modify: `src/db.ts`
- Test: `src/ipc-auth.test.ts` (existing test file for IPC authorization)

- [ ] **Step 1: Write the failing test**

Add to `src/ipc-auth.test.ts`:

```typescript
describe('schedule_task count cap', () => {
  it('rejects schedule_task when group is at task limit', () => {
    // Create MAX_SCHEDULED_TASKS_PER_GROUP active tasks for a group
    const MAX = 10;
    for (let i = 0; i < MAX; i++) {
      createTask({
        id: `cap-test-${i}`,
        group_folder: 'test-group',
        chat_jid: 'test-jid',
        prompt: `task ${i}`,
        schedule_type: 'interval',
        schedule_value: '3600000',
        context_mode: 'isolated',
        next_run: new Date(Date.now() + 3600000).toISOString(),
        status: 'active',
        created_at: new Date().toISOString(),
      });
    }

    const count = getActiveTaskCountForGroup('test-group');
    expect(count).toBe(MAX);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npm test -- --grep "schedule_task count cap"
```

Expected: FAIL — `getActiveTaskCountForGroup` is not defined.

- [ ] **Step 3: Add the config constant**

Add to `src/config.ts` after `MAX_CONTAINERS_PER_GROUP`:

```typescript
export const MAX_SCHEDULED_TASKS_PER_GROUP = Math.max(
  1,
  parseIntEnv(process.env.MAX_SCHEDULED_TASKS_PER_GROUP, 10),
);
```

- [ ] **Step 4: Add getActiveTaskCountForGroup to db.ts**

Add to `src/db.ts` after `getTasksForGroup`:

```typescript
export function getActiveTaskCountForGroup(groupFolder: string): number {
  const row = db
    .prepare(
      'SELECT COUNT(*) as count FROM scheduled_tasks WHERE group_folder = ? AND status = ?',
    )
    .get(groupFolder, 'active') as { count: number };
  return row.count;
}
```

- [ ] **Step 5: Enforce the cap in the schedule_task IPC handler**

In `src/ipc.ts`, in the `schedule_task` case (around line 888, before `createTask`), add:

```typescript
        // Enforce task count cap per group
        const activeCount = getActiveTaskCountForGroup(targetFolder);
        if (activeCount >= MAX_SCHEDULED_TASKS_PER_GROUP) {
          logger.warn(
            { sourceGroup, targetFolder, activeCount, max: MAX_SCHEDULED_TASKS_PER_GROUP },
            'Task count cap reached, rejecting schedule_task',
          );
          break;
        }
```

Add the imports at the top of `src/ipc.ts`:

```typescript
import { MAX_SCHEDULED_TASKS_PER_GROUP } from './config.js';
import { getActiveTaskCountForGroup } from './db.js';
```

- [ ] **Step 6: Run tests**

```bash
npm test
```

Expected: All tests pass including the new one.

- [ ] **Step 7: Commit**

```bash
git add src/config.ts src/db.ts src/ipc.ts src/ipc-auth.test.ts
git commit -m "feat: add task count cap per group (MAX_SCHEDULED_TASKS_PER_GROUP=10)"
```

---

### Task 2: Create shared constraints file

**Files:**
- Create: `groups/global/knowledge/constraints.md`

- [ ] **Step 1: Create the knowledge directory**

```bash
mkdir -p groups/global/knowledge
```

- [ ] **Step 2: Write the constraints file**

Create `groups/global/knowledge/constraints.md`:

```markdown
# Constraints

Known limitations and preferences. Check this before proposing skills, integrations, or improvements.

Last updated: 2026-03-31

## Geographic
- User is in Vancouver, BC, Canada
- No US-only APIs (e.g., Alpaca Markets is not available to Canadians)
- Prefer services with Canadian or international availability

## Cost
- Prefer free-tier services where possible
- Don't add paid API dependencies without asking first
- Be mindful of container runtime costs when scheduling recurring tasks

## Technical
- Container images are ephemeral — pip installs happen on every container start
- /workspace/project/ is read-only — all code changes go through the PR workflow
- Auto-deploy pulls origin/main every 2 minutes — merged PRs go live quickly
```

- [ ] **Step 3: Commit**

```bash
git add groups/global/knowledge/constraints.md
git commit -m "feat: add shared constraints file for cross-group awareness"
```

Note: the `.gitignore` has `groups/*/knowledge/` ignored. We need to add an exception for global knowledge.

- [ ] **Step 4: Update .gitignore if needed**

Check if `groups/global/knowledge/` is tracked. If ignored, add exception to `.gitignore`:

```
!groups/global/knowledge/
!groups/global/knowledge/**
```

Then re-add and amend the commit:

```bash
git add .gitignore groups/global/knowledge/constraints.md
git commit --amend --no-edit
```

---

### Task 3: Create PR outcomes file

**Files:**
- Create: `groups/global/knowledge/pr-outcomes.md`

- [ ] **Step 1: Write the PR outcomes file**

Create `groups/global/knowledge/pr-outcomes.md`:

```markdown
# PR Outcomes

Track which PRs were merged vs closed to learn from patterns. Updated by the deep think loop.

## Merged


## Rejected


## Lessons

- Check API geographic availability before proposing integrations (learned from Alpaca PRs #51, #54)
```

- [ ] **Step 2: Commit**

```bash
git add groups/global/knowledge/pr-outcomes.md
git commit -m "feat: add PR outcomes tracking file for self-reflection"
```

---

### Task 4: Update autonomous-think skill

**Files:**
- Modify: `container/skills-catalog/local/autonomous-think/SKILL.md`

- [ ] **Step 1: Add PR outcome tracking to the deep think loop**

Insert after the existing "Compile digest" step (step 3) in the "Think Loop — Deep" section, making it step 3 and renumbering:

```markdown
3. **Track PR outcomes** — run `gh pr list --state closed --author @me --limit 10 --json number,title,state,mergedAt,closedAt,body` to check recently closed PRs. For each:
   - If merged: note as successful in `/workspace/global/knowledge/pr-outcomes.md` under "Merged"
   - If closed without merge: read close comments (`gh pr view <number> --comments`), extract the reason, add to "Rejected" and "Lessons"
   - Skip PRs already recorded in the file
```

- [ ] **Step 2: Add constraints checking instruction**

Insert a new section after "Autonomy Tiers", before "Think Loop — Fast":

```markdown
## Constraints Awareness

Before proposing any skill, integration, or improvement:
1. Read `/workspace/global/knowledge/constraints.md` for known limitations
2. Read `/workspace/global/knowledge/pr-outcomes.md` for lessons from past rejections
3. If your proposal conflicts with a known constraint, skip it

When you learn a new constraint (from user feedback, PR rejection, or conversation), update `constraints.md` with the new entry.
```

- [ ] **Step 3: Update autonomy tiers for tiered approval**

Replace the existing Tier 2 and Tier 3 entries with:

```markdown
### Tier 2 — Do with notification (act, then mention in digest)
- Create PRs for your own work
- Post comments on others' PRs
- Schedule new **one-shot** tasks for yourself
- Reorganize knowledge base structure
- Propose skills or improvements (via PR)

### Tier 3 — Ask first (post to Discord and wait for response)
- Create **recurring** scheduled tasks (cron or interval)
- Escalate to goal mode (extended container time)
- Merge or close PRs
- Delete files or branches
- Message outside Discord
- Any action with significant cost
- Anything you are uncertain about
```

- [ ] **Step 4: Add proactive scheduling section**

Insert before the "Digest Format" section:

```markdown
## Proactive Scheduling

After reviewing conversations and knowledge during the deep think loop, consider:
- Are there recurring questions or tasks the user keeps asking about that should be automated?
- Are there monitoring tasks that would catch issues earlier (build failures, service health, etc.)?
- Are there data gathering tasks that would make future conversations more informed?

If you identify a good candidate:
1. Check `constraints.md` — does it conflict with any known limitation?
2. Check the task count — if the group is near its limit (10 active tasks), pause or cancel a low-value task first
3. For one-shot tasks: schedule directly (Tier 2 — notify in digest)
4. For recurring tasks: ask the user first (Tier 3 — post to Discord and wait for approval)

Frame your approval request clearly:
> "I'd like to schedule a recurring task: **{description}**. It would run every **{interval}** and help with **{benefit}**. This uses container time on each run. Approve?"
```

- [ ] **Step 5: Validate the skill**

```bash
./container/skills-catalog/validate-skill.sh local/autonomous-think
```

Expected: PASSED

- [ ] **Step 6: Commit**

```bash
git add container/skills-catalog/local/autonomous-think/SKILL.md
git commit -m "feat: update autonomous-think with PR tracking, constraints, proactive scheduling"
```

---

### Task 5: Update global CLAUDE.md

**Files:**
- Modify: `groups/global/CLAUDE.md`

- [ ] **Step 1: Add cross-group knowledge sharing instruction**

Insert after the "Knowledge Base" section (after line 191 "skip it."), before "Use Subagents":

```markdown
## Cross-Group Knowledge Sharing

Some knowledge applies to all groups, not just yours. When you learn something that other groups should know about, write it to the **global** knowledge directory (mounted at `/workspace/global/knowledge/` for non-main groups).

### What goes in global knowledge
- **Constraints** (`/workspace/global/knowledge/constraints.md`) — API limitations, geographic restrictions, cost preferences, technical limitations. If a constraint would prevent another group from proposing something that won't work, it belongs here.
- **PR outcomes** (`/workspace/global/knowledge/pr-outcomes.md`) — which PRs were merged or rejected and why. Updated by the deep think loop. Don't edit this directly unless correcting an error.

### What stays in local knowledge
- Group-specific project details
- Conversation context
- People notes
- Anything only relevant to your group's work
```

- [ ] **Step 2: Commit**

```bash
git add groups/global/CLAUDE.md
git commit -m "feat: add cross-group knowledge sharing instructions to global CLAUDE.md"
```

---

### Task 6: End-to-end validation

- [ ] **Step 1: Verify all files exist**

```bash
test -f groups/global/knowledge/constraints.md && echo "OK: constraints.md"
test -f groups/global/knowledge/pr-outcomes.md && echo "OK: pr-outcomes.md"
test -f container/skills-catalog/local/autonomous-think/SKILL.md && echo "OK: autonomous-think skill"
test -f groups/global/CLAUDE.md && echo "OK: global CLAUDE.md"
```

Expected: All OK.

- [ ] **Step 2: Verify autonomous-think skill validates**

```bash
./container/skills-catalog/validate-skill.sh local/autonomous-think
```

Expected: PASSED

- [ ] **Step 3: Verify TypeScript builds and tests pass**

```bash
npm run build && npm test
```

Expected: Build succeeds, all tests pass.

- [ ] **Step 4: Verify git log**

```bash
git log --oneline -8
```

Expected: 5 new commits (task cap, constraints, PR outcomes, autonomous-think update, global CLAUDE.md).
