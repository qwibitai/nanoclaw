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
  CHAT_INTERFACE_CONFIG: {
    urgencyKeywords: ['urgent', 'deadline', 'asap', 'blocking'],
    vipList: [],
    digestThreshold: 5,
    digestMinIntervalMs: 7200000,
    staleAfterDigestCycles: 2,
    pushRateLimit: 3,
    pushRateWindowMs: 1800000,
    holdPushDuringMeetings: false,
    quietHours: {
      enabled: false,
      start: '22:00',
      end: '07:00',
      weekendMode: false,
      escalateOverride: true,
    },
    morningDashboardTime: '07:30',
    microBriefingDelayMs: 60000,
  },
}));
vi.mock('../event-bus.js', () => ({
  eventBus: { emit: vi.fn(), on: vi.fn() },
}));

import { _initTestDatabase, _closeDatabase } from '../db.js';
import { classifyFromSSE, type SSEEmail } from '../sse-classifier.js';
import { getTrackedItemBySourceId } from '../tracked-items.js';
import { eventBus } from '../event-bus.js';

describe('classifyFromSSE', () => {
  beforeEach(() => _initTestDatabase());
  afterEach(() => _closeDatabase());

  it('classifies a needs-attention email as push', () => {
    const emails: SSEEmail[] = [
      {
        thread_id: 'thread1',
        account: 'dev@test.com',
        subject: 'Budget approval needed',
        sender: 'cfo@company.com',
        superpilot_label: 'needs-attention',
      },
    ];
    const results = classifyFromSSE(emails);
    expect(results).toHaveLength(1);
    expect(results[0].decision).toBe('push');
    expect(results[0].itemId).toBeTruthy();
  });

  it('classifies a newsletter email as digest', () => {
    const emails: SSEEmail[] = [
      {
        thread_id: 'thread2',
        account: 'dev@test.com',
        subject: 'Weekly roundup',
        sender: 'news@service.com',
        superpilot_label: 'newsletter',
      },
    ];
    const results = classifyFromSSE(emails);
    expect(results).toHaveLength(1);
    expect(results[0].decision).toBe('digest');
  });

  it('skips already-tracked emails', () => {
    const emails: SSEEmail[] = [
      {
        thread_id: 'thread3',
        account: 'dev@test.com',
        subject: 'First time',
        sender: 'a@b.com',
      },
    ];
    classifyFromSSE(emails);
    const results = classifyFromSSE(emails);
    expect(results).toHaveLength(0);
  });

  it('inserts tracked item into database', () => {
    const emails: SSEEmail[] = [
      {
        thread_id: 'thread4',
        account: 'dev@test.com',
        subject: 'Important thing',
        sender: 'boss@company.com',
        superpilot_label: 'needs-attention',
      },
    ];
    classifyFromSSE(emails);
    const item = getTrackedItemBySourceId('gmail', 'gmail:thread4');
    expect(item).not.toBeNull();
    expect(item!.title).toBe('Important thing');
    expect(item!.classification).toBe('push');
  });

  it('emits item.classified event for each email', () => {
    const emails: SSEEmail[] = [
      {
        thread_id: 'thread5',
        account: 'dev@test.com',
        subject: 'Test',
        sender: 'x@y.com',
      },
    ];
    classifyFromSSE(emails);
    expect(eventBus.emit).toHaveBeenCalledWith(
      'item.classified',
      expect.objectContaining({
        type: 'item.classified',
        source: 'sse-classifier',
      }),
    );
  });

  it('skips triage worker when TRIAGE_V1_ENABLED is falsy', async () => {
    delete process.env.TRIAGE_V1_ENABLED;
    const emails: SSEEmail[] = [
      {
        thread_id: 't1-flag-off',
        account: 'a@b.com',
        subject: 's',
        sender: 'x@y.com',
      },
    ];
    const res = classifyFromSSE(emails);
    expect(res).toHaveLength(1);
    const item = getTrackedItemBySourceId('gmail', 'gmail:t1-flag-off');
    expect(item?.confidence).toBeFalsy();
  });

  it('sets state to queued for digest items', () => {
    const emails: SSEEmail[] = [
      {
        thread_id: 'thread6',
        account: 'dev@test.com',
        subject: 'FYI stuff',
        sender: 'info@news.com',
        superpilot_label: 'fyi',
      },
    ];
    classifyFromSSE(emails);
    const item = getTrackedItemBySourceId('gmail', 'gmail:thread6');
    expect(item).not.toBeNull();
    expect(item!.state).toBe('queued');
    expect(item!.classification).toBe('digest');
  });
});

describe('classifyFromSSE with TRIAGE_V1_ENABLED=1', () => {
  beforeEach(() => {
    process.env.TRIAGE_V1_ENABLED = '1';
    vi.resetModules();
  });
  afterEach(() => {
    delete process.env.TRIAGE_V1_ENABLED;
    vi.resetModules();
  });

  it('invokes triage worker when flag is on', async () => {
    // Re-mock the shared modules for the reset module graph.
    vi.doMock('../logger.js', () => ({
      logger: {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        fatal: vi.fn(),
      },
    }));
    vi.doMock('../config.js', () => ({
      CHAT_INTERFACE_CONFIG: {
        urgencyKeywords: ['urgent', 'deadline', 'asap', 'blocking'],
        vipList: [],
        digestThreshold: 5,
        digestMinIntervalMs: 7200000,
        staleAfterDigestCycles: 2,
        pushRateLimit: 3,
        pushRateWindowMs: 1800000,
        holdPushDuringMeetings: false,
        quietHours: {
          enabled: false,
          start: '22:00',
          end: '07:00',
          weekendMode: false,
          escalateOverride: true,
        },
        morningDashboardTime: '07:30',
        microBriefingDelayMs: 60000,
      },
    }));
    vi.doMock('../event-bus.js', () => ({
      eventBus: { emit: vi.fn(), on: vi.fn() },
    }));
    // Init DB on the freshly reset db module so sse-classifier sees it.
    const db = await import('../db.js');
    db._initTestDatabase();

    const worker = await import('../triage/worker.js');
    const spy = vi
      .spyOn(worker, 'triageEmail')
      .mockResolvedValue({ outcome: 'skipped', reason: 'test' });

    const mod = await import('../sse-classifier.js');
    const emails: SSEEmail[] = [
      {
        thread_id: 't2-flag-on',
        account: 'a@b.com',
        subject: 'urgent fix',
        sender: 'x@y.com',
      },
    ];
    mod.classifyFromSSE(emails);

    await new Promise((r) => setImmediate(r));
    expect(spy).toHaveBeenCalled();
    db._closeDatabase();
  });
});
