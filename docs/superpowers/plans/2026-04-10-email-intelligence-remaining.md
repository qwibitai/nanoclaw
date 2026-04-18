# Email Intelligence — Remaining Items Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix 10 remaining items to make the email intelligence pipeline reliable end-to-end: agent processes triggers (not forwards), emails have subject/sender, SSE stays alive, Discord token reaches containers, approval flow works, and operational guardrails are in place.

**Architecture:** The fixes span two repos (NanoClaw + superpilot). NanoClaw changes are all in this repo. Superpilot changes need to be done in `~/dev/inbox_superpilot`. The core fix is making the IPC email_trigger handler spawn an agent session instead of sending a raw message to Telegram. Secondary fixes improve data quality (subject/sender), reliability (SSE keepalive), and operational completeness (cost tracking, budget enforcement).

**Tech Stack:** Node.js/TypeScript (NanoClaw), Python/FastAPI (superpilot), SQLite, Docker containers, SSE

**Dependency Graph:**
```
Task 1 (agent processing) ← foundation for everything
Task 2 (subject/sender)   ← independent, superpilot-side
Task 3 (SSE keepalive)    ← independent, superpilot-side  
Task 4 (Discord token)    ← independent, NanoClaw-side
Task 5 (Gmail Push)       ← depends on Task 2
Task 6 (superpilot CI)    ← independent, superpilot-side
Task 7 (approval flow)    ← depends on Task 1
Task 8 (VIP contacts)     ← independent, config-only
Task 9 (cost tracking)    ← independent, NanoClaw-side
Task 10 (budget ceiling)  ← depends on Task 9
```

**Parallelization:** Tasks 1-4 are independent and can run in parallel. Tasks 2, 3, 6 are superpilot-side. Tasks 5, 7 depend on earlier work. Tasks 8-10 are independent lower-priority items.

---

## File Structure

### NanoClaw (this repo)

| File | Change | Purpose |
|------|--------|---------|
| `src/ipc.ts` | Modify (lines 472-525) | Replace `sendMessage` with agent invocation via queue |
| `src/email-sse.ts` | Modify (lines 157-201) | Pass subject/sender from SSE events |
| `src/container-runner.ts` | Modify (lines 64-199) | Verify DISCORD_BOT_TOKEN env var injection |
| `src/index.ts` | Modify (lines 715-749) | Add `runAgent` / `enqueueTask` to IPC deps |
| `src/config.ts` | Modify | Add DAILY_BUDGET_USD config |
| `src/db.ts` | Modify | Add cost tracking query helpers |
| `groups/main/CLAUDE.md` | Modify | Add VIP contacts section |
| `src/ipc.ts` | Modify | Add approval message parsing |

### Superpilot (`~/dev/inbox_superpilot`)

| File | Change | Purpose |
|------|--------|---------|
| `app/api/nanoclaw/triaged-emails/route.ts` | Modify | Join email_threads to get subject/sender |
| `app/api/nanoclaw/events/route.ts` | Modify | Include subject/sender in SSE events, add keepalive |
| `app/api/nanoclaw/ipc-writer/route.ts` | Create or modify | Gmail Push webhook → IPC trigger |
| `tests/AuthGate.test.tsx` | Fix | Unblock CI |

---

## Task 1: Fix Agent Processing — IPC Triggers Spawn Agent Sessions

**Problem:** `src/ipc.ts:519` calls `deps.sendMessage(targetJid, prompt)` which sends the raw prompt as a Telegram message. The agent never processes emails — the user just sees the raw instructions.

**Fix:** Instead of sending a message, enqueue a task via the group queue that spawns a container agent with the prompt. The agent processes the emails inside the container and sends clean proposals back to Telegram.

**Files:**
- Modify: `src/ipc.ts:472-525`
- Modify: `src/index.ts:715-749` (add `enqueueTask` to IPC deps)

- [ ] **Step 1: Add `enqueueTask` and `runAgent` to IPC deps interface**

In `src/ipc.ts`, add two new deps to the `IpcDeps` interface:

```typescript
export interface IpcDeps {
  sendMessage: (jid: string, text: string) => Promise<void>;
  registeredGroups: () => Record<string, RegisteredGroup>;
  registerGroup: (jid: string, group: RegisteredGroup) => void;
  syncGroups: (force: boolean) => Promise<void>;
  getAvailableGroups: () => AvailableGroup[];
  writeGroupsSnapshot: (
    groupFolder: string,
    isMain: boolean,
    availableGroups: AvailableGroup[],
    registeredJids: Set<string>,
  ) => void;
  onTasksChanged: () => void;
  // NEW: spawn agent for email triggers instead of sending raw messages
  enqueueEmailTrigger: (
    chatJid: string,
    prompt: string,
    onResult: (text: string) => Promise<void>,
  ) => void;
}
```

- [ ] **Step 2: Replace sendMessage with enqueueEmailTrigger in email_trigger handler**

Replace lines 493-523 in `src/ipc.ts`:

```typescript
    case 'email_trigger': {
      if (!isMain) {
        logger.warn(
          { sourceGroup },
          'Unauthorized email_trigger attempt blocked',
        );
        break;
      }

      const { EMAIL_INTELLIGENCE_ENABLED } = await import('./config.js');
      if (!EMAIL_INTELLIGENCE_ENABLED) {
        logger.debug('Email intelligence disabled, skipping trigger');
        break;
      }

      const emailCount = data.emails?.length ?? 0;
      if (emailCount === 0) {
        logger.debug('Email trigger with no emails, skipping');
        break;
      }

      const emailSummaries = (data.emails ?? [])
        .map(
          (e) =>
            `- [${e.account}] From: ${e.sender || 'unknown'}, Subject: ${e.subject || '(no subject)'} (thread: ${e.thread_id})`,
        )
        .join('\n');

      const prompt = `## Email Intelligence Trigger\n\n${emailCount} new email(s) to process:\n\n${emailSummaries}\n\nFollow the Email Intelligence instructions in your CLAUDE.md. For each email:\n1. Check if already processed (search processed_items)\n2. Use superpilot MCP to get full context\n3. Classify action tier (AUTO/PROPOSE/ESCALATE)\n4. Act accordingly\n5. Mark as processed`;

      // Find the main group's JID to run the agent in
      const registeredGroups = deps.registeredGroups();
      const mainEntry = Object.entries(registeredGroups).find(
        ([, g]) => g.isMain,
      );

      if (!mainEntry) {
        logger.warn('No main group registered, cannot process email trigger');
        break;
      }

      const [mainJid] = mainEntry;

      // Find Telegram JID for forwarding agent results
      const telegramJid = Object.entries(registeredGroups).find(([jid]) =>
        jid.startsWith('tg:'),
      )?.[0];
      const notifyJid = telegramJid || mainJid;

      deps.enqueueEmailTrigger(
        mainJid,
        prompt,
        async (resultText: string) => {
          // Forward agent's clean output to Telegram (or main group)
          await deps.sendMessage(notifyJid, resultText);
        },
      );

      logger.info(
        { emailCount, sourceGroup, mainJid, notifyJid },
        'Email trigger enqueued for agent processing',
      );
      break;
    }
```

- [ ] **Step 3: Wire enqueueEmailTrigger in index.ts**

In `src/index.ts`, add the `enqueueEmailTrigger` implementation to the IPC deps (around line 715):

```typescript
  startIpcWatcher({
    sendMessage: (jid, text) => {
      const channel = findChannel(channels, jid);
      if (!channel) throw new Error(`No channel for JID: ${jid}`);
      return channel.sendMessage(jid, text);
    },
    registeredGroups: () => registeredGroups,
    registerGroup,
    syncGroups: async (force: boolean) => {
      await Promise.all(
        channels
          .filter((ch) => ch.syncGroups)
          .map((ch) => ch.syncGroups!(force)),
      );
    },
    getAvailableGroups,
    writeGroupsSnapshot: (gf, im, ag, rj) =>
      writeGroupsSnapshot(gf, im, ag, rj),
    onTasksChanged: () => {
      const tasks = getAllTasks();
      const taskRows = tasks.map((t) => ({
        id: t.id,
        groupFolder: t.group_folder,
        prompt: t.prompt,
        script: t.script || undefined,
        schedule_type: t.schedule_type,
        schedule_value: t.schedule_value,
        status: t.status,
        next_run: t.next_run,
      }));
      for (const group of Object.values(registeredGroups)) {
        writeTasksSnapshot(group.folder, group.isMain === true, taskRows);
      }
    },
    enqueueEmailTrigger: (chatJid, prompt, onResult) => {
      const taskId = `email-trigger-${Date.now()}`;
      queue.enqueueTask(chatJid, taskId, async () => {
        const group = registeredGroups[chatJid];
        if (!group) {
          logger.warn({ chatJid }, 'No group for email trigger');
          return;
        }

        const result = await runAgent(group, prompt, chatJid, async (output) => {
          if (output.result) {
            await onResult(output.result);
          }
        });

        if (result === 'error') {
          const channel = findChannel(channels, chatJid);
          const telegramJid = Object.keys(registeredGroups).find((jid) =>
            jid.startsWith('tg:'),
          );
          const notifyChannel = findChannel(
            channels,
            telegramJid || chatJid,
          );
          if (notifyChannel) {
            await notifyChannel.sendMessage(
              telegramJid || chatJid,
              '⚠️ Email intelligence trigger failed. Check logs.',
            );
          }
        }
      });
    },
  });
```

- [ ] **Step 4: Build and verify compilation**

```bash
cd /Users/topcoder1/dev/nanoclaw/.claude/worktrees/optimistic-rosalind
npm run build
```

Expected: Clean compilation, no TypeScript errors.

- [ ] **Step 5: Commit**

```bash
git add src/ipc.ts src/index.ts
git commit -m "fix: email triggers spawn agent sessions instead of forwarding raw prompts

The IPC email_trigger handler was calling sendMessage() which sent the
raw instruction prompt to Telegram. Now it enqueues a container agent
task via the group queue, which processes the emails and sends clean
proposals back to Telegram."
```

---

## Task 2: Wire Subject/Sender into Triaged Emails (Superpilot)

**Problem:** The superpilot SSE event and bridge API return `subject: ''` and `sender: ''` because the triaged-emails query doesn't join the `email_threads` table.

**Files:**
- Modify: `~/dev/inbox_superpilot/app/api/nanoclaw/triaged-emails/route.ts`
- Modify: `~/dev/inbox_superpilot/app/api/nanoclaw/events/route.ts`
- Modify: `src/email-sse.ts:170-180` (NanoClaw — pass through subject/sender from SSE)

- [ ] **Step 1: Identify the superpilot DB schema for email_threads**

```bash
cd ~/dev/inbox_superpilot
grep -r "email_threads" --include="*.py" --include="*.ts" -l | head -20
```

Read the model/schema to find the `subject` and `sender` columns.

- [ ] **Step 2: Update triaged-emails route to join email_threads**

In the superpilot `triaged-emails` route, add a SQL join:

```sql
SELECT t.thread_id, t.account, t.classified_at, 
       et.subject, et.sender_email as sender
FROM triage_results t
LEFT JOIN email_threads et ON t.thread_id = et.thread_id
WHERE t.classified_at > ?
ORDER BY t.classified_at DESC
```

The exact table/column names need to be verified from the superpilot schema.

- [ ] **Step 3: Update SSE events route to include subject/sender**

In the superpilot `events` route, ensure the SSE `triaged_emails` event payload includes `subject` and `sender` fields from the join.

- [ ] **Step 4: Update NanoClaw SSE client to pass through subject/sender**

In `src/email-sse.ts`, lines 170-180, update the email mapping to include subject/sender from the SSE event:

```typescript
      emails: emails.map(
        (e: {
          thread_id: string;
          account: string;
          subject?: string;
          sender?: string;
          classified_at?: string;
        }) => ({
          thread_id: e.thread_id,
          account: e.account || 'unknown',
          subject: e.subject || '',
          sender: e.sender || '',
        }),
      ),
```

- [ ] **Step 5: Build both projects and verify**

```bash
# Superpilot
cd ~/dev/inbox_superpilot && npm run build  # or appropriate build command

# NanoClaw
cd /Users/topcoder1/dev/nanoclaw/.claude/worktrees/optimistic-rosalind
npm run build
```

- [ ] **Step 6: Commit both repos**

NanoClaw:
```bash
git add src/email-sse.ts
git commit -m "fix: pass subject/sender from SSE email events"
```

Superpilot (in that repo):
```bash
git add app/api/nanoclaw/
git commit -m "fix: join email_threads to include subject/sender in triaged-emails and SSE"
```

---

## Task 3: Fix SSE Drops (Cloudflare Timeout)

**Problem:** SSE connection drops every ~30-100s due to Cloudflare's proxy timeout for idle connections. Reconnection works but causes missed events.

**Fix:** Add server-side keepalive comments (`:keepalive\n\n`) every 15 seconds in the superpilot SSE endpoint. This keeps the connection alive through Cloudflare's proxy.

**Files:**
- Modify: `~/dev/inbox_superpilot/app/api/nanoclaw/events/route.ts`

- [ ] **Step 1: Add keepalive to SSE endpoint**

In the superpilot SSE events route, add a 15-second interval that sends SSE comments:

```typescript
// Inside the streaming response handler:
const keepaliveInterval = setInterval(() => {
  try {
    controller.enqueue(encoder.encode(': keepalive\n\n'));
  } catch {
    clearInterval(keepaliveInterval);
  }
}, 15_000);

// Clean up on close:
request.signal.addEventListener('abort', () => {
  clearInterval(keepaliveInterval);
});
```

The NanoClaw SSE client already handles comments (line 105: `if (!part.trim() || part.startsWith(':')) continue;`), so no client-side changes needed.

- [ ] **Step 2: Deploy superpilot and verify SSE stays alive >5 minutes**

```bash
cd ~/dev/inbox_superpilot
git add app/api/nanoclaw/events/route.ts
git commit -m "fix: add 15s keepalive to SSE endpoint to prevent Cloudflare timeout"
git push
```

After deploy, monitor NanoClaw logs:
```bash
journalctl --user -u nanoclaw -f | grep SSE
```

Expected: No "SSE connection closed by server" within 5 minutes. Keepalive comments logged as debug.

---

## Task 4: Fix Discord Token Reaching Containers

**Problem:** `DISCORD_BOT_TOKEN` was added to container-runner env vars but NanoClaw was running old code. After restart, need to verify the token actually reaches containers.

**Files:**
- Modify: `src/container-runner.ts` (if token isn't already passed)

- [ ] **Step 1: Check if DISCORD_BOT_TOKEN is in container env vars**

```bash
cd /Users/topcoder1/dev/nanoclaw/.claude/worktrees/optimistic-rosalind
grep -n "DISCORD_BOT_TOKEN" src/container-runner.ts
```

- [ ] **Step 2: If not present, add it to the container env**

The token should be injected via OneCLI, not as a raw env var. Check how other tokens are handled:

```bash
grep -n "ONECLI\|onecli\|credential" src/container-runner.ts | head -20
```

If OneCLI handles it, verify the credential is registered:
```bash
onecli list | grep -i discord
```

If not registered:
```bash
cd ~/dev/wxa-secrets
uv run python -m wxa_secrets get DISCORD_BOT_TOKEN
```

Then register with OneCLI or add as direct env var.

- [ ] **Step 3: Test Discord digest in a container**

Restart NanoClaw and trigger the morning briefing task (which includes Discord digest):

```bash
launchctl kickstart -k gui/$(id -u)/com.nanoclaw
# Then trigger via Telegram: "run morning briefing"
```

Check logs for Discord-related errors:
```bash
journalctl --user -u nanoclaw | grep -i discord | tail -20
```

- [ ] **Step 4: Commit if changes were needed**

```bash
git add src/container-runner.ts
git commit -m "fix: ensure DISCORD_BOT_TOKEN reaches agent containers"
```

---

## Task 5: Wire Gmail Push → IPC Writer (Superpilot)

**Problem:** Need to hook superpilot's Gmail Push notification handler (Celery task or webhook) to write IPC trigger files when new emails are triaged.

**Depends on:** Task 2 (subject/sender must be available).

**Files:**
- Modify: `~/dev/inbox_superpilot` (find the Gmail Push handler and the triage completion point)

- [ ] **Step 1: Find the triage completion point in superpilot**

```bash
cd ~/dev/inbox_superpilot
grep -rn "triage\|classify\|after_triage\|on_triage" --include="*.py" --include="*.ts" -l | head -20
```

Identify where a new email finishes triage classification.

- [ ] **Step 2: Add SSE event emission at triage completion**

At the point where triage completes, emit an SSE event:

```python
# After triage result is saved to DB:
emit_sse_event("triaged_emails", {
    "emails": [{
        "thread_id": result.thread_id,
        "account": result.account,
        "subject": thread.subject,
        "sender": thread.sender_email,
        "classified_at": result.classified_at.isoformat(),
    }]
})
```

The NanoClaw SSE client already listens for `triaged_emails` events and writes IPC files.

- [ ] **Step 3: Test end-to-end: send test email → verify Telegram notification**

1. Send a test email to one of the monitored accounts
2. Watch superpilot logs for triage completion
3. Watch NanoClaw logs for SSE event → IPC file → agent spawn
4. Verify clean proposal appears on Telegram

- [ ] **Step 4: Commit superpilot changes**

```bash
cd ~/dev/inbox_superpilot
git add .
git commit -m "feat: emit SSE event on triage completion for real-time NanoClaw triggers"
```

---

## Task 6: Fix Superpilot Frontend Test (AuthGate.test.tsx)

**Problem:** `AuthGate.test.tsx` fails, blocking full CI green status.

**Files:**
- Fix: `~/dev/inbox_superpilot/tests/AuthGate.test.tsx` (or similar path)

- [ ] **Step 1: Find and read the failing test**

```bash
cd ~/dev/inbox_superpilot
find . -name "AuthGate*test*" -type f
```

Read the test file and understand what's failing.

- [ ] **Step 2: Run the test locally to see the failure**

```bash
cd ~/dev/inbox_superpilot
npm test -- --testPathPattern AuthGate
```

- [ ] **Step 3: Fix the test**

Common issues: stale mock, missing provider wrapper, changed API shape. Fix based on the actual error.

- [ ] **Step 4: Verify CI passes**

```bash
git add tests/
git commit -m "fix: update AuthGate test to match current auth flow"
git push
```

Check GitHub Actions for green CI.

---

## Task 7: Test Approval Flow End-to-End

**Problem:** The approval flow (agent proposes action on Telegram → user replies "approve" → agent executes) has never been tested end-to-end.

**Depends on:** Task 1 (agent must actually process triggers first).

**Files:**
- Modify: `src/ipc.ts` or `groups/main/CLAUDE.md` (if approval parsing needs fixes)

- [ ] **Step 1: Trigger an email that generates a PROPOSE action**

Send a real email that requires a reply (not a newsletter). Wait for the agent to process it via the pipeline from Task 1.

- [ ] **Step 2: Verify the proposal appears on Telegram**

The agent should send a clean proposal like:
```
📧 Reply proposal for [sender]:
Subject: [subject]

Proposed reply:
"[draft text]"

Reply with: approve / edit: [changes] / skip
```

- [ ] **Step 3: Test approval parsing**

Reply "approve" on Telegram. The agent should:
1. Receive the approval message via the normal message loop
2. Execute the proposed action (send the email reply)
3. Log to `approval_log` table

- [ ] **Step 4: Test rejection and edit flows**

Reply "skip" to a proposal → agent should log rejection, no action taken.
Reply "edit: make it shorter" → agent should revise and re-propose.

- [ ] **Step 5: Verify approval_log entries**

```bash
sqlite3 store/messages.db "SELECT * FROM approval_log ORDER BY timestamp DESC LIMIT 5;"
```

- [ ] **Step 6: Document any fixes needed and commit**

If the approval flow required code changes, commit them:
```bash
git add src/ groups/
git commit -m "fix: approval flow parsing and execution"
```

---

## Task 8: Populate VIP Contacts in CLAUDE.md

**Problem:** The VIP contacts section in `groups/main/CLAUDE.md` is empty. VIP contacts trigger ESCALATE tier (immediate human notification).

**Files:**
- Modify: `groups/main/CLAUDE.md`

- [ ] **Step 1: Ask the user for their VIP contact list**

This is a config-only change. The user needs to provide:
- Email addresses or domains that should always escalate
- Names/roles for context

- [ ] **Step 2: Add VIP contacts to CLAUDE.md**

In the Email Intelligence section of `groups/main/CLAUDE.md`, populate the VIP contacts:

```markdown
### VIP Contacts (always ESCALATE)
- CEO / executives at current company
- Key clients (list specific emails/domains)
- Legal counsel
- Investors / board members
```

- [ ] **Step 3: Commit**

```bash
git add groups/main/CLAUDE.md
git commit -m "feat: populate VIP contacts for email escalation rules"
```

---

## Task 9: Cost Tracking Integration

**Problem:** `session_costs` table exists but nothing writes to it. Need to log estimated costs after each container agent session.

**Files:**
- Modify: `src/index.ts` (in `runAgent` function, after container completes)
- Modify: `src/task-scheduler.ts` (after task container completes)
- Modify: `src/db.ts` (add `logSessionCost` helper)

- [ ] **Step 1: Add logSessionCost helper to db.ts**

```typescript
export function logSessionCost(entry: {
  session_type: string;
  group_folder: string;
  started_at: string;
  duration_ms: number;
  estimated_cost_usd: number;
}): void {
  db.prepare(
    `INSERT INTO session_costs (session_type, group_folder, started_at, duration_ms, estimated_cost_usd)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(
    entry.session_type,
    entry.group_folder,
    entry.started_at,
    entry.duration_ms,
    entry.estimated_cost_usd,
  );
}

export function getTodaysCost(): number {
  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  const row = db
    .prepare(
      `SELECT COALESCE(SUM(estimated_cost_usd), 0) as total
       FROM session_costs
       WHERE started_at >= ?`,
    )
    .get(`${today}T00:00:00`) as { total: number } | undefined;
  return row?.total ?? 0;
}
```

- [ ] **Step 2: Log costs after message-triggered agent sessions**

In `src/index.ts`, in the `runAgent` function, track start time and log after completion:

```typescript
async function runAgent(
  group: RegisteredGroup,
  prompt: string,
  chatJid: string,
  onOutput?: (output: ContainerOutput) => Promise<void>,
): Promise<'success' | 'error'> {
  const startedAt = new Date().toISOString();
  const startMs = Date.now();
  // ... existing code ...

  // After try/catch, before return:
  const durationMs = Date.now() - startMs;
  // Rough cost estimate: ~$0.01 per 10s of agent time (Opus pricing)
  const estimatedCost = (durationMs / 10_000) * 0.01;
  logSessionCost({
    session_type: 'message',
    group_folder: group.folder,
    started_at: startedAt,
    duration_ms: durationMs,
    estimated_cost_usd: estimatedCost,
  });
```

- [ ] **Step 3: Log costs after scheduled task sessions**

In `src/task-scheduler.ts`, the `runTask` function already tracks `startTime` and `durationMs`. Add cost logging after `logTaskRun`:

```typescript
  // After logTaskRun (line 232):
  logSessionCost({
    session_type: 'task',
    group_folder: task.group_folder,
    started_at: new Date(startTime).toISOString(),
    duration_ms: durationMs,
    estimated_cost_usd: (durationMs / 10_000) * 0.01,
  });
```

- [ ] **Step 4: Build and verify**

```bash
npm run build
```

- [ ] **Step 5: Commit**

```bash
git add src/db.ts src/index.ts src/task-scheduler.ts
git commit -m "feat: log estimated session costs to session_costs table"
```

---

## Task 10: Budget Ceiling Enforcement ($50/day)

**Problem:** No spending limit. The agent could rack up unlimited API costs.

**Depends on:** Task 9 (cost tracking must be in place).

**Files:**
- Modify: `src/config.ts` (add `DAILY_BUDGET_USD`)
- Modify: `src/index.ts` (check budget before running agent)
- Modify: `src/task-scheduler.ts` (check budget before running tasks)

- [ ] **Step 1: Add DAILY_BUDGET_USD to config**

In `src/config.ts`:

```typescript
export const DAILY_BUDGET_USD = parseFloat(
  readEnv('DAILY_BUDGET_USD') || process.env.DAILY_BUDGET_USD || '50',
);
```

- [ ] **Step 2: Add budget check helper**

In `src/db.ts` or a new `src/budget.ts`:

```typescript
import { getTodaysCost } from './db.js';
import { DAILY_BUDGET_USD } from './config.js';
import { logger } from './logger.js';

export function isBudgetExceeded(): boolean {
  const spent = getTodaysCost();
  if (spent >= DAILY_BUDGET_USD) {
    logger.warn(
      { spent, budget: DAILY_BUDGET_USD },
      'Daily budget exceeded, blocking agent invocation',
    );
    return true;
  }
  return false;
}
```

- [ ] **Step 3: Guard agent invocations**

In `src/index.ts`, at the top of `runAgent`:

```typescript
async function runAgent(...): Promise<'success' | 'error'> {
  if (isBudgetExceeded()) {
    logger.warn({ group: group.name }, 'Agent blocked by budget ceiling');
    return 'error';
  }
  // ... rest of function
}
```

In `src/task-scheduler.ts`, at the top of `runTask`:

```typescript
async function runTask(task, deps): Promise<void> {
  if (isBudgetExceeded()) {
    logger.warn({ taskId: task.id }, 'Task blocked by budget ceiling');
    logTaskRun({
      task_id: task.id,
      run_at: new Date().toISOString(),
      duration_ms: 0,
      status: 'skipped',
      result: null,
      error: 'Daily budget exceeded',
    });
    // Still compute next run so task resumes tomorrow
    const nextRun = computeNextRun(task);
    updateTaskAfterRun(task.id, nextRun, 'Budget exceeded');
    return;
  }
  // ... rest of function
}
```

- [ ] **Step 4: Build and verify**

```bash
npm run build
```

- [ ] **Step 5: Commit**

```bash
git add src/config.ts src/db.ts src/index.ts src/task-scheduler.ts
git commit -m "feat: enforce daily budget ceiling ($50/day default)

Blocks agent invocations and scheduled tasks when estimated daily
spend exceeds DAILY_BUDGET_USD. Tasks compute their next run time
so they resume the following day."
```

---

## Execution Order

**Wave 1 (parallel, no dependencies):**
- Task 1: Fix agent processing (NanoClaw)
- Task 2: Wire subject/sender (superpilot)
- Task 3: Fix SSE keepalive (superpilot)
- Task 4: Fix Discord token (NanoClaw)

**Wave 2 (after Wave 1):**
- Task 5: Wire Gmail Push (superpilot, needs Task 2)
- Task 6: Fix AuthGate test (superpilot, independent but same repo)
- Task 7: Test approval flow (needs Task 1)

**Wave 3 (independent lower priority):**
- Task 8: VIP contacts (config only)
- Task 9: Cost tracking (NanoClaw)
- Task 10: Budget ceiling (needs Task 9)

## Verification Checklist

After all tasks are complete:

- [ ] Send a test email → superpilot triages → SSE event fires → NanoClaw agent spawns → clean proposal on Telegram
- [ ] Proposal includes subject and sender name
- [ ] SSE connection stays alive >5 minutes without drops
- [ ] Discord digest works in morning briefing
- [ ] Reply "approve" to a proposal → action executed
- [ ] Reply "skip" → no action taken
- [ ] `session_costs` table has entries with reasonable cost estimates
- [ ] Budget ceiling blocks agent when exceeded (test with `DAILY_BUDGET_USD=0.01`)
- [ ] Superpilot CI is green
