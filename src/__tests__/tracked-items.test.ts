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

import { _initTestDatabase, _closeDatabase } from '../db.js';
import {
  validateTransition,
  insertTrackedItem,
  transitionItemState,
  getTrackedItemsByState,
  getTrackedItemBySourceId,
  incrementDigestCount,
  upsertThread,
  getActiveThreads,
  getDigestState,
  updateDigestState,
  detectResolution,
  parseCallbackData,
  resolveItemByCallback,
  getTrackedItemById,
  type TrackedItem,
  type Thread,
  type ResolutionSignal,
} from '../tracked-items.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeItem(overrides: Partial<TrackedItem> = {}): TrackedItem {
  return {
    id: 'item-1',
    source: 'gmail',
    source_id: 'gmail-abc123',
    group_name: 'main',
    state: 'detected',
    classification: null,
    superpilot_label: null,
    trust_tier: null,
    title: 'Test item',
    summary: null,
    thread_id: null,
    detected_at: 1000000,
    pushed_at: null,
    resolved_at: null,
    resolution_method: null,
    digest_count: 0,
    telegram_message_id: null,
    classification_reason: null,
    metadata: null,
    ...overrides,
  };
}

function makeThread(overrides: Partial<Thread> = {}): Thread {
  return {
    id: 'thread-1',
    group_name: 'main',
    title: 'Thread One',
    source_hint: null,
    created_at: 2000000,
    resolved_at: null,
    item_count: 1,
    state: 'active',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// validateTransition
// ---------------------------------------------------------------------------

describe('validateTransition', () => {
  it('allows detected → pushed', () => {
    expect(() => validateTransition('detected', 'pushed')).not.toThrow();
  });

  it('allows detected → queued', () => {
    expect(() => validateTransition('detected', 'queued')).not.toThrow();
  });

  it('allows detected → resolved', () => {
    expect(() => validateTransition('detected', 'resolved')).not.toThrow();
  });

  it('allows pending → resolved', () => {
    expect(() => validateTransition('pending', 'resolved')).not.toThrow();
  });

  it('allows pending → held', () => {
    expect(() => validateTransition('pending', 'held')).not.toThrow();
  });

  it('allows held → pending', () => {
    expect(() => validateTransition('held', 'pending')).not.toThrow();
  });

  it('rejects resolved → pushed', () => {
    expect(() => validateTransition('resolved', 'pushed')).toThrow(
      'Invalid state transition',
    );
  });

  it('rejects stale → pending', () => {
    expect(() => validateTransition('stale', 'pending')).toThrow(
      'Invalid state transition',
    );
  });

  it('rejects pushed → queued', () => {
    expect(() => validateTransition('pushed', 'queued')).toThrow(
      'Invalid state transition',
    );
  });
});

// ---------------------------------------------------------------------------
// tracked_items DB operations
// ---------------------------------------------------------------------------

describe('tracked_items DB operations', () => {
  beforeEach(() => _initTestDatabase());
  afterEach(() => _closeDatabase());

  it('inserts and retrieves item by state', () => {
    insertTrackedItem(makeItem());
    const items = getTrackedItemsByState('main', ['detected']);
    expect(items).toHaveLength(1);
    expect(items[0].id).toBe('item-1');
    expect(items[0].title).toBe('Test item');
  });

  it('serializes and deserializes classification_reason', () => {
    const reason = {
      superpilot: 'high-priority',
      trust: 'tier-1',
      final: 'push' as const,
    };
    insertTrackedItem(makeItem({ classification_reason: reason }));
    const items = getTrackedItemsByState('main', ['detected']);
    expect(items[0].classification_reason).toEqual(reason);
  });

  it('serializes and deserializes metadata', () => {
    const meta = { threadId: 'abc', labels: ['inbox', 'important'] };
    insertTrackedItem(makeItem({ metadata: meta }));
    const items = getTrackedItemsByState('main', ['detected']);
    expect(items[0].metadata).toEqual(meta);
  });

  it('transitions item state with validation', () => {
    insertTrackedItem(makeItem());
    transitionItemState('item-1', 'detected', 'pushed', {
      pushed_at: 1000001,
    });
    const items = getTrackedItemsByState('main', ['pushed']);
    expect(items).toHaveLength(1);
    expect(items[0].pushed_at).toBe(1000001);
  });

  it('rejects invalid state transition', () => {
    insertTrackedItem(makeItem());
    expect(() => transitionItemState('item-1', 'detected', 'digested')).toThrow(
      'Invalid state transition',
    );
  });

  it('throws when item is not in expected from-state', () => {
    insertTrackedItem(makeItem());
    // Item is in 'detected', not 'pushed' — validateTransition passes
    // (pushed→pending is valid) but DB finds no row in state 'pushed'
    expect(() => transitionItemState('item-1', 'pushed', 'pending')).toThrow(
      'State transition failed',
    );
  });

  it('throws when item id does not exist in from-state', () => {
    insertTrackedItem(makeItem({ state: 'queued' }));
    expect(() => transitionItemState('item-1', 'detected', 'pushed')).toThrow();
  });

  it('finds item by source and source_id', () => {
    insertTrackedItem(makeItem());
    const item = getTrackedItemBySourceId('gmail', 'gmail-abc123');
    expect(item).not.toBeNull();
    expect(item!.id).toBe('item-1');
  });

  it('returns null when source_id not found', () => {
    const item = getTrackedItemBySourceId('gmail', 'nonexistent');
    expect(item).toBeNull();
  });

  it('increments digest_count for given ids', () => {
    insertTrackedItem(makeItem());
    insertTrackedItem(makeItem({ id: 'item-2', source_id: 'gmail-xyz' }));
    incrementDigestCount(['item-1', 'item-2']);
    const items = getTrackedItemsByState('main', ['detected']);
    expect(items.map((i) => i.digest_count)).toEqual([1, 1]);
  });

  it('ignores duplicate inserts (INSERT OR IGNORE)', () => {
    insertTrackedItem(makeItem());
    insertTrackedItem(makeItem({ title: 'Different title' })); // same id
    const items = getTrackedItemsByState('main', ['detected']);
    expect(items).toHaveLength(1);
    expect(items[0].title).toBe('Test item'); // original preserved
  });

  it('returns empty array when no items in state', () => {
    const items = getTrackedItemsByState('main', ['pushed']);
    expect(items).toEqual([]);
  });

  it('returns items for specific group only', () => {
    insertTrackedItem(makeItem({ group_name: 'main' }));
    insertTrackedItem(
      makeItem({ id: 'item-2', source_id: 'id-2', group_name: 'other' }),
    );
    const items = getTrackedItemsByState('main', ['detected']);
    expect(items).toHaveLength(1);
    expect(items[0].group_name).toBe('main');
  });
});

// ---------------------------------------------------------------------------
// threads DB operations
// ---------------------------------------------------------------------------

describe('threads DB operations', () => {
  beforeEach(() => _initTestDatabase());
  afterEach(() => _closeDatabase());

  it('upserts and retrieves active thread', () => {
    upsertThread(makeThread());
    const threads = getActiveThreads('main');
    expect(threads).toHaveLength(1);
    expect(threads[0].id).toBe('thread-1');
    expect(threads[0].title).toBe('Thread One');
  });

  it('updates on conflict', () => {
    upsertThread(makeThread());
    upsertThread(makeThread({ title: 'Updated Title', item_count: 5 }));
    const threads = getActiveThreads('main');
    expect(threads).toHaveLength(1);
    expect(threads[0].title).toBe('Updated Title');
    expect(threads[0].item_count).toBe(5);
  });

  it('does not return resolved threads', () => {
    upsertThread(makeThread({ state: 'resolved', resolved_at: 9999 }));
    const threads = getActiveThreads('main');
    expect(threads).toHaveLength(0);
  });

  it('returns threads for specific group only', () => {
    upsertThread(makeThread({ group_name: 'main' }));
    upsertThread(makeThread({ id: 'thread-2', group_name: 'other' }));
    const threads = getActiveThreads('main');
    expect(threads).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// digest_state DB operations
// ---------------------------------------------------------------------------

describe('digest_state DB operations', () => {
  beforeEach(() => _initTestDatabase());
  afterEach(() => _closeDatabase());

  it('returns defaults when no state exists', () => {
    const state = getDigestState('main');
    expect(state.group_name).toBe('main');
    expect(state.last_digest_at).toBeNull();
    expect(state.last_dashboard_at).toBeNull();
    expect(state.queued_count).toBe(0);
    expect(state.last_user_interaction).toBeNull();
  });

  it('updates and retrieves digest state', () => {
    updateDigestState('main', { last_digest_at: 5000000, queued_count: 3 });
    const state = getDigestState('main');
    expect(state.last_digest_at).toBe(5000000);
    expect(state.queued_count).toBe(3);
  });

  it('updates queued_count independently', () => {
    updateDigestState('main', { last_digest_at: 1000 });
    updateDigestState('main', { queued_count: 7 });
    const state = getDigestState('main');
    expect(state.queued_count).toBe(7);
    expect(state.last_digest_at).toBe(1000);
  });

  it('preserves last_user_interaction across multiple updates', () => {
    updateDigestState('main', { last_user_interaction: 9999 });
    updateDigestState('main', { queued_count: 2 });
    const state = getDigestState('main');
    expect(state.last_user_interaction).toBe(9999);
  });
});

// ---------------------------------------------------------------------------
// detectResolution
// ---------------------------------------------------------------------------

describe('detectResolution', () => {
  it('detects gmail reply (from:me in thread)', () => {
    const signal: ResolutionSignal = {
      source: 'gmail',
      userReplied: true,
      inInbox: true,
    };
    expect(detectResolution(signal)).toEqual({
      resolved: true,
      method: 'auto:gmail_reply',
      confidence: 'high',
    });
  });

  it('detects archived email', () => {
    const signal: ResolutionSignal = {
      source: 'gmail',
      userReplied: false,
      inInbox: false,
    };
    expect(detectResolution(signal)).toEqual({
      resolved: true,
      method: 'auto:archived',
      confidence: 'high',
    });
  });

  it('detects calendar RSVP', () => {
    const signal: ResolutionSignal = { source: 'calendar', rsvpChanged: true };
    expect(detectResolution(signal)).toEqual({
      resolved: true,
      method: 'auto:rsvp',
      confidence: 'high',
    });
  });

  it('detects Discord thread resolved', () => {
    const signal: ResolutionSignal = {
      source: 'discord',
      threadResolved: true,
    };
    expect(detectResolution(signal)).toEqual({
      resolved: true,
      method: 'auto:discord_resolved',
      confidence: 'medium',
    });
  });

  it('returns not resolved when no signal', () => {
    const signal: ResolutionSignal = {
      source: 'gmail',
      userReplied: false,
      inInbox: true,
    };
    expect(detectResolution(signal)).toEqual({ resolved: false });
  });
});

// ---------------------------------------------------------------------------
// callback handling
// ---------------------------------------------------------------------------

describe('callback handling', () => {
  beforeEach(() => _initTestDatabase());
  afterEach(() => _closeDatabase());

  const cbSampleItem = {
    id: 'email:thread_abc',
    source: 'gmail',
    source_id: 'thread_abc',
    group_name: 'main',
    state: 'detected' as const,
    classification: null,
    superpilot_label: 'needs-attention',
    trust_tier: 'escalate',
    title: 'Budget approval from Sarah',
    summary: 'Need sign-off by EOD Wednesday',
    thread_id: 'thread_abc',
    detected_at: Date.now(),
    pushed_at: null,
    resolved_at: null,
    resolution_method: null,
    digest_count: 0,
    telegram_message_id: null,
    classification_reason: {
      superpilot: 'needs-attention',
      trust: 'escalate',
      final: 'push' as const,
    },
    metadata: { sender: 'sarah@example.com' },
  };

  it('parses callback data correctly', () => {
    expect(parseCallbackData('approve:email:t1')).toEqual({
      action: 'approve',
      itemId: 'email:t1',
    });
    expect(parseCallbackData('dismiss:cal:e1')).toEqual({
      action: 'dismiss',
      itemId: 'cal:e1',
    });
    expect(parseCallbackData('snooze:email:t1')).toEqual({
      action: 'snooze',
      itemId: 'email:t1',
    });
    expect(parseCallbackData('handle:email:t1')).toEqual({
      action: 'handle',
      itemId: 'email:t1',
    });
    expect(parseCallbackData('invalid')).toBeNull();
  });

  it('resolves item on approve', () => {
    insertTrackedItem({
      ...cbSampleItem,
      id: 'cb:t1',
      state: 'pending',
    });
    resolveItemByCallback('cb:t1', 'approve');
    const item = getTrackedItemById('cb:t1');
    expect(item?.state).toBe('resolved');
    expect(item?.resolution_method).toBe('manual:button');
  });

  it('resolves item on dismiss', () => {
    insertTrackedItem({
      ...cbSampleItem,
      id: 'cb:t2',
      state: 'pending',
    });
    resolveItemByCallback('cb:t2', 'dismiss');
    const item = getTrackedItemById('cb:t2');
    expect(item?.state).toBe('resolved');
  });
});
