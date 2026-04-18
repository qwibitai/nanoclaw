# Browser Watchers & Calendar Integration Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire browser watchers end-to-end (config storage → extract → poll → notify) and add the OneCLI calendar proxy endpoint so the existing calendar poller can fetch real events.

**Architecture:** Browser watchers use a new `browser_watchers` SQLite table for config CRUD. A polling loop in `index.ts` calls `evaluateWatcher()` per active config using a real Playwright-based `extractText` function. The `watcher.changed` event bus subscriber notifies the user via their primary channel. OneCLI gets a `/calendar/events` proxy endpoint that calls Google Calendar API.

**Tech Stack:** TypeScript, better-sqlite3, Playwright-core (CDP), vitest, Google Calendar API (via googleapis)

---

### Task 1: Watcher Config Storage (DB table + CRUD)

**Files:**
- Modify: `src/db.ts` — add `browser_watchers` table to schema
- Create: `src/watchers/watcher-store.ts` — CRUD functions
- Create: `src/watchers/watcher-store.test.ts` — unit tests

- [ ] **Step 1: Write the failing test for watcher store CRUD**

```typescript
// src/watchers/watcher-store.test.ts
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { _initTestDatabase, _closeDatabase } from '../db.js';

vi.mock('../logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('../config.js', () => ({
  STORE_DIR: '/tmp/test-store',
  DATA_DIR: '/tmp/test-data',
  ASSISTANT_NAME: 'TestBot',
}));

import {
  addWatcher,
  getWatcher,
  listWatchers,
  updateWatcherValue,
  removeWatcher,
  type StoredWatcher,
} from './watcher-store.js';

beforeEach(() => _initTestDatabase());
afterEach(() => _closeDatabase());

describe('watcher-store', () => {
  const base = {
    url: 'https://example.com/pricing',
    selector: '.price',
    groupId: 'telegram_main',
    intervalMs: 60_000,
    label: 'Example price',
  };

  it('addWatcher inserts and returns a watcher with generated id', () => {
    const w = addWatcher(base);
    expect(w.id).toMatch(/^watcher-/);
    expect(w.url).toBe(base.url);
    expect(w.lastValue).toBeNull();
    expect(w.enabled).toBe(true);
  });

  it('getWatcher retrieves by id', () => {
    const w = addWatcher(base);
    const found = getWatcher(w.id);
    expect(found).toBeDefined();
    expect(found!.url).toBe(base.url);
  });

  it('getWatcher returns undefined for unknown id', () => {
    expect(getWatcher('no-such-id')).toBeUndefined();
  });

  it('listWatchers returns all watchers for a group', () => {
    addWatcher(base);
    addWatcher({ ...base, url: 'https://other.com', label: 'Other' });
    expect(listWatchers('telegram_main')).toHaveLength(2);
    expect(listWatchers('other_group')).toHaveLength(0);
  });

  it('listWatchers with enabledOnly=true excludes disabled watchers', () => {
    const w = addWatcher(base);
    removeWatcher(w.id); // sets enabled = false
    expect(listWatchers('telegram_main', true)).toHaveLength(0);
    expect(listWatchers('telegram_main', false)).toHaveLength(1);
  });

  it('updateWatcherValue updates lastValue and checkedAt', () => {
    const w = addWatcher(base);
    updateWatcherValue(w.id, '$42.00');
    const updated = getWatcher(w.id)!;
    expect(updated.lastValue).toBe('$42.00');
    expect(updated.checkedAt).toBeTruthy();
  });

  it('removeWatcher soft-deletes by setting enabled = false', () => {
    const w = addWatcher(base);
    removeWatcher(w.id);
    const found = getWatcher(w.id)!;
    expect(found.enabled).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/watchers/watcher-store.test.ts`
Expected: FAIL — module `./watcher-store.js` not found

- [ ] **Step 3: Add browser_watchers table to DB schema**

In `src/db.ts`, add the following table inside the `createSchema` function, after the `delegation_counters` table (before the closing `\``):

```typescript
    CREATE TABLE IF NOT EXISTS browser_watchers (
      id TEXT PRIMARY KEY,
      url TEXT NOT NULL,
      selector TEXT NOT NULL,
      group_id TEXT NOT NULL,
      interval_ms INTEGER NOT NULL DEFAULT 60000,
      label TEXT NOT NULL DEFAULT '',
      last_value TEXT,
      checked_at INTEGER,
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_browser_watchers_group ON browser_watchers(group_id, enabled);
```

- [ ] **Step 4: Write watcher-store implementation**

```typescript
// src/watchers/watcher-store.ts
import { randomUUID } from 'crypto';
import { getDb } from '../db.js';
import { logger } from '../logger.js';

export interface StoredWatcher {
  id: string;
  url: string;
  selector: string;
  groupId: string;
  intervalMs: number;
  label: string;
  lastValue: string | null;
  checkedAt: number | null;
  enabled: boolean;
  createdAt: number;
}

interface WatcherRow {
  id: string;
  url: string;
  selector: string;
  group_id: string;
  interval_ms: number;
  label: string;
  last_value: string | null;
  checked_at: number | null;
  enabled: number;
  created_at: number;
}

function rowToWatcher(row: WatcherRow): StoredWatcher {
  return {
    id: row.id,
    url: row.url,
    selector: row.selector,
    groupId: row.group_id,
    intervalMs: row.interval_ms,
    label: row.label,
    lastValue: row.last_value,
    checkedAt: row.checked_at,
    enabled: row.enabled === 1,
    createdAt: row.created_at,
  };
}

export function addWatcher(input: {
  url: string;
  selector: string;
  groupId: string;
  intervalMs: number;
  label: string;
}): StoredWatcher {
  const db = getDb();
  const id = `watcher-${randomUUID().slice(0, 8)}`;
  const now = Date.now();

  db.prepare(
    `INSERT INTO browser_watchers (id, url, selector, group_id, interval_ms, label, last_value, checked_at, enabled, created_at)
     VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, 1, ?)`,
  ).run(id, input.url, input.selector, input.groupId, input.intervalMs, input.label, now);

  logger.info({ id, url: input.url, groupId: input.groupId }, 'Browser watcher added');

  return {
    id,
    url: input.url,
    selector: input.selector,
    groupId: input.groupId,
    intervalMs: input.intervalMs,
    label: input.label,
    lastValue: null,
    checkedAt: null,
    enabled: true,
    createdAt: now,
  };
}

export function getWatcher(id: string): StoredWatcher | undefined {
  const db = getDb();
  const row = db.prepare('SELECT * FROM browser_watchers WHERE id = ?').get(id) as WatcherRow | undefined;
  return row ? rowToWatcher(row) : undefined;
}

export function listWatchers(groupId: string, enabledOnly = false): StoredWatcher[] {
  const db = getDb();
  const sql = enabledOnly
    ? 'SELECT * FROM browser_watchers WHERE group_id = ? AND enabled = 1 ORDER BY created_at'
    : 'SELECT * FROM browser_watchers WHERE group_id = ? ORDER BY created_at';
  const rows = db.prepare(sql).all(groupId) as WatcherRow[];
  return rows.map(rowToWatcher);
}

export function listAllEnabledWatchers(): StoredWatcher[] {
  const db = getDb();
  const rows = db
    .prepare('SELECT * FROM browser_watchers WHERE enabled = 1 ORDER BY created_at')
    .all() as WatcherRow[];
  return rows.map(rowToWatcher);
}

export function updateWatcherValue(id: string, value: string): void {
  const db = getDb();
  db.prepare('UPDATE browser_watchers SET last_value = ?, checked_at = ? WHERE id = ?')
    .run(value, Date.now(), id);
}

export function removeWatcher(id: string): void {
  const db = getDb();
  db.prepare('UPDATE browser_watchers SET enabled = 0 WHERE id = ?').run(id);
  logger.info({ id }, 'Browser watcher disabled');
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run src/watchers/watcher-store.test.ts`
Expected: PASS — all 7 tests green

- [ ] **Step 6: Commit**

```bash
git add src/db.ts src/watchers/watcher-store.ts src/watchers/watcher-store.test.ts
git commit -m "feat: add browser_watchers DB table and CRUD store"
```

---

### Task 2: Playwright-based Extract Function

**Files:**
- Create: `src/watchers/extract-text.ts` — extract function using BrowserSessionManager
- Create: `src/watchers/extract-text.test.ts` — unit tests with mocked Playwright

- [ ] **Step 1: Write the failing test**

```typescript
// src/watchers/extract-text.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { createExtractFn } from './extract-text.js';

describe('createExtractFn', () => {
  it('navigates to the URL and extracts textContent from the selector', async () => {
    const textContent = '$42.00';
    const mockPage = {
      goto: vi.fn().mockResolvedValue(undefined),
      textContent: vi.fn().mockResolvedValue(textContent),
      close: vi.fn().mockResolvedValue(undefined),
    };
    const mockContext = {
      newPage: vi.fn().mockResolvedValue(mockPage),
    };
    const mockSessionManager = {
      acquireContext: vi.fn().mockResolvedValue(mockContext),
    };

    const extract = createExtractFn(mockSessionManager as any, 'test-group');
    const result = await extract('https://example.com', '.price');

    expect(mockSessionManager.acquireContext).toHaveBeenCalledWith('test-group');
    expect(mockPage.goto).toHaveBeenCalledWith('https://example.com', { waitUntil: 'domcontentloaded', timeout: 30_000 });
    expect(mockPage.textContent).toHaveBeenCalledWith('.price', { timeout: 10_000 });
    expect(mockPage.close).toHaveBeenCalled();
    expect(result).toBe('$42.00');
  });

  it('returns empty string when textContent returns null', async () => {
    const mockPage = {
      goto: vi.fn().mockResolvedValue(undefined),
      textContent: vi.fn().mockResolvedValue(null),
      close: vi.fn().mockResolvedValue(undefined),
    };
    const mockContext = {
      newPage: vi.fn().mockResolvedValue(mockPage),
    };
    const mockSessionManager = {
      acquireContext: vi.fn().mockResolvedValue(mockContext),
    };

    const extract = createExtractFn(mockSessionManager as any, 'test-group');
    const result = await extract('https://example.com', '.missing');

    expect(result).toBe('');
  });

  it('closes the page even when textContent throws', async () => {
    const mockPage = {
      goto: vi.fn().mockResolvedValue(undefined),
      textContent: vi.fn().mockRejectedValue(new Error('selector not found')),
      close: vi.fn().mockResolvedValue(undefined),
    };
    const mockContext = {
      newPage: vi.fn().mockResolvedValue(mockPage),
    };
    const mockSessionManager = {
      acquireContext: vi.fn().mockResolvedValue(mockContext),
    };

    const extract = createExtractFn(mockSessionManager as any, 'test-group');
    await expect(extract('https://example.com', '.bad')).rejects.toThrow('selector not found');
    expect(mockPage.close).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/watchers/extract-text.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Write the extract function implementation**

```typescript
// src/watchers/extract-text.ts
import type { BrowserSessionManager } from '../browser/session-manager.js';
import { logger } from '../logger.js';

/**
 * Create an extract function bound to a BrowserSessionManager and groupId.
 * The returned function navigates to a URL, reads textContent from a CSS
 * selector, then closes the page. Suitable as the `extract` parameter for
 * `evaluateWatcher()`.
 */
export function createExtractFn(
  sessionManager: BrowserSessionManager,
  groupId: string,
): (url: string, selector: string) => Promise<string> {
  return async (url: string, selector: string): Promise<string> => {
    const ctx = await sessionManager.acquireContext(groupId);
    const page = await ctx.newPage();

    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
      const text = await page.textContent(selector, { timeout: 10_000 });
      return text ?? '';
    } finally {
      await page.close().catch((err: unknown) => {
        logger.warn({ err, url }, 'Failed to close watcher page');
      });
    }
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/watchers/extract-text.test.ts`
Expected: PASS — all 3 tests green

- [ ] **Step 5: Commit**

```bash
git add src/watchers/extract-text.ts src/watchers/extract-text.test.ts
git commit -m "feat: add Playwright-based extract function for browser watchers"
```

---

### Task 3: Watcher Polling Loop

**Files:**
- Create: `src/watchers/watcher-poller.ts` — polling loop that evaluates all enabled watchers
- Create: `src/watchers/watcher-poller.test.ts` — unit tests

- [ ] **Step 1: Write the failing test**

```typescript
// src/watchers/watcher-poller.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { _initTestDatabase, _closeDatabase } from '../db.js';

vi.mock('../logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('../config.js', () => ({
  STORE_DIR: '/tmp/test-store',
  DATA_DIR: '/tmp/test-data',
  ASSISTANT_NAME: 'TestBot',
}));
vi.mock('../event-bus.js', () => ({
  eventBus: { emit: vi.fn() },
}));

import { addWatcher } from './watcher-store.js';
import { pollAllWatchers } from './watcher-poller.js';
import { getWatcher } from './watcher-store.js';
import { eventBus } from '../event-bus.js';

beforeEach(() => _initTestDatabase());
afterEach(() => _closeDatabase());

describe('pollAllWatchers', () => {
  it('calls extract for each enabled watcher and updates lastValue on change', async () => {
    addWatcher({
      url: 'https://example.com',
      selector: '.price',
      groupId: 'test-group',
      intervalMs: 60_000,
      label: 'Price',
    });

    const extract = vi.fn().mockResolvedValue('$42.00');
    const results = await pollAllWatchers(extract);

    expect(results).toHaveLength(1);
    expect(results[0].changed).toBe(true);
    expect(results[0].newValue).toBe('$42.00');
    expect(extract).toHaveBeenCalledWith('https://example.com', '.price');
  });

  it('skips watchers whose interval has not elapsed since last check', async () => {
    const w = addWatcher({
      url: 'https://example.com',
      selector: '.price',
      groupId: 'test-group',
      intervalMs: 60_000,
      label: 'Price',
    });

    // Simulate a recent check
    const { updateWatcherValue } = await import('./watcher-store.js');
    updateWatcherValue(w.id, '$40.00');

    const extract = vi.fn().mockResolvedValue('$42.00');
    const results = await pollAllWatchers(extract);

    // Should skip because checkedAt is recent (< intervalMs ago)
    expect(results).toHaveLength(0);
    expect(extract).not.toHaveBeenCalled();
  });

  it('updates the stored lastValue after a successful extraction', async () => {
    const w = addWatcher({
      url: 'https://example.com',
      selector: '.price',
      groupId: 'test-group',
      intervalMs: 60_000,
      label: 'Price',
    });

    const extract = vi.fn().mockResolvedValue('$42.00');
    await pollAllWatchers(extract);

    const updated = getWatcher(w.id)!;
    expect(updated.lastValue).toBe('$42.00');
  });

  it('emits watcher.changed event when value changes', async () => {
    addWatcher({
      url: 'https://example.com',
      selector: '.price',
      groupId: 'test-group',
      intervalMs: 60_000,
      label: 'Price',
    });

    const extract = vi.fn().mockResolvedValue('$42.00');
    await pollAllWatchers(extract);

    const mockEmit = vi.mocked(eventBus.emit);
    expect(mockEmit).toHaveBeenCalledWith(
      'watcher.changed',
      expect.objectContaining({
        type: 'watcher.changed',
        payload: expect.objectContaining({
          newValue: '$42.00',
        }),
      }),
    );
  });

  it('handles extraction errors gracefully without crashing the poll loop', async () => {
    addWatcher({
      url: 'https://example.com',
      selector: '.price',
      groupId: 'test-group',
      intervalMs: 60_000,
      label: 'Price',
    });
    addWatcher({
      url: 'https://other.com',
      selector: '.stock',
      groupId: 'test-group',
      intervalMs: 60_000,
      label: 'Stock',
    });

    const extract = vi.fn()
      .mockRejectedValueOnce(new Error('timeout'))
      .mockResolvedValueOnce('In Stock');

    const results = await pollAllWatchers(extract);

    // First watcher errored, second succeeded
    expect(results).toHaveLength(2);
    expect(results[0].error).toBe('timeout');
    expect(results[1].changed).toBe(true);
    expect(results[1].newValue).toBe('In Stock');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/watchers/watcher-poller.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Write the polling loop implementation**

```typescript
// src/watchers/watcher-poller.ts
import { evaluateWatcher, type WatcherResult } from './browser-watcher.js';
import { listAllEnabledWatchers, updateWatcherValue } from './watcher-store.js';
import { logger } from '../logger.js';

/**
 * Poll all enabled watchers. Skips watchers whose interval has not elapsed
 * since last check. Updates stored lastValue on successful extraction.
 *
 * @param extract — injected function that fetches text from a URL+selector.
 *                  In production, use createExtractFn(). In tests, use a mock.
 * @returns Array of WatcherResult for each watcher evaluated.
 */
export async function pollAllWatchers(
  extract: (url: string, selector: string) => Promise<string>,
): Promise<WatcherResult[]> {
  const watchers = listAllEnabledWatchers();
  const now = Date.now();
  const results: WatcherResult[] = [];

  for (const watcher of watchers) {
    // Skip if interval hasn't elapsed
    if (watcher.checkedAt && now - watcher.checkedAt < watcher.intervalMs) {
      logger.debug(
        { watcherId: watcher.id, nextCheckIn: watcher.intervalMs - (now - watcher.checkedAt) },
        'Watcher poll: skipping, interval not elapsed',
      );
      continue;
    }

    const config = {
      id: watcher.id,
      url: watcher.url,
      selector: watcher.selector,
      groupId: watcher.groupId,
      intervalMs: watcher.intervalMs,
    };

    const result = await evaluateWatcher(config, watcher.lastValue, extract);
    results.push(result);

    // Update stored value on successful extraction (even if unchanged)
    if (result.newValue !== null) {
      updateWatcherValue(watcher.id, result.newValue);
    }
  }

  logger.debug(
    { total: watchers.length, evaluated: results.length },
    'Watcher poll cycle complete',
  );

  return results;
}

let pollerTimer: ReturnType<typeof setInterval> | null = null;

/**
 * Start the watcher polling loop. Calls pollAllWatchers on a fixed interval.
 * The minimum tick is 30s; each watcher's own intervalMs controls whether it
 * is actually evaluated on a given tick.
 */
export function startWatcherPoller(
  extract: (url: string, selector: string) => Promise<string>,
  tickMs = 30_000,
): void {
  if (pollerTimer !== null) {
    logger.warn('Watcher poller already running');
    return;
  }

  pollerTimer = setInterval(() => {
    pollAllWatchers(extract).catch((err: unknown) => {
      logger.error({ err }, 'Watcher poll error');
    });
  }, tickMs);

  logger.info({ tickMs }, 'Watcher poller started');
}

/**
 * Stop the watcher polling loop.
 */
export function stopWatcherPoller(): void {
  if (pollerTimer !== null) {
    clearInterval(pollerTimer);
    pollerTimer = null;
    logger.info('Watcher poller stopped');
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/watchers/watcher-poller.test.ts`
Expected: PASS — all 5 tests green

- [ ] **Step 5: Commit**

```bash
git add src/watchers/watcher-poller.ts src/watchers/watcher-poller.test.ts
git commit -m "feat: add watcher polling loop with interval-aware scheduling"
```

---

### Task 4: Wire Watcher Poller and Event Consumer into index.ts

**Files:**
- Modify: `src/index.ts` — import and start watcher poller, subscribe to `watcher.changed`

- [ ] **Step 1: Add imports to index.ts**

Add these imports near the other watcher imports (around line 95-97):

```typescript
import { startWatcherPoller, stopWatcherPoller } from './watchers/watcher-poller.js';
import { createExtractFn } from './watchers/extract-text.js';
```

- [ ] **Step 2: Wire watcher.changed event consumer**

In the startup section of `main()`, after the `startCalendarPoller()` call (around line 1488), add:

```typescript
  // Browser watcher polling
  if (browserSessionManager) {
    // Use a shared groupId for watcher extractions — watchers are cross-group
    const watcherExtract = createExtractFn(browserSessionManager, '__watchers__');
    startWatcherPoller(watcherExtract);
  }

  // Notify user when a browser watcher detects a change
  eventBus.on('watcher.changed', (event) => {
    const payload = event.payload as {
      watcherId: string;
      url: string;
      selector: string;
      previousValue: string | null;
      newValue: string | null;
      groupId: string;
    };

    const groupJid = Object.keys(registeredGroups).find(
      (jid) => registeredGroups[jid].folder === payload.groupId,
    );
    if (!groupJid) {
      logger.warn({ payload }, 'watcher.changed: no group found for groupId');
      return;
    }

    const channel = findChannel(channels, groupJid);
    if (!channel) {
      logger.warn({ groupJid }, 'watcher.changed: no channel for JID');
      return;
    }

    const msg =
      `🔔 **Watcher update** (${payload.watcherId})\n` +
      `URL: ${payload.url}\n` +
      `Changed: ${payload.previousValue ?? '(first check)'} → ${payload.newValue}`;

    channel.sendMessage(groupJid, msg).catch((err: unknown) => {
      logger.error({ err, groupJid }, 'watcher.changed: failed to send notification');
    });
  });
```

- [ ] **Step 3: Add cleanup on shutdown**

In the shutdown/cleanup section of `main()`, find where `stopCalendarPoller()` is called and add `stopWatcherPoller()` nearby:

```typescript
  stopWatcherPoller();
```

- [ ] **Step 4: Run full test suite to verify nothing breaks**

Run: `npx vitest run`
Expected: All existing tests pass (no new test needed for this wiring — it's integration)

- [ ] **Step 5: Commit**

```bash
git add src/index.ts
git commit -m "feat: wire browser watcher poller and change notifications into main loop"
```

---

### Task 5: OneCLI Calendar Proxy Endpoint

**Context:** OneCLI is a separate Node.js gateway service that NanoClaw uses for secret injection and API proxying. It runs at `http://localhost:10254`. The NanoClaw calendar poller already calls `GET /calendar/events?from=&to=` and gracefully handles 404. This task adds the actual endpoint to OneCLI so it returns real Google Calendar events.

**Important:** OneCLI lives OUTSIDE the nanoclaw repo. This task documents exactly what needs to be built. If the OneCLI repo is accessible locally at `~/dev/onecli`, implement there. Otherwise, create a standalone implementation file that can be dropped in.

**Files:**
- Create: `docs/onecli-calendar-endpoint.md` — specification document for the OneCLI team/future self

- [ ] **Step 1: Write the OneCLI endpoint specification**

```markdown
// docs/onecli-calendar-endpoint.md

# OneCLI Calendar Endpoint Specification

## Endpoint

`GET /calendar/events?from={epochMs}&to={epochMs}`

## Response Format

```json
{
  "events": [
    {
      "id": "google-event-id",
      "title": "Team Standup",
      "summary": "Team Standup",
      "start": "2026-04-16T09:00:00-07:00",
      "end": "2026-04-16T09:30:00-07:00",
      "attendees": [
        { "email": "alice@example.com" },
        { "email": "bob@example.com" }
      ],
      "location": "https://meet.google.com/xyz",
      "source_account": "jonathan@attaxion.com"
    }
  ]
}
```

## Implementation Notes

1. **Google Calendar API scope:** `https://www.googleapis.com/auth/calendar.readonly`
2. **OAuth:** Reuse the existing Google OAuth flow in OneCLI (same token store used for Gmail)
3. **Multi-account:** Query all configured Google accounts, merge results, tag each event with `source_account`
4. **Time filter:** Convert `from`/`to` epoch ms to RFC 3339 for the Google API `timeMin`/`timeMax` params
5. **API call:** `calendar.events.list({ calendarId: 'primary', timeMin, timeMax, singleEvents: true, orderBy: 'startTime' })`
6. **Error handling:** Return `{ events: [] }` on auth failures rather than 500, so the poller continues gracefully

## NanoClaw Integration

The NanoClaw calendar poller (`src/calendar-poller.ts`) already:
- Calls this endpoint every 5 minutes
- Handles 404 gracefully (logs debug, returns)
- Parses `summary` OR `title` fields
- Handles `{dateTime: string}` or ISO string or epoch for start/end
- Extracts attendees from `string[]` or `{email: string}[]`
- Stores events in the `calendar_events` SQLite table
- Emits `calendar.synced` event
- Meeting briefings check for events starting within 15 minutes
```

- [ ] **Step 2: Commit**

```bash
git add docs/onecli-calendar-endpoint.md
git commit -m "docs: add OneCLI calendar endpoint specification"
```

---

### Task 6: Calendar Poller Hardening Tests

**Files:**
- Modify: `src/__tests__/calendar-poller.test.ts` — add tests for pollCalendar() with mocked fetch

- [ ] **Step 1: Write additional tests for pollCalendar**

Add to the existing `src/__tests__/calendar-poller.test.ts`:

```typescript
import { pollCalendar, cleanupOldEvents } from '../calendar-poller.js';
import { eventBus } from '../event-bus.js';

describe('pollCalendar', () => {
  it('stores events from a successful fetch and emits calendar.synced', async () => {
    const mockEvents = [
      {
        id: 'evt-poll-1',
        title: 'Standup',
        start: '2026-04-16T09:00:00Z',
        end: '2026-04-16T09:30:00Z',
        attendees: [{ email: 'alice@test.com' }],
        location: 'Zoom',
        source_account: 'work@test.com',
      },
    ];

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ events: mockEvents }),
    });

    await pollCalendar();

    expect(vi.mocked(eventBus.emit)).toHaveBeenCalledWith(
      'calendar.synced',
      expect.objectContaining({
        type: 'calendar.synced',
        payload: expect.objectContaining({ eventsFound: 1 }),
      }),
    );

    // Verify event was stored
    const stored = getUpcomingEvents(0, Date.now() + 999999999999);
    expect(stored.some((e) => e.id === 'evt-poll-1')).toBe(true);
  });

  it('handles non-OK response gracefully without throwing', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 404,
    });

    await expect(pollCalendar()).resolves.toBeUndefined();
  });

  it('handles response with summary field instead of title', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        events: [
          {
            id: 'evt-summary',
            summary: 'Weekly Sync',
            start: { dateTime: '2026-04-16T10:00:00-07:00' },
            end: { dateTime: '2026-04-16T10:30:00-07:00' },
            attendees: ['bob@test.com'],
          },
        ],
      }),
    });

    await pollCalendar();

    const stored = getUpcomingEvents(0, Date.now() + 999999999999);
    const evt = stored.find((e) => e.id === 'evt-summary');
    expect(evt).toBeDefined();
    expect(evt!.title).toBe('Weekly Sync');
  });
});

describe('cleanupOldEvents', () => {
  it('removes events older than the cutoff', () => {
    const oldEvent = {
      id: 'old-evt',
      title: 'Old Meeting',
      start_time: 1000,
      end_time: 2000,
      attendees: [],
      location: null,
      source_account: null,
    };
    const recentEvent = {
      id: 'recent-evt',
      title: 'Recent Meeting',
      start_time: Date.now() - 1000,
      end_time: Date.now() + 3600000,
      attendees: [],
      location: null,
      source_account: null,
    };

    storeCalendarEvents([oldEvent, recentEvent]);
    cleanupOldEvents(86400000); // 1 day

    const remaining = getUpcomingEvents(0, Date.now() + 999999999999);
    expect(remaining.some((e) => e.id === 'old-evt')).toBe(false);
    expect(remaining.some((e) => e.id === 'recent-evt')).toBe(true);
  });
});
```

- [ ] **Step 2: Run tests to verify they pass**

Run: `npx vitest run src/__tests__/calendar-poller.test.ts`
Expected: PASS — all existing + new tests green

- [ ] **Step 3: Commit**

```bash
git add src/__tests__/calendar-poller.test.ts
git commit -m "test: add pollCalendar and cleanupOldEvents tests"
```

---

### Task 7: Integration Test — Watcher End-to-End

**Files:**
- Create: `src/__tests__/watcher-integration.test.ts` — end-to-end test: add watcher → poll → detect change → event emitted

- [ ] **Step 1: Write the integration test**

```typescript
// src/__tests__/watcher-integration.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { _initTestDatabase, _closeDatabase } from '../db.js';

vi.mock('../logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('../config.js', () => ({
  STORE_DIR: '/tmp/test-store',
  DATA_DIR: '/tmp/test-data',
  ASSISTANT_NAME: 'TestBot',
}));
vi.mock('../event-bus.js', () => ({
  eventBus: { emit: vi.fn() },
}));

import { addWatcher, getWatcher } from '../watchers/watcher-store.js';
import { pollAllWatchers } from '../watchers/watcher-poller.js';
import { eventBus } from '../event-bus.js';

const mockEmit = vi.mocked(eventBus.emit);

beforeEach(() => {
  _initTestDatabase();
  mockEmit.mockClear();
});
afterEach(() => _closeDatabase());

describe('Browser Watcher Integration', () => {
  it('full lifecycle: add → first poll detects value → second poll detects change → event emitted twice', async () => {
    // 1. Add a watcher
    const w = addWatcher({
      url: 'https://shop.example.com/product',
      selector: '.current-price',
      groupId: 'telegram_main',
      intervalMs: 1, // 1ms interval so second poll isn't skipped
      label: 'Product price',
    });

    // 2. First poll — should detect initial value (previousValue is null)
    const extract1 = vi.fn().mockResolvedValue('$99.99');
    const results1 = await pollAllWatchers(extract1);

    expect(results1).toHaveLength(1);
    expect(results1[0].changed).toBe(true);
    expect(results1[0].previousValue).toBeNull();
    expect(results1[0].newValue).toBe('$99.99');

    // Verify stored value updated
    const after1 = getWatcher(w.id)!;
    expect(after1.lastValue).toBe('$99.99');

    // 3. Second poll — value changed
    const extract2 = vi.fn().mockResolvedValue('$79.99');
    // Wait 2ms to pass the 1ms interval
    await new Promise((r) => setTimeout(r, 2));
    const results2 = await pollAllWatchers(extract2);

    expect(results2).toHaveLength(1);
    expect(results2[0].changed).toBe(true);
    expect(results2[0].previousValue).toBe('$99.99');
    expect(results2[0].newValue).toBe('$79.99');

    // Verify event bus emitted watcher.changed twice (once per change)
    const watcherEvents = mockEmit.mock.calls.filter(
      ([type]) => type === 'watcher.changed',
    );
    expect(watcherEvents).toHaveLength(2);

    // Verify second event payload
    const secondPayload = watcherEvents[1][1].payload;
    expect(secondPayload.previousValue).toBe('$99.99');
    expect(secondPayload.newValue).toBe('$79.99');
  });

  it('no event emitted when value stays the same', async () => {
    addWatcher({
      url: 'https://shop.example.com/product',
      selector: '.current-price',
      groupId: 'telegram_main',
      intervalMs: 1,
      label: 'Product price',
    });

    // First poll sets baseline
    await pollAllWatchers(vi.fn().mockResolvedValue('$99.99'));
    mockEmit.mockClear();

    // Second poll — same value
    await new Promise((r) => setTimeout(r, 2));
    await pollAllWatchers(vi.fn().mockResolvedValue('$99.99'));

    const watcherEvents = mockEmit.mock.calls.filter(
      ([type]) => type === 'watcher.changed',
    );
    expect(watcherEvents).toHaveLength(0);
  });

  it('extraction error does not crash poll and no event is emitted', async () => {
    addWatcher({
      url: 'https://shop.example.com/product',
      selector: '.current-price',
      groupId: 'telegram_main',
      intervalMs: 60_000,
      label: 'Product price',
    });

    const extract = vi.fn().mockRejectedValue(new Error('DNS resolution failed'));
    const results = await pollAllWatchers(extract);

    expect(results).toHaveLength(1);
    expect(results[0].changed).toBe(false);
    expect(results[0].error).toBe('DNS resolution failed');

    const watcherEvents = mockEmit.mock.calls.filter(
      ([type]) => type === 'watcher.changed',
    );
    expect(watcherEvents).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run the integration test**

Run: `npx vitest run src/__tests__/watcher-integration.test.ts`
Expected: PASS — all 3 tests green

- [ ] **Step 3: Run the full test suite**

Run: `npx vitest run`
Expected: All tests pass, no regressions

- [ ] **Step 4: Commit**

```bash
git add src/__tests__/watcher-integration.test.ts
git commit -m "test: add browser watcher end-to-end integration test"
```

---

### Task 8: PR #1795 Review Response (Monitoring)

**Context:** PR #1795 is open at `origin` (topcoder1/nanoclaw) with no reviews yet. Reviewers gavrielc and gabi-simons are pending. No code changes needed — this task sets up a monitoring check.

**Files:**
- No code changes

- [ ] **Step 1: Check current PR status**

```bash
gh pr view 1795 --json state,reviews,reviewRequests
```

Expected: `state: "OPEN"`, `reviews: []`, `reviewRequests` includes the pending reviewers.

- [ ] **Step 2: If reviews exist, create a follow-up task**

If any review comments are present:
- Read each comment with `gh api repos/topcoder1/nanoclaw/pulls/1795/comments`
- For each actionable comment, create a task to address it
- Run `/qodo-pr-resolver 1795` to batch-process any Qodo review issues

If no reviews exist: mark this task as complete, re-check on next session.

- [ ] **Step 3: Commit (only if changes were made)**

```bash
# Only if review feedback required code changes
git add -A
git commit -m "fix: address PR #1795 review feedback"
```
