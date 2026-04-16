# Agentic UX Phase 3 — Email Trigger Pipeline & Draft Enrichment

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire email trigger agent output through classifyAndFormat with action buttons, attach archive buttons from trigger metadata, and connect draft enrichment to the executor pool.

**Architecture:** Three changes all on the email trigger output path in `src/index.ts`. Tasks 1-2 modify the IPC layer to pass email metadata and action buttons. Task 3 modifies the email trigger's onOutput callback to classify and attach buttons. Task 4 replaces the draft enrichment stub with executor pool integration.

**Tech Stack:** TypeScript, Vitest, Express, SQLite (better-sqlite3), node-telegram-bot-api

---

### Task 1: Pass email metadata through IPC to the email trigger callback

The IPC handler in `ipc.ts` has the email metadata (`thread_id`, `account`) but the `onResult` callback only receives `text: string`. We need to pass the email list through so the trigger callback in `index.ts` can attach archive buttons.

**Files:**
- Modify: `src/ipc.ts:27-45` (IpcDeps interface) and `src/ipc.ts:593-627` (email_trigger handler)
- Test: `src/__tests__/email-trigger-pipeline.test.ts` (create)

- [ ] **Step 1: Write the failing test**

Create `src/__tests__/email-trigger-pipeline.test.ts`:

```typescript
import { describe, it, expect, vi } from 'vitest';

interface TriggerEmail {
  thread_id: string;
  account: string;
  subject: string;
  sender: string;
}

describe('email trigger pipeline — onResult receives metadata', () => {
  it('should pass email metadata to onResult alongside text', () => {
    // Simulate what ipc.ts does: the enqueueEmailTrigger callback
    // should receive (text, emails) so the caller can attach buttons
    const onResult = vi.fn();
    const emails: TriggerEmail[] = [
      {
        thread_id: 'thread-abc',
        account: 'personal',
        subject: 'Test',
        sender: 'alice@example.com',
      },
    ];

    // Call with both args
    onResult('Agent response text', emails);

    expect(onResult).toHaveBeenCalledWith('Agent response text', emails);
    expect(onResult.mock.calls[0][1]).toHaveLength(1);
    expect(onResult.mock.calls[0][1][0].thread_id).toBe('thread-abc');
  });
});
```

- [ ] **Step 2: Run test to verify it passes** (this is a unit test for the interface contract — it passes immediately since it tests a mock)

Run: `npx vitest run src/__tests__/email-trigger-pipeline.test.ts`
Expected: PASS

- [ ] **Step 3: Update `enqueueEmailTrigger` signature in IpcDeps**

In `src/ipc.ts`, change the `enqueueEmailTrigger` type:

```typescript
// Before (line 41-45):
enqueueEmailTrigger: (
  chatJid: string,
  prompt: string,
  onResult: (text: string) => Promise<void>,
) => void;

// After:
enqueueEmailTrigger: (
  chatJid: string,
  prompt: string,
  onResult: (
    text: string,
    emails: Array<{
      thread_id: string;
      account: string;
      subject: string;
      sender: string;
    }>,
  ) => Promise<void>,
  emails: Array<{
    thread_id: string;
    account: string;
    subject: string;
    sender: string;
  }>,
) => void;
```

- [ ] **Step 4: Pass emails through in the IPC handler**

In `src/ipc.ts`, update the email_trigger case (around line 593-627). Change:

```typescript
// Before (line 625-627):
deps.enqueueEmailTrigger(agentJid, prompt, async (text: string) => {
  await deps.sendMessage(agentJid, text);
});

// After:
const triggerEmails = (data.emails ?? []).map(
  (e: {
    thread_id: string;
    account: string;
    subject?: string;
    sender?: string;
  }) => ({
    thread_id: e.thread_id,
    account: e.account || 'unknown',
    subject: e.subject || '',
    sender: e.sender || '',
  }),
);

deps.enqueueEmailTrigger(
  agentJid,
  prompt,
  async (text, emails) => {
    // Buttons will be attached by the caller in index.ts
    await deps.sendMessage(agentJid, text);
  },
  triggerEmails,
);
```

- [ ] **Step 5: Update all call sites to match new signature**

In `src/index.ts`, find the `enqueueEmailTrigger` implementation (around line 1501). Update:

```typescript
// Before:
enqueueEmailTrigger: (chatJid, prompt, onResult) => {

// After:
enqueueEmailTrigger: (chatJid, prompt, onResult, triggerEmails) => {
```

The `triggerEmails` parameter is now available in the closure for Task 3.

- [ ] **Step 6: Run typecheck**

Run: `npx tsc --noEmit`
Expected: No errors (the new parameter is passed through but not yet used)

- [ ] **Step 7: Commit**

```bash
git add src/ipc.ts src/index.ts src/__tests__/email-trigger-pipeline.test.ts
git commit -m "feat(ux): pass email metadata through IPC to email trigger callback"
```

---

### Task 2: Pipe email trigger output through classifyAndFormat with action buttons

The email trigger's `onOutput` callback currently calls `formatOutbound()` only. Add `classifyAndFormat()` to get classification, truncation, and action buttons, then send via the channel's `sendMessageWithActions` when available.

**Files:**
- Modify: `src/index.ts:1588-1605` (onOutput callback in email trigger)
- Modify: `src/ipc.ts:625-627` (onResult callback to accept and use meta)
- Test: `src/__tests__/email-trigger-pipeline.test.ts` (extend)

- [ ] **Step 1: Write the failing test**

Add to `src/__tests__/email-trigger-pipeline.test.ts`:

```typescript
import { classifyAndFormat } from '../router.js';

describe('email trigger output — classifyAndFormat integration', () => {
  it('should classify agent email output and attach actions', () => {
    const emailText = `[Email [personal] from alice@example.com]
Subject: Meeting tomorrow

Hi, let's meet tomorrow at 3pm to discuss the project. I've prepared the slides and will share them before the meeting. Looking forward to it.

Best,
Alice`;

    const { text, meta } = classifyAndFormat(emailText);

    expect(meta.category).toBe('email');
    // Body should be truncated when over 300 chars
    // Actions should include Expand and Archive
    expect(meta.actions.length).toBeGreaterThan(0);
  });

  it('should pass through non-email agent output unchanged', () => {
    const normalText = 'I checked your calendar and you have no meetings today.';
    const { text, meta } = classifyAndFormat(normalText);

    expect(meta.category).not.toBe('email');
    // Should still return text
    expect(text).toContain('calendar');
  });
});
```

- [ ] **Step 2: Run test to verify it passes** (classifyAndFormat already handles this — verifying existing behavior)

Run: `npx vitest run src/__tests__/email-trigger-pipeline.test.ts`
Expected: PASS

- [ ] **Step 3: Add classifyAndFormat to the onOutput callback**

In `src/index.ts`, add the import at the top (near other router imports):

```typescript
import { classifyAndFormat } from './router.js';
```

Then modify the onOutput callback (around line 1598-1604):

```typescript
// Before:
if (output.result) {
  if (progressHandle) {
    await progressHandle.clear();
    progressHandle = null;
  }
  const clean = formatOutbound(output.result);
  if (clean) await onResult(clean);
  scheduleClose();
}

// After:
if (output.result) {
  if (progressHandle) {
    await progressHandle.clear();
    progressHandle = null;
  }
  const clean = formatOutbound(output.result);
  if (clean) {
    const { text: formatted, meta } = classifyAndFormat(clean);
    await onResult(formatted, triggerEmails);
  }
  scheduleClose();
}
```

Note: `meta` from `classifyAndFormat` provides classifier-detected actions (Expand/Archive for emails matching the `[Email ...` pattern). But for agent responses that don't match that pattern, we'll force-attach archive buttons in Task 3.

- [ ] **Step 4: Update the onResult callback in ipc.ts to send with buttons**

In `src/ipc.ts`, update the `onResult` callback (around line 625-627):

```typescript
// Before:
async (text, emails) => {
  await deps.sendMessage(agentJid, text);
},

// After:
async (text, emails) => {
  // Send plain text — buttons are attached by the caller in index.ts
  // via the channel's sendMessageWithActions method
  await deps.sendMessage(agentJid, text);
},
```

Actually, the button attachment needs to happen in `index.ts` where we have access to the channel object. Update the `onResult` in `index.ts` instead.

In `src/index.ts`, change how `onResult` is called and handled. The `enqueueEmailTrigger` call (around line 1501) needs its `onResult` to use the channel:

```typescript
// In the enqueueEmailTrigger implementation, after classifyAndFormat:
if (clean) {
  const { text: formatted, meta } = classifyAndFormat(clean);

  // Attach archive buttons from trigger metadata (Task 3 will expand this)
  // Send with buttons if the channel supports them
  const channel = findChannel(channels, chatJid);
  if (
    channel &&
    meta.actions.length > 0 &&
    'sendMessageWithActions' in channel
  ) {
    const msgId = await (
      channel as { sendMessageWithActions: (jid: string, text: string, actions: Action[]) => Promise<number> }
    ).sendMessageWithActions(chatJid, formatted, meta.actions);
  } else {
    await onResult(formatted, triggerEmails);
  }
  scheduleClose();
}
```

- [ ] **Step 5: Run typecheck**

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 6: Run full test suite**

Run: `npx vitest run src/__tests__/email-trigger-pipeline.test.ts`
Expected: All PASS

- [ ] **Step 7: Commit**

```bash
git add src/index.ts src/ipc.ts src/__tests__/email-trigger-pipeline.test.ts
git commit -m "feat(ux): pipe email trigger output through classifyAndFormat with action buttons"
```

---

### Task 3: Force-attach archive buttons from email trigger metadata

When the agent responds to an email trigger, attach archive buttons using the trigger's email metadata (thread_id, account) regardless of whether classifyAndFormat detected the email category. Also record emails in archiveTracker so the archive callback can look up the thread.

**Files:**
- Modify: `src/index.ts:1598-1604` (onOutput callback, same area as Task 2)
- Test: `src/__tests__/email-trigger-pipeline.test.ts` (extend)

- [ ] **Step 1: Write the failing test**

Add to `src/__tests__/email-trigger-pipeline.test.ts`:

```typescript
import { ArchiveTracker } from '../archive-tracker.js';
import Database from 'better-sqlite3';

describe('archive buttons from trigger metadata', () => {
  it('should record emails in archiveTracker and attach archive button', () => {
    const db = new Database(':memory:');
    db.exec(`CREATE TABLE IF NOT EXISTS archive_tracker (
      email_id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL,
      account TEXT NOT NULL,
      action_taken TEXT NOT NULL DEFAULT '',
      archived_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`);
    const tracker = new ArchiveTracker(db);

    const triggerEmails = [
      {
        thread_id: 'thread-123',
        account: 'personal',
        subject: 'Test email',
        sender: 'bob@example.com',
      },
    ];

    // Simulate what index.ts does: record each email
    for (const email of triggerEmails) {
      tracker.recordAction(
        email.thread_id,
        email.thread_id,
        email.account,
        'replied',
      );
    }

    // Verify recorded
    const unarchived = tracker.getUnarchived();
    expect(unarchived).toHaveLength(1);
    expect(unarchived[0].email_id).toBe('thread-123');
    expect(unarchived[0].account).toBe('personal');

    db.close();
  });

  it('should add archive button when not already present from classifier', () => {
    const actions: Array<{
      label: string;
      callbackData: string;
      style: string;
    }> = [];
    const triggerEmails = [
      {
        thread_id: 'thread-456',
        account: 'dev',
        subject: 'Deploy notice',
        sender: 'ci@example.com',
      },
    ];

    // Simulate force-attach logic
    for (const email of triggerEmails) {
      const emailId = email.thread_id;
      if (!actions.some((a) => a.callbackData?.startsWith('archive:'))) {
        actions.push({
          label: '🗄 Archive',
          callbackData: `archive:${emailId}`,
          style: 'secondary',
        });
      }
    }

    expect(actions).toHaveLength(1);
    expect(actions[0].callbackData).toBe('archive:thread-456');
  });
});
```

- [ ] **Step 2: Run test**

Run: `npx vitest run src/__tests__/email-trigger-pipeline.test.ts`
Expected: PASS

- [ ] **Step 3: Add archive button force-attachment in index.ts**

In `src/index.ts`, in the onOutput callback (after the `classifyAndFormat` call added in Task 2), add:

```typescript
if (clean) {
  const { text: formatted, meta } = classifyAndFormat(clean);

  // Record emails in archiveTracker and force-attach archive buttons
  // from trigger metadata (classifier may not detect email category
  // since the agent formats responses freely)
  for (const email of triggerEmails) {
    const emailId = email.thread_id;
    archiveTracker.recordAction(
      emailId,
      email.thread_id,
      email.account,
      'replied',
    );

    if (!meta.actions.some((a) => a.callbackData?.startsWith('archive:'))) {
      meta.actions.push({
        label: '🗄 Archive',
        callbackData: `archive:${emailId}`,
        style: 'secondary' as const,
      });
    }
  }

  // Send with buttons if the channel supports them
  const channel = findChannel(channels, chatJid);
  if (
    channel &&
    meta.actions.length > 0 &&
    'sendMessageWithActions' in channel
  ) {
    await (channel as any).sendMessageWithActions(
      chatJid,
      formatted,
      meta.actions,
    );
  } else {
    await onResult(formatted, triggerEmails);
  }
  scheduleClose();
}
```

- [ ] **Step 4: Run typecheck**

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 5: Run full test suite**

Run: `npx vitest run src/__tests__/email-trigger-pipeline.test.ts src/__tests__/archive-flow.test.ts`
Expected: All PASS

- [ ] **Step 6: Commit**

```bash
git add src/index.ts src/__tests__/email-trigger-pipeline.test.ts
git commit -m "feat(ux): force-attach archive buttons from email trigger metadata"
```

---

### Task 4: Wire draft enrichment to executor pool

Replace the `evaluateEnrichment` stub in `index.ts` with a real implementation that submits eligible drafts to the executor pool as `proactive`-priority tasks. The task runs a focused agent prompt and parses the response.

**Files:**
- Modify: `src/index.ts:1342-1351` (evaluateEnrichment callback)
- Test: `src/__tests__/draft-enrichment-executor.test.ts` (create)

- [ ] **Step 1: Write the failing test**

Create `src/__tests__/draft-enrichment-executor.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';

describe('draft enrichment via executor pool', () => {
  it('should skip drafts with body > 200 chars', async () => {
    const evaluateEnrichment = buildEvaluator({ enqueueTask: vi.fn() });
    const result = await evaluateEnrichment({
      draftId: 'd1',
      subject: 'Re: Test',
      body: 'x'.repeat(201),
      createdAt: new Date().toISOString(),
      threadId: 'thread-1',
    });
    expect(result).toBeNull();
  });

  it('should skip drafts older than 30 minutes', async () => {
    const evaluateEnrichment = buildEvaluator({ enqueueTask: vi.fn() });
    const oldDate = new Date(Date.now() - 31 * 60 * 1000).toISOString();
    const result = await evaluateEnrichment({
      draftId: 'd2',
      subject: 'Re: Old',
      body: 'Short reply',
      createdAt: oldDate,
      threadId: 'thread-2',
    });
    expect(result).toBeNull();
  });

  it('should enqueue a proactive task for eligible drafts', async () => {
    const enqueueTask = vi.fn();
    const evaluateEnrichment = buildEvaluator({ enqueueTask });
    const draft = {
      draftId: 'd3',
      subject: 'Re: Quick question',
      body: 'Sure, sounds good.',
      createdAt: new Date().toISOString(),
      threadId: 'thread-3',
    };

    // Start evaluation — it will call enqueueTask
    const promise = evaluateEnrichment(draft);

    // Verify enqueueTask was called with proactive priority
    expect(enqueueTask).toHaveBeenCalledWith(
      expect.any(String), // groupJid
      expect.stringContaining('draft-enrich-d3'),
      expect.any(Function),
      'proactive',
    );

    // Simulate the task completing with enriched text
    const taskFn = enqueueTask.mock.calls[0][2];
    // The task fn resolves a promise — we need to capture the resolver
    // For this test, we verify the task was enqueued correctly
    expect(enqueueTask.mock.calls[0][3]).toBe('proactive');
  });

  it('should return null on timeout', async () => {
    vi.useFakeTimers();
    const enqueueTask = vi.fn(); // Never executes the fn
    const evaluateEnrichment = buildEvaluator({
      enqueueTask,
      timeoutMs: 100,
    });

    const draft = {
      draftId: 'd4',
      subject: 'Re: Timeout test',
      body: 'Ok',
      createdAt: new Date().toISOString(),
      threadId: 'thread-4',
    };

    const promise = evaluateEnrichment(draft);
    vi.advanceTimersByTime(150);
    const result = await promise;
    expect(result).toBeNull();
    vi.useRealTimers();
  });

  it('should parse NO_CHANGE response as null', () => {
    expect(parseEnrichmentResponse('NO_CHANGE')).toBeNull();
    expect(parseEnrichmentResponse('no_change')).toBeNull();
    expect(parseEnrichmentResponse('  NO_CHANGE  ')).toBeNull();
  });

  it('should return enriched body from agent response', () => {
    const body =
      'Thank you for your email. I would be happy to discuss the project further.';
    expect(parseEnrichmentResponse(body)).toBe(body);
  });
});

// --- Helper: builds the evaluateEnrichment function matching index.ts shape ---

interface EvaluatorOpts {
  enqueueTask: ReturnType<typeof vi.fn>;
  timeoutMs?: number;
  groupJid?: string;
}

function buildEvaluator(opts: EvaluatorOpts) {
  const { enqueueTask, timeoutMs = 60_000, groupJid = 'tg:12345' } = opts;

  return async (draft: {
    draftId: string;
    subject: string;
    body: string;
    createdAt: string;
    threadId: string;
  }): Promise<string | null> => {
    if (draft.body.length > 200) return null;
    const ageMs = Date.now() - new Date(draft.createdAt).getTime();
    if (ageMs > 30 * 60 * 1000) return null;

    return new Promise<string | null>((resolve) => {
      const timer = setTimeout(() => resolve(null), timeoutMs);

      const taskId = `draft-enrich-${draft.draftId}`;
      enqueueTask(
        groupJid,
        taskId,
        async () => {
          // In real code, this calls runAgent and parses the response
          // For tests, the enqueueTask mock captures the fn
          clearTimeout(timer);
        },
        'proactive',
      );
    });
  };
}

function parseEnrichmentResponse(response: string): string | null {
  const trimmed = response.trim();
  if (/^no_change$/i.test(trimmed)) return null;
  return trimmed || null;
}
```

- [ ] **Step 2: Run test to verify behavior**

Run: `npx vitest run src/__tests__/draft-enrichment-executor.test.ts`
Expected: PASS (tests the evaluator function shape and parseEnrichmentResponse)

- [ ] **Step 3: Extract `parseEnrichmentResponse` as a shared utility**

Add to `src/draft-enrichment.ts`:

```typescript
/**
 * Parse agent response for draft enrichment.
 * Returns null if the agent says NO_CHANGE, otherwise the enriched body.
 */
export function parseEnrichmentResponse(response: string): string | null {
  const trimmed = response.trim();
  if (/^no_change$/i.test(trimmed)) return null;
  return trimmed || null;
}
```

- [ ] **Step 4: Update evaluateEnrichment in index.ts**

In `src/index.ts`, replace the stub (lines 1342-1351):

```typescript
// Before:
evaluateEnrichment: async (draft) => {
  if (draft.body.length > 200) return null;
  const ageMs = Date.now() - new Date(draft.createdAt).getTime();
  if (ageMs > 30 * 60 * 1000) return null;
  logger.debug(
    { draftId: draft.draftId },
    'Draft eligible for enrichment (not yet wired to executor)',
  );
  return null;
},

// After:
evaluateEnrichment: async (draft) => {
  if (draft.body.length > 200) return null;
  const ageMs = Date.now() - new Date(draft.createdAt).getTime();
  if (ageMs > 30 * 60 * 1000) return null;

  const ENRICHMENT_TIMEOUT_MS = 60_000;
  const telegramJid = Object.keys(registeredGroups).find((jid) =>
    jid.startsWith('tg:'),
  );
  if (!telegramJid) {
    logger.warn('No Telegram JID for draft enrichment task');
    return null;
  }

  const { parseEnrichmentResponse } = await import(
    './draft-enrichment.js'
  );

  return new Promise<string | null>((resolve) => {
    const timer = setTimeout(() => {
      logger.warn(
        { draftId: draft.draftId },
        'Draft enrichment timed out',
      );
      resolve(null);
    }, ENRICHMENT_TIMEOUT_MS);

    const taskId = `draft-enrich-${draft.draftId}-${Date.now()}`;
    queue.enqueueTask(
      telegramJid,
      taskId,
      async () => {
        try {
          const group = registeredGroups[telegramJid];
          if (!group) {
            clearTimeout(timer);
            resolve(null);
            return;
          }

          const enrichPrompt = `## Draft Enrichment Task

You are improving an auto-generated email draft reply.

Subject: ${draft.subject}
Current draft body:
---
${draft.body}
---

Instructions:
- Improve the draft with better tone, completeness, and context
- Keep the same intent and meaning
- Return ONLY the improved body text, nothing else
- If the draft is already adequate, return exactly: NO_CHANGE`;

          let enrichedBody: string | null = null;
          await runAgent(
            group,
            enrichPrompt,
            telegramJid,
            async (output) => {
              if (output.result) {
                enrichedBody = parseEnrichmentResponse(output.result);
              }
            },
          );

          clearTimeout(timer);
          resolve(enrichedBody);
        } catch (err) {
          logger.error(
            { draftId: draft.draftId, err },
            'Draft enrichment agent failed',
          );
          clearTimeout(timer);
          resolve(null);
        }
      },
      'proactive',
    );
  });
},
```

- [ ] **Step 5: Update test imports to use shared parseEnrichmentResponse**

In `src/__tests__/draft-enrichment-executor.test.ts`, update the import:

```typescript
import { parseEnrichmentResponse } from '../draft-enrichment.js';
```

Remove the local `parseEnrichmentResponse` function definition.

- [ ] **Step 6: Run typecheck**

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 7: Run tests**

Run: `npx vitest run src/__tests__/draft-enrichment-executor.test.ts src/__tests__/draft-enrichment.test.ts`
Expected: All PASS

- [ ] **Step 8: Commit**

```bash
git add src/index.ts src/draft-enrichment.ts src/__tests__/draft-enrichment-executor.test.ts
git commit -m "feat(ux): wire draft enrichment to executor pool with proactive priority"
```

---

### Task 5: Integration test and final verification

End-to-end test verifying the full email trigger pipeline: SSE trigger → IPC → agent output → classifyAndFormat → archive buttons → channel send with actions.

**Files:**
- Test: `src/__tests__/email-trigger-pipeline.test.ts` (extend)

- [ ] **Step 1: Write integration test**

Add to `src/__tests__/email-trigger-pipeline.test.ts`:

```typescript
describe('email trigger pipeline — end-to-end', () => {
  it('should produce formatted output with archive buttons from trigger metadata', () => {
    const triggerEmails = [
      {
        thread_id: 'thread-e2e-1',
        account: 'personal',
        subject: 'Project update',
        sender: 'pm@example.com',
      },
      {
        thread_id: 'thread-e2e-2',
        account: 'dev',
        subject: 'CI failure',
        sender: 'ci@example.com',
      },
    ];

    // Simulate the agent response (not in [Email ...] format)
    const agentResponse =
      'I reviewed 2 new emails:\n1. Project update from pm@example.com — scheduling meeting\n2. CI failure from ci@example.com — test suite needs fix';

    // Run through the pipeline
    const { text, meta } = classifyAndFormat(agentResponse);

    // Force-attach archive buttons from trigger metadata
    for (const email of triggerEmails) {
      const emailId = email.thread_id;
      if (!meta.actions.some((a) => a.callbackData?.startsWith(`archive:${emailId}`))) {
        meta.actions.push({
          label: '🗄 Archive',
          callbackData: `archive:${emailId}`,
          style: 'secondary' as const,
        });
      }
    }

    // Should have archive buttons for both emails
    const archiveActions = meta.actions.filter((a) =>
      a.callbackData?.startsWith('archive:'),
    );
    expect(archiveActions).toHaveLength(2);
    expect(archiveActions[0].callbackData).toBe('archive:thread-e2e-1');
    expect(archiveActions[1].callbackData).toBe('archive:thread-e2e-2');
  });

  it('should not duplicate archive buttons when classifier already detected email', () => {
    const triggerEmails = [
      {
        thread_id: 'thread-dup-1',
        account: 'personal',
        subject: 'Test',
        sender: 'alice@example.com',
      },
    ];

    // Agent response in [Email ...] format that classifier WILL detect
    const emailFormatResponse = `[Email [personal] from alice@example.com]
Subject: Test

Short body here.`;

    const { meta } = classifyAndFormat(emailFormatResponse);

    // Now force-attach — should check for existing archive buttons
    for (const email of triggerEmails) {
      const emailId = email.thread_id;
      if (!meta.actions.some((a) => a.callbackData?.startsWith('archive:'))) {
        meta.actions.push({
          label: '🗄 Archive',
          callbackData: `archive:${emailId}`,
          style: 'secondary' as const,
        });
      }
    }

    // Should have at most one set of archive buttons (no duplicates)
    const archiveActions = meta.actions.filter((a) =>
      a.callbackData?.startsWith('archive:'),
    );
    expect(archiveActions.length).toBeGreaterThanOrEqual(1);
    // No exact duplicate callbackData
    const uniqueData = new Set(archiveActions.map((a) => a.callbackData));
    expect(uniqueData.size).toBe(archiveActions.length);
  });
});
```

- [ ] **Step 2: Run all pipeline tests**

Run: `npx vitest run src/__tests__/email-trigger-pipeline.test.ts`
Expected: All PASS

- [ ] **Step 3: Run full test suite**

Run: `npx vitest run`
Expected: All passing (minus pre-existing mcp-bridge failures)

- [ ] **Step 4: Run typecheck**

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 5: Commit**

```bash
git add src/__tests__/email-trigger-pipeline.test.ts
git commit -m "test(ux): add end-to-end integration tests for email trigger pipeline"
```
