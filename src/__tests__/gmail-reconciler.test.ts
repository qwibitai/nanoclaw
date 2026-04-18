import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('../logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
  },
}));

vi.mock('../config.js', () => ({
  TIMEZONE: 'America/Los_Angeles',
  DATA_DIR: '/tmp/nanoclaw-test',
  STORE_DIR: '/tmp/nanoclaw-test/store',
  ASSISTANT_NAME: 'Andy',
}));

import { _initTestDatabase, _closeDatabase, getDb } from '../db.js';
import { insertTrackedItem, type TrackedItem } from '../tracked-items.js';
import { reconcileOnce, RACE_GUARD_MS } from '../triage/gmail-reconciler.js';

function makeGmailItem(
  id: string,
  threadId: string,
  detectedAt: number,
  account = 'topcoder1@gmail.com',
): TrackedItem {
  return {
    id,
    source: 'gmail',
    source_id: `gmail:${threadId}`,
    group_name: 'main',
    state: 'queued',
    classification: 'digest',
    superpilot_label: null,
    trust_tier: null,
    title: 'Test email',
    summary: null,
    thread_id: threadId,
    detected_at: detectedAt,
    pushed_at: null,
    resolved_at: null,
    resolution_method: null,
    digest_count: 0,
    telegram_message_id: null,
    classification_reason: null,
    metadata: { account },
  };
}

describe('gmail-reconciler', () => {
  const now = 10_000_000;
  const OLD = now - RACE_GUARD_MS - 1000; // outside race guard
  const FRESH = now - 5000; // inside race guard

  beforeEach(() => {
    _initTestDatabase();
  });

  afterEach(() => {
    _closeDatabase();
  });

  it('resolves items whose thread is no longer in INBOX', async () => {
    insertTrackedItem(makeGmailItem('item-a', 'thread-a', OLD));
    insertTrackedItem(makeGmailItem('item-b', 'thread-b', OLD));

    const gmailOps = {
      getThreadInboxStatus: vi.fn(async (_acct: string, tid: string) =>
        tid === 'thread-a' ? ('out' as const) : ('in' as const),
      ),
    };

    const result = await reconcileOnce({
      db: getDb(),
      gmailOps,
      now: () => now,
    });

    expect(result).toEqual({
      checked: 2,
      resolved: 1,
      skipped: 0,
      errors: 0,
    });

    const a = getDb()
      .prepare(
        'SELECT state, resolution_method FROM tracked_items WHERE id = ?',
      )
      .get('item-a') as { state: string; resolution_method: string };
    expect(a.state).toBe('resolved');
    expect(a.resolution_method).toBe('gmail:external');

    const b = getDb()
      .prepare('SELECT state FROM tracked_items WHERE id = ?')
      .get('item-b') as { state: string };
    expect(b.state).toBe('queued');
  });

  it('also resolves missing threads (404/deleted)', async () => {
    insertTrackedItem(makeGmailItem('item-c', 'thread-c', OLD));
    const gmailOps = {
      getThreadInboxStatus: vi.fn(async () => 'missing' as const),
    };

    const result = await reconcileOnce({
      db: getDb(),
      gmailOps,
      now: () => now,
    });

    expect(result.resolved).toBe(1);
    const c = getDb()
      .prepare('SELECT state FROM tracked_items WHERE id = ?')
      .get('item-c') as { state: string };
    expect(c.state).toBe('resolved');
  });

  it('skips items inside the race guard window', async () => {
    insertTrackedItem(makeGmailItem('item-fresh', 'thread-fresh', FRESH));
    const gmailOps = {
      getThreadInboxStatus: vi.fn(async () => 'out' as const),
    };

    const result = await reconcileOnce({
      db: getDb(),
      gmailOps,
      now: () => now,
    });

    expect(result.checked).toBe(0);
    expect(gmailOps.getThreadInboxStatus).not.toHaveBeenCalled();

    const r = getDb()
      .prepare('SELECT state FROM tracked_items WHERE id = ?')
      .get('item-fresh') as { state: string };
    expect(r.state).toBe('queued');
  });

  it('skips items with no account in metadata', async () => {
    const row = makeGmailItem('item-noacct', 'thread-noacct', OLD);
    row.metadata = null as unknown as Record<string, unknown>;
    insertTrackedItem(row);

    const gmailOps = {
      getThreadInboxStatus: vi.fn(),
    };

    const result = await reconcileOnce({
      db: getDb(),
      gmailOps,
      now: () => now,
    });

    expect(result.skipped).toBe(1);
    expect(result.checked).toBe(0);
    expect(gmailOps.getThreadInboxStatus).not.toHaveBeenCalled();
  });

  it('continues past transient errors on individual items', async () => {
    insertTrackedItem(makeGmailItem('item-err', 'thread-err', OLD));
    insertTrackedItem(makeGmailItem('item-ok', 'thread-ok', OLD));

    const gmailOps = {
      getThreadInboxStatus: vi.fn(async (_acct: string, tid: string) => {
        if (tid === 'thread-err') throw new Error('boom');
        return 'out' as const;
      }),
    };

    const result = await reconcileOnce({
      db: getDb(),
      gmailOps,
      now: () => now,
    });

    expect(result).toMatchObject({
      checked: 2,
      resolved: 1,
      errors: 1,
    });

    const err = getDb()
      .prepare('SELECT state FROM tracked_items WHERE id = ?')
      .get('item-err') as { state: string };
    expect(err.state).toBe('queued'); // stays queued on error, retries next tick

    const ok = getDb()
      .prepare('SELECT state FROM tracked_items WHERE id = ?')
      .get('item-ok') as { state: string };
    expect(ok.state).toBe('resolved');
  });

  it('ignores non-gmail items and already-resolved rows', async () => {
    insertTrackedItem({
      ...makeGmailItem('item-other', 'thread-o', OLD),
      source: 'slack' as TrackedItem['source'],
    });
    insertTrackedItem({
      ...makeGmailItem('item-done', 'thread-d', OLD),
      state: 'resolved',
      resolved_at: OLD,
      resolution_method: 'manual',
    });

    const gmailOps = {
      getThreadInboxStatus: vi.fn(),
    };

    const result = await reconcileOnce({
      db: getDb(),
      gmailOps,
      now: () => now,
    });

    expect(result.checked).toBe(0);
    expect(gmailOps.getThreadInboxStatus).not.toHaveBeenCalled();
  });
});
