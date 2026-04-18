# Email Trigger Debounce + Selective Push Suppression Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reduce duplicate Telegram messages from rapid-fire email events (e.g., 3 wire transfers → 8 messages) to a single consolidated agent response by debouncing IPC triggers and suppressing redundant push notifications.

**Architecture:** New `EmailTriggerDebouncer` class buffers SSE emails for 60s before writing a single merged IPC file. The `email.received` handler checks the debounce buffer before sending push notifications — if the email is buffered for agent processing, the push is suppressed.

**Tech Stack:** TypeScript, Vitest, Node.js timers

---

### Task 1: EmailTriggerDebouncer module

Create the core debouncer class with add/has/flush/destroy API, thread_id dedup, debounce timer, and max-hold safety cap.

**Files:**
- Create: `src/email-trigger-debouncer.ts`
- Test: `src/__tests__/email-trigger-debouncer.test.ts`

- [ ] **Step 1: Write the test file**

Create `src/__tests__/email-trigger-debouncer.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EmailTriggerDebouncer } from '../email-trigger-debouncer.js';
import type { SSEEmail } from '../sse-classifier.js';

describe('EmailTriggerDebouncer', () => {
  let debouncer: EmailTriggerDebouncer;
  let flushed: Array<{ emails: SSEEmail[]; label: string }>;

  beforeEach(() => {
    vi.useFakeTimers();
    flushed = [];
    debouncer = new EmailTriggerDebouncer({
      debounceMs: 60_000,
      maxHoldMs: 300_000,
      onFlush: (emails, label) => flushed.push({ emails, label }),
    });
  });

  afterEach(() => {
    debouncer.destroy();
    vi.useRealTimers();
  });

  describe('add and flush', () => {
    it('should flush after debounce period of quiet', () => {
      const email: SSEEmail = { thread_id: 't1', account: 'personal' };
      debouncer.add([email], 'conn1');

      expect(flushed).toHaveLength(0);
      vi.advanceTimersByTime(60_000);
      expect(flushed).toHaveLength(1);
      expect(flushed[0].emails).toEqual([email]);
      expect(flushed[0].label).toBe('conn1');
    });

    it('should reset debounce timer on new email', () => {
      debouncer.add([{ thread_id: 't1', account: 'personal' }], 'conn1');

      vi.advanceTimersByTime(45_000);
      expect(flushed).toHaveLength(0);

      debouncer.add([{ thread_id: 't2', account: 'personal' }], 'conn1');

      vi.advanceTimersByTime(45_000);
      expect(flushed).toHaveLength(0);

      vi.advanceTimersByTime(15_000);
      expect(flushed).toHaveLength(1);
      expect(flushed[0].emails).toHaveLength(2);
    });

    it('should merge emails from multiple adds', () => {
      debouncer.add([{ thread_id: 't1', account: 'personal' }], 'conn1');
      debouncer.add([{ thread_id: 't2', account: 'whoisxml' }], 'conn1');
      debouncer.add([{ thread_id: 't3', account: 'personal' }], 'conn1');

      vi.advanceTimersByTime(60_000);
      expect(flushed).toHaveLength(1);
      expect(flushed[0].emails).toHaveLength(3);
      expect(flushed[0].emails.map((e) => e.thread_id)).toEqual(['t1', 't2', 't3']);
    });

    it('should deduplicate by thread_id within buffer', () => {
      debouncer.add([{ thread_id: 't1', account: 'personal', subject: 'first' }], 'conn1');
      debouncer.add([{ thread_id: 't1', account: 'personal', subject: 'resend' }], 'conn1');

      vi.advanceTimersByTime(60_000);
      expect(flushed[0].emails).toHaveLength(1);
      expect(flushed[0].emails[0].thread_id).toBe('t1');
    });

    it('should use label from first add', () => {
      debouncer.add([{ thread_id: 't1', account: 'personal' }], 'conn-alpha');
      debouncer.add([{ thread_id: 't2', account: 'personal' }], 'conn-beta');

      vi.advanceTimersByTime(60_000);
      expect(flushed[0].label).toBe('conn-alpha');
    });
  });

  describe('max hold', () => {
    it('should force-flush at maxHoldMs even if emails keep arriving', () => {
      debouncer.add([{ thread_id: 't1', account: 'personal' }], 'conn1');

      // Add email every 50s for 5 minutes — debounce timer keeps resetting
      for (let i = 2; i <= 6; i++) {
        vi.advanceTimersByTime(50_000);
        debouncer.add([{ thread_id: `t${i}`, account: 'personal' }], 'conn1');
      }

      // At 250s (4m10s), debounce hasn't fired yet (last add was at 250s, timer at 310s)
      expect(flushed).toHaveLength(0);

      // Advance to 300s (5 min max hold)
      vi.advanceTimersByTime(50_000);
      expect(flushed).toHaveLength(1);
      expect(flushed[0].emails.length).toBeGreaterThanOrEqual(6);
    });
  });

  describe('has', () => {
    it('should return true for buffered thread_ids', () => {
      debouncer.add([{ thread_id: 't1', account: 'personal' }], 'conn1');
      expect(debouncer.has('t1')).toBe(true);
      expect(debouncer.has('t2')).toBe(false);
    });

    it('should return false after flush', () => {
      debouncer.add([{ thread_id: 't1', account: 'personal' }], 'conn1');
      vi.advanceTimersByTime(60_000);
      expect(debouncer.has('t1')).toBe(false);
    });
  });

  describe('flush()', () => {
    it('should force-flush immediately', () => {
      debouncer.add([{ thread_id: 't1', account: 'personal' }], 'conn1');
      debouncer.flush();
      expect(flushed).toHaveLength(1);
    });

    it('should be a no-op when buffer is empty', () => {
      debouncer.flush();
      expect(flushed).toHaveLength(0);
    });
  });

  describe('getBufferSize', () => {
    it('should return current buffer count', () => {
      expect(debouncer.getBufferSize()).toBe(0);
      debouncer.add([{ thread_id: 't1', account: 'personal' }], 'conn1');
      expect(debouncer.getBufferSize()).toBe(1);
      debouncer.add([{ thread_id: 't2', account: 'personal' }], 'conn1');
      expect(debouncer.getBufferSize()).toBe(2);
    });
  });

  describe('debounceMs = 0 (passthrough)', () => {
    it('should flush immediately when debounceMs is 0', () => {
      debouncer.destroy();
      debouncer = new EmailTriggerDebouncer({
        debounceMs: 0,
        maxHoldMs: 300_000,
        onFlush: (emails, label) => flushed.push({ emails, label }),
      });

      debouncer.add([{ thread_id: 't1', account: 'personal' }], 'conn1');
      expect(flushed).toHaveLength(1);
      expect(debouncer.has('t1')).toBe(false);
    });
  });

  describe('destroy', () => {
    it('should cancel pending timers without flushing', () => {
      debouncer.add([{ thread_id: 't1', account: 'personal' }], 'conn1');
      debouncer.destroy();
      vi.advanceTimersByTime(60_000);
      expect(flushed).toHaveLength(0);
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/__tests__/email-trigger-debouncer.test.ts`
Expected: FAIL — `EmailTriggerDebouncer` not found

- [ ] **Step 3: Implement EmailTriggerDebouncer**

Create `src/email-trigger-debouncer.ts`:

```typescript
import type { SSEEmail } from './sse-classifier.js';
import { logger } from './logger.js';

export interface EmailTriggerDebouncerOpts {
  debounceMs: number;
  maxHoldMs: number;
  onFlush: (emails: SSEEmail[], label: string) => void;
}

export class EmailTriggerDebouncer {
  private buffer: Map<string, SSEEmail> = new Map();
  private label: string = '';
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private maxHoldTimer: ReturnType<typeof setTimeout> | null = null;
  private firstAddedAt: number = 0;
  private opts: EmailTriggerDebouncerOpts;

  constructor(opts: EmailTriggerDebouncerOpts) {
    this.opts = opts;
  }

  add(emails: SSEEmail[], label: string): void {
    if (emails.length === 0) return;

    const wasEmpty = this.buffer.size === 0;

    for (const email of emails) {
      if (!this.buffer.has(email.thread_id)) {
        this.buffer.set(email.thread_id, email);
      }
    }

    if (wasEmpty) {
      this.label = label;
      this.firstAddedAt = Date.now();

      logger.info(
        { threadIds: emails.map((e) => e.thread_id), label },
        'Debouncer: first email(s) buffered, starting timer',
      );

      // Start max-hold safety timer
      if (this.opts.maxHoldMs > 0) {
        this.maxHoldTimer = setTimeout(() => {
          logger.info(
            { bufferSize: this.buffer.size, holdMs: this.opts.maxHoldMs },
            'Debouncer: max hold reached, force-flushing',
          );
          this.doFlush();
        }, this.opts.maxHoldMs);
      }
    } else {
      logger.info(
        {
          newThreadIds: emails.map((e) => e.thread_id),
          bufferSize: this.buffer.size,
          timeSinceFirst: Date.now() - this.firstAddedAt,
        },
        'Debouncer: email(s) merged into buffer',
      );
    }

    // Passthrough mode: debounceMs === 0 means flush immediately
    if (this.opts.debounceMs === 0) {
      this.doFlush();
      return;
    }

    // Reset debounce timer
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }
    this.debounceTimer = setTimeout(() => {
      this.doFlush();
    }, this.opts.debounceMs);
  }

  has(threadId: string): boolean {
    return this.buffer.has(threadId);
  }

  flush(): void {
    if (this.buffer.size > 0) {
      this.doFlush();
    }
  }

  getBufferSize(): number {
    return this.buffer.size;
  }

  destroy(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    if (this.maxHoldTimer) {
      clearTimeout(this.maxHoldTimer);
      this.maxHoldTimer = null;
    }
    this.buffer.clear();
  }

  private doFlush(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    if (this.maxHoldTimer) {
      clearTimeout(this.maxHoldTimer);
      this.maxHoldTimer = null;
    }

    const emails = Array.from(this.buffer.values());
    const label = this.label;

    logger.info(
      {
        count: emails.length,
        threadIds: emails.map((e) => e.thread_id),
        holdMs: Date.now() - this.firstAddedAt,
      },
      'Debouncer: flushing buffered emails',
    );

    this.buffer.clear();
    this.label = '';
    this.firstAddedAt = 0;

    this.opts.onFlush(emails, label);
  }
}
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run src/__tests__/email-trigger-debouncer.test.ts`
Expected: All PASS

- [ ] **Step 5: Run typecheck**

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 6: Commit**

```bash
git add src/email-trigger-debouncer.ts src/__tests__/email-trigger-debouncer.test.ts
git commit -m "feat(ux): add EmailTriggerDebouncer with thread dedup and max-hold cap"
```

---

### Task 2: Add UxConfig keys for trigger debounce

Add `trigger.debounceMs` and `trigger.maxHoldMs` to the UxConfig defaults array.

**Files:**
- Modify: `src/ux-config.ts`
- Modify: `src/__tests__/ux-config.test.ts`

- [ ] **Step 1: Add test for new config keys**

Add to `src/__tests__/ux-config.test.ts`, inside the `seedDefaults` describe block, after the existing tests:

```typescript
    it('should seed trigger debounce keys', () => {
      const items = config.list();
      expect(items.find((i) => i.key === 'trigger.debounceMs')?.value).toBe('60000');
      expect(items.find((i) => i.key === 'trigger.maxHoldMs')?.value).toBe('300000');
    });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/__tests__/ux-config.test.ts`
Expected: FAIL — `trigger.debounceMs` not found in list

- [ ] **Step 3: Add defaults to ux-config.ts**

In `src/ux-config.ts`, find the `DEFAULTS` array. Add these two entries after the `enrichment.timeoutMs` entry (before the `enrichment.prompt` entry):

```typescript
  { key: 'trigger.debounceMs', value: '60000', type: 'number' },
  { key: 'trigger.maxHoldMs', value: '300000', type: 'number' },
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run src/__tests__/ux-config.test.ts`
Expected: All PASS

- [ ] **Step 5: Commit**

```bash
git add src/ux-config.ts src/__tests__/ux-config.test.ts
git commit -m "feat(ux): add trigger.debounceMs and trigger.maxHoldMs config keys"
```

---

### Task 3: Refactor email-sse.ts to use debouncer

Extract the IPC-write logic from `handleTriagedEmails` into a standalone `writeIpcTrigger` function (used as the debouncer's `onFlush` callback). Change `handleTriagedEmails` to add emails to the debouncer instead of writing IPC files directly. The `email.received` event emission stays immediate.

**Files:**
- Modify: `src/email-sse.ts`

- [ ] **Step 1: Refactor email-sse.ts**

Replace the contents of `src/email-sse.ts` with the refactored version. The key changes:

1. Add a module-level `debouncer` variable and a `setEmailTriggerDebouncer` function
2. Extract IPC-write logic into `writeIpcTrigger`
3. In `handleTriagedEmails`, add to debouncer (if set) instead of calling `writeIpcTrigger` directly
4. Export `getEmailTriggerDebouncer` for push suppression checks in index.ts

In `src/email-sse.ts`, make these changes:

**a)** Add imports and module variable after the existing imports:

```typescript
import type { EmailTriggerDebouncer } from './email-trigger-debouncer.js';
```

After the `const connections: SSEConnection[] = [];` line, add:

```typescript
let debouncer: EmailTriggerDebouncer | null = null;

export function setEmailTriggerDebouncer(d: EmailTriggerDebouncer): void {
  debouncer = d;
}

export function getEmailTriggerDebouncer(): EmailTriggerDebouncer | null {
  return debouncer;
}
```

**b)** Extract the IPC-write logic. Add this new function before `handleTriagedEmails`:

```typescript
export function writeIpcTrigger(
  emails: Array<{ thread_id: string; account: string; subject?: string; sender?: string }>,
  label: string,
): void {
  const ipcDir = path.join(DATA_DIR, 'ipc', 'whatsapp_main', 'tasks');
  fs.mkdirSync(ipcDir, { recursive: true });

  const payload = {
    type: 'email_trigger',
    emails: emails.map((e) => ({
      thread_id: e.thread_id,
      account: e.account || 'unknown',
      subject: e.subject || '',
      sender: e.sender || '',
    })),
    triggered_at: new Date().toISOString(),
    source: 'sse',
    connection: label,
  };

  const filename = `sse_trigger_${Date.now()}.json`;
  fs.writeFileSync(
    path.join(ipcDir, filename),
    JSON.stringify(payload, null, 2),
  );
  logger.info(
    { count: emails.length, filename, label },
    'SSE email trigger written',
  );
}
```

**c)** In `handleTriagedEmails`, replace the IPC-write block (lines 230-264, from `// Write IPC trigger file` through the `logger.info` for "SSE email trigger written") with:

```typescript
    // Buffer emails in debouncer (merges rapid-fire triggers into one IPC file)
    // or write IPC directly if no debouncer is configured
    if (debouncer) {
      debouncer.add(
        emails.map(
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
        ),
        label,
      );
    } else {
      writeIpcTrigger(emails, label);
    }
```

The `email.received` event emission block that follows stays exactly as-is.

- [ ] **Step 2: Run typecheck**

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 3: Run full test suite**

Run: `npx vitest run`
Expected: All passing (existing tests unchanged — they don't mock the IPC write)

- [ ] **Step 4: Commit**

```bash
git add src/email-sse.ts
git commit -m "refactor(sse): extract writeIpcTrigger and add debouncer support to handleTriagedEmails"
```

---

### Task 4: Wire debouncer into index.ts and add push suppression

Initialize the debouncer in `main()`, pass it to the SSE module, and add the `debouncer.has()` check in the `email.received` handler to suppress push notifications for buffered emails.

**Files:**
- Modify: `src/index.ts`

- [ ] **Step 1: Add imports**

In `src/index.ts`, add these imports after the existing import block:

```typescript
import { EmailTriggerDebouncer } from './email-trigger-debouncer.js';
import { setEmailTriggerDebouncer, getEmailTriggerDebouncer, writeIpcTrigger } from './email-sse.js';
```

- [ ] **Step 2: Initialize debouncer before startEmailSSE()**

Find the line `startEmailSSE();` (line ~1862). Add before it:

```typescript
  // Initialize email trigger debouncer — buffers rapid-fire SSE triggers
  // into a single merged IPC file to prevent duplicate agent runs
  const triggerDebouncer = new EmailTriggerDebouncer({
    debounceMs: uxConfig.getNumber('trigger.debounceMs'),
    maxHoldMs: uxConfig.getNumber('trigger.maxHoldMs'),
    onFlush: (emails, label) => writeIpcTrigger(emails, label),
  });
  setEmailTriggerDebouncer(triggerDebouncer);
```

- [ ] **Step 3: Add push suppression in email.received handler**

Find the `email.received` handler (line ~2056). In the push notification loop, add a `debouncer.has()` check. Replace the block:

```typescript
            for (const item of pushItems) {
              const message = formatPushMessage({
                source: 'gmail',
                title: item.subject,
                sender: item.sender,
                summary: null,
              });
              channel.sendMessage(notifyJid, message).catch((err) => {
                logger.warn(
                  { err: String(err), itemId: item.itemId },
                  'Failed to send push',
                );
              });
            }
```

With:

```typescript
            const currentDebouncer = getEmailTriggerDebouncer();
            for (const item of pushItems) {
              // Suppress push if email is in debounce buffer —
              // agent will handle it when the buffer flushes
              if (currentDebouncer?.has(item.threadId)) {
                logger.debug(
                  { threadId: item.threadId, itemId: item.itemId },
                  'Push suppressed — email in debounce buffer',
                );
                continue;
              }
              const message = formatPushMessage({
                source: 'gmail',
                title: item.subject,
                sender: item.sender,
                summary: null,
              });
              channel.sendMessage(notifyJid, message).catch((err) => {
                logger.warn(
                  { err: String(err), itemId: item.itemId },
                  'Failed to send push',
                );
              });
            }
```

- [ ] **Step 4: Run typecheck**

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 5: Run full test suite**

Run: `npx vitest run`
Expected: All passing

- [ ] **Step 6: Commit**

```bash
git add src/index.ts
git commit -m "feat(ux): wire trigger debouncer into startup and add push suppression"
```

---

### Task 5: Add debouncer to smoketest

Extend `SmokeTestDeps` and `handleSmokeTest` to include a "Trigger debouncer" health check.

**Files:**
- Modify: `src/chat-commands.ts`
- Modify: `src/__tests__/chat-commands.test.ts`
- Modify: `src/index.ts` (smoketest deps wiring)

- [ ] **Step 1: Add test for debouncer smoketest check**

In `src/__tests__/chat-commands.test.ts`, update the `handleSmokeTest` tests. In the first test ("should run all checks and report results"), add `triggerDebouncer` to the deps:

```typescript
      triggerDebouncer: {
        getBufferSize: () => 0,
      },
```

In the second test ("should report failed checks without stopping"), add the same field:

```typescript
      triggerDebouncer: {
        getBufferSize: () => 2,
      },
```

Add a new test after the existing smoketest tests:

```typescript
  it('should report debouncer buffer size', async () => {
    const deps: SmokeTestDeps = {
      classifyAndFormat,
      gmailOpsRouter: { listRecentDrafts: async () => [], accounts: [] },
      archiveTracker: { getUnarchived: () => [] },
      draftWatcherRunning: true,
      uxConfig: { list: () => [{ key: 'test', value: '1', defaultValue: '1', updatedAt: '' }] },
      miniAppPort: 0,
      triggerDebouncer: { getBufferSize: () => 3 },
    };
    const result = await handleSmokeTest(deps);
    expect(result).toContain('Trigger debouncer');
    expect(result).toContain('3 email(s) buffered');
  });
```

- [ ] **Step 2: Update SmokeTestDeps and handleSmokeTest**

In `src/chat-commands.ts`, add `triggerDebouncer` to the `SmokeTestDeps` interface after `miniAppPort`:

```typescript
  triggerDebouncer: {
    getBufferSize: () => number;
  } | null;
```

In `handleSmokeTest`, add this check after the "Mini App" check (before the `// Format output` comment):

```typescript
  // 7. Trigger debouncer
  if (deps.triggerDebouncer) {
    const bufferSize = deps.triggerDebouncer.getBufferSize();
    results.push({
      name: 'Trigger debouncer',
      ok: true,
      detail: bufferSize > 0 ? `active, ${bufferSize} email(s) buffered` : 'idle, 0 email(s) buffered',
    });
  } else {
    results.push({
      name: 'Trigger debouncer',
      ok: false,
      detail: 'not initialized',
    });
  }
```

- [ ] **Step 3: Update smoketest wiring in index.ts**

In `src/index.ts`, find the `handleSmokeTest({` call (line ~1242). Add `triggerDebouncer` to the deps object after `miniAppPort`:

```typescript
                  triggerDebouncer: triggerDebouncer ?? null,
```

Note: `triggerDebouncer` is declared later in the file (line ~1862 area) but is captured by the closure at runtime. Since the smoketest runs interactively (after startup), it will always see the initialized value. However, to be safe, use the `getEmailTriggerDebouncer()` function instead:

```typescript
                  triggerDebouncer: getEmailTriggerDebouncer(),
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run src/__tests__/chat-commands.test.ts`
Expected: All PASS

- [ ] **Step 5: Run typecheck**

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 6: Commit**

```bash
git add src/chat-commands.ts src/__tests__/chat-commands.test.ts src/index.ts
git commit -m "feat(ux): add trigger debouncer check to smoketest"
```

---

### Task 6: Integration test

End-to-end test verifying the full debounce + push suppression flow.

**Files:**
- Create: `src/__tests__/email-trigger-debounce-integration.test.ts`

- [ ] **Step 1: Write integration test**

Create `src/__tests__/email-trigger-debounce-integration.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EmailTriggerDebouncer } from '../email-trigger-debouncer.js';
import type { SSEEmail } from '../sse-classifier.js';

describe('Email trigger debounce integration', () => {
  let debouncer: EmailTriggerDebouncer;
  let flushed: Array<{ emails: SSEEmail[]; label: string }>;

  beforeEach(() => {
    vi.useFakeTimers();
    flushed = [];
    debouncer = new EmailTriggerDebouncer({
      debounceMs: 60_000,
      maxHoldMs: 300_000,
      onFlush: (emails, label) => flushed.push({ emails, label }),
    });
  });

  afterEach(() => {
    debouncer.destroy();
    vi.useRealTimers();
  });

  it('should coalesce 3 wire transfers into 1 flush', () => {
    // Simulate the actual wire scenario: 3 emails, 45s and 90s apart
    debouncer.add(
      [{ thread_id: '19d9759c', account: 'personal', subject: 'Wire sent ····7958', sender: 'chase@chase.com' }],
      'conn1',
    );
    expect(debouncer.has('19d9759c')).toBe(true);

    vi.advanceTimersByTime(45_000);
    debouncer.add(
      [{ thread_id: '19d975a8', account: 'personal', subject: 'Wire sent ····1269', sender: 'chase@chase.com' }],
      'conn1',
    );
    expect(debouncer.has('19d975a8')).toBe(true);

    vi.advanceTimersByTime(90_000);
    debouncer.add(
      [{ thread_id: '19d975bf', account: 'personal', subject: 'Wire sent ····7958', sender: 'chase@chase.com' }],
      'conn1',
    );

    // At this point all 3 are buffered, no flush yet
    expect(flushed).toHaveLength(0);
    expect(debouncer.getBufferSize()).toBe(3);

    // 60s of quiet → flush
    vi.advanceTimersByTime(60_000);
    expect(flushed).toHaveLength(1);
    expect(flushed[0].emails).toHaveLength(3);
    expect(flushed[0].emails.map((e) => e.thread_id)).toEqual([
      '19d9759c',
      '19d975a8',
      '19d975bf',
    ]);

    // After flush, has() returns false
    expect(debouncer.has('19d9759c')).toBe(false);
    expect(debouncer.has('19d975a8')).toBe(false);
    expect(debouncer.has('19d975bf')).toBe(false);
  });

  it('push suppression: has() returns true while buffered, false after flush', () => {
    debouncer.add(
      [{ thread_id: 'wire1', account: 'personal' }],
      'conn1',
    );

    // Simulate Consumer B checking — should suppress
    expect(debouncer.has('wire1')).toBe(true);

    // Flush
    vi.advanceTimersByTime(60_000);

    // After flush — should not suppress
    expect(debouncer.has('wire1')).toBe(false);
  });

  it('should handle mixed accounts in same window', () => {
    debouncer.add(
      [{ thread_id: 't1', account: 'personal', subject: 'Wire from 7958' }],
      'conn1',
    );
    vi.advanceTimersByTime(30_000);
    debouncer.add(
      [{ thread_id: 't2', account: 'whoisxml', subject: 'Wire from 1269' }],
      'conn1',
    );

    vi.advanceTimersByTime(60_000);
    expect(flushed).toHaveLength(1);
    expect(flushed[0].emails[0].account).toBe('personal');
    expect(flushed[0].emails[1].account).toBe('whoisxml');
  });

  it('solo email should flush after debounce period', () => {
    debouncer.add(
      [{ thread_id: 'solo1', account: 'personal', subject: 'Single email' }],
      'conn1',
    );

    // Push suppressed while buffered
    expect(debouncer.has('solo1')).toBe(true);

    // Flush after 60s
    vi.advanceTimersByTime(60_000);
    expect(flushed).toHaveLength(1);
    expect(flushed[0].emails).toHaveLength(1);
  });

  it('graceful shutdown flushes pending buffer', () => {
    debouncer.add(
      [{ thread_id: 't1', account: 'personal' }],
      'conn1',
    );
    debouncer.add(
      [{ thread_id: 't2', account: 'personal' }],
      'conn1',
    );

    // Simulate shutdown
    debouncer.flush();
    expect(flushed).toHaveLength(1);
    expect(flushed[0].emails).toHaveLength(2);
  });
});
```

- [ ] **Step 2: Run tests**

Run: `npx vitest run src/__tests__/email-trigger-debounce-integration.test.ts`
Expected: All PASS

- [ ] **Step 3: Run full suite + typecheck**

Run: `npx vitest run && npx tsc --noEmit`
Expected: All passing

- [ ] **Step 4: Commit**

```bash
git add src/__tests__/email-trigger-debounce-integration.test.ts
git commit -m "test(ux): add integration tests for email trigger debounce and push suppression"
```
