import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('./logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
  },
}));

import { _initTestDatabase, _closeDatabase } from './db.js';
import { logEvent, queryEvents, pruneOldEvents, startEventLog } from './event-log.js';
import { EventBus } from './event-bus.js';
import type { NanoClawEvent, MessageInboundEvent, TaskCompleteEvent } from './events.js';

describe('event-log', () => {
  beforeEach(() => {
    _initTestDatabase();
  });

  afterEach(() => {
    _closeDatabase();
  });

  it('logEvent records events and queryEvents retrieves them', () => {
    const now = Date.now();
    const event: NanoClawEvent = {
      type: 'message.inbound',
      source: 'channel',
      groupId: 'group-1',
      timestamp: now,
      payload: { chatJid: 'test@jid', channel: 'whatsapp', messageCount: 1 },
    };

    logEvent(event);

    const results = queryEvents({ since: now - 1000 });
    expect(results).toHaveLength(1);
    expect(results[0].event_type).toBe('message.inbound');
    expect(results[0].source).toBe('channel');
    expect(results[0].group_id).toBe('group-1');
    expect(results[0].payload).toEqual({ chatJid: 'test@jid', channel: 'whatsapp', messageCount: 1 });
    expect(results[0].timestamp).toBe(now);
    expect(results[0].id).toBeTypeOf('number');
  });

  it('queryEvents filters by time range', () => {
    const base = 1000000;
    logEvent({ type: 'a', source: 's', timestamp: base, payload: { n: 1 } });
    logEvent({ type: 'b', source: 's', timestamp: base + 1000, payload: { n: 2 } });
    logEvent({ type: 'c', source: 's', timestamp: base + 2000, payload: { n: 3 } });

    // Only the middle event
    const results = queryEvents({ since: base + 500, until: base + 1500 });
    expect(results).toHaveLength(1);
    expect(results[0].event_type).toBe('b');
  });

  it('queryEvents filters by type', () => {
    const now = Date.now();
    logEvent({ type: 'message.inbound', source: 'channel', timestamp: now, payload: {} });
    logEvent({ type: 'task.complete', source: 'executor', timestamp: now + 1, payload: {} });
    logEvent({ type: 'message.inbound', source: 'channel', timestamp: now + 2, payload: {} });

    const results = queryEvents({ since: now - 1000, type: 'task.complete' });
    expect(results).toHaveLength(1);
    expect(results[0].event_type).toBe('task.complete');
  });

  it('queryEvents filters by groupId', () => {
    const now = Date.now();
    logEvent({ type: 'a', source: 's', groupId: 'alpha', timestamp: now, payload: {} });
    logEvent({ type: 'b', source: 's', groupId: 'beta', timestamp: now + 1, payload: {} });
    logEvent({ type: 'c', source: 's', groupId: 'alpha', timestamp: now + 2, payload: {} });

    const results = queryEvents({ since: now - 1000, groupId: 'alpha' });
    expect(results).toHaveLength(2);
    expect(results.every((r) => r.group_id === 'alpha')).toBe(true);
  });

  it('queryEvents respects limit and orders by timestamp DESC', () => {
    const now = Date.now();
    for (let i = 0; i < 5; i++) {
      logEvent({ type: 'x', source: 's', timestamp: now + i, payload: { i } });
    }

    const results = queryEvents({ since: now - 1000, limit: 3 });
    expect(results).toHaveLength(3);
    // DESC order: newest first
    expect(results[0].timestamp).toBeGreaterThan(results[1].timestamp);
    expect(results[1].timestamp).toBeGreaterThan(results[2].timestamp);
  });

  it('pruneOldEvents removes old events and returns count', () => {
    const now = Date.now();
    const oldTime = now - 60 * 24 * 60 * 60 * 1000; // 60 days ago
    const recentTime = now - 1000; // 1 second ago

    logEvent({ type: 'old', source: 's', timestamp: oldTime, payload: {} });
    logEvent({ type: 'old2', source: 's', timestamp: oldTime + 1, payload: {} });
    logEvent({ type: 'recent', source: 's', timestamp: recentTime, payload: {} });

    // Prune with 30-day retention
    const deleted = pruneOldEvents(30 * 24 * 60 * 60 * 1000);
    expect(deleted).toBe(2);

    const remaining = queryEvents({ since: 0 });
    expect(remaining).toHaveLength(1);
    expect(remaining[0].event_type).toBe('recent');
  });

  it('startEventLog subscribes to all events and records them', () => {
    const bus = new EventBus();
    const unsub = startEventLog(bus);

    const event: MessageInboundEvent = {
      type: 'message.inbound',
      source: 'channel',
      groupId: 'test-group',
      timestamp: Date.now(),
      payload: { chatJid: 'jid@test', channel: 'whatsapp', messageCount: 2 },
    };

    bus.emit('message.inbound', event);

    const results = queryEvents({ since: event.timestamp - 1000 });
    expect(results).toHaveLength(1);
    expect(results[0].event_type).toBe('message.inbound');
    expect(results[0].group_id).toBe('test-group');

    unsub();

    // After unsub, no more recording
    bus.emit('message.inbound', { ...event, timestamp: Date.now() + 1000 });
    const results2 = queryEvents({ since: 0 });
    expect(results2).toHaveLength(1);
  });

  it('logEvent handles events without groupId', () => {
    const now = Date.now();
    logEvent({ type: 'system.startup', source: 'orchestrator', timestamp: now, payload: { channels: [] } });

    const results = queryEvents({ since: now - 1000 });
    expect(results).toHaveLength(1);
    expect(results[0].group_id).toBeNull();
  });
});
