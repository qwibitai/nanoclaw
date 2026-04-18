import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { _initTestDatabase, _closeDatabase } from '../db.js';
import { recordBehavior } from '../classification-adjustments.js';

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
  CHAT_INTERFACE_CONFIG: {
    urgencyKeywords: ['urgent', 'deadline', 'asap', 'blocking'],
    vipList: ['ceo@company.com'],
    quietHours: {
      enabled: false,
      start: '22:00',
      end: '07:00',
      weekendMode: false,
      escalateOverride: true,
    },
    holdPushDuringMeetings: false,
  },
}));

import { classify, type ClassificationInput } from '../classification.js';

describe('classify', () => {
  const baseInput: ClassificationInput = {
    source: 'gmail',
    sourceId: 'thread_1',
    superpilotLabel: null,
    trustTier: null,
    senderPattern: 'user@example.com',
    title: 'Hello',
    summary: 'A message',
    userActed: false,
    metadata: {},
  };

  it('returns resolved when user already acted', () => {
    const result = classify({ ...baseInput, userActed: true });
    expect(result.decision).toBe('resolved');
  });

  it('pushes needs-attention + escalate items', () => {
    const result = classify({
      ...baseInput,
      superpilotLabel: 'needs-attention',
      trustTier: 'escalate',
    });
    expect(result.decision).toBe('push');
  });

  it('pushes needs-attention + propose items', () => {
    const result = classify({
      ...baseInput,
      superpilotLabel: 'needs-attention',
      trustTier: 'propose',
    });
    expect(result.decision).toBe('push');
  });

  it('pushes needs-attention + auto items (trust override)', () => {
    const result = classify({
      ...baseInput,
      superpilotLabel: 'needs-attention',
      trustTier: 'auto',
    });
    expect(result.decision).toBe('push');
  });

  it('digests FYI items', () => {
    const result = classify({ ...baseInput, superpilotLabel: 'fyi' });
    expect(result.decision).toBe('digest');
  });

  it('digests newsletter items', () => {
    const result = classify({ ...baseInput, superpilotLabel: 'newsletter' });
    expect(result.decision).toBe('digest');
  });

  it('pushes urgent keyword in title', () => {
    const result = classify({
      ...baseInput,
      title: 'URGENT: server down',
      senderPattern: 'known@company.com',
    });
    expect(result.decision).toBe('push');
  });

  it('pushes VIP Discord mentions', () => {
    const result = classify({
      ...baseInput,
      source: 'discord',
      senderPattern: 'ceo@company.com',
      metadata: { isMention: true },
    });
    expect(result.decision).toBe('push');
  });

  it('digests non-VIP Discord messages', () => {
    const result = classify({
      ...baseInput,
      source: 'discord',
      senderPattern: 'random@user.com',
    });
    expect(result.decision).toBe('digest');
  });

  it('pushes calendar conflicts within 30 min', () => {
    const result = classify({
      ...baseInput,
      source: 'calendar',
      metadata: { conflictInMinutes: 15 },
    });
    expect(result.decision).toBe('push');
  });

  it('digests calendar conflicts over 30 min away', () => {
    const result = classify({
      ...baseInput,
      source: 'calendar',
      metadata: { conflictInMinutes: 60 },
    });
    expect(result.decision).toBe('digest');
  });

  it('includes full classification reason chain (QUAL-4)', () => {
    const result = classify({
      ...baseInput,
      superpilotLabel: 'needs-attention',
      trustTier: 'escalate',
    });
    expect(result.reason).toHaveProperty('superpilot', 'needs-attention');
    expect(result.reason).toHaveProperty('trust', 'escalate');
    expect(result.reason).toHaveProperty('final', 'push');
  });
});

describe('classify with learning adjustments', () => {
  const baseInput: ClassificationInput = {
    source: 'gmail',
    sourceId: 'thread_1',
    superpilotLabel: null,
    trustTier: null,
    senderPattern: 'user@example.com',
    title: 'Hello',
    summary: 'A message',
    userActed: false,
    metadata: {},
  };

  beforeEach(() => _initTestDatabase());
  afterEach(() => _closeDatabase());

  it('demotes a push item to digest when learning says demote', () => {
    for (let i = 0; i < 3; i++) {
      recordBehavior('gmail', 'spammy@co.com', 'push', 'dismiss');
    }

    const result = classify({
      ...baseInput,
      senderPattern: 'spammy@co.com',
      superpilotLabel: 'needs-attention',
      trustTier: 'propose',
    });
    expect(result.decision).toBe('digest');
    expect(result.reason.learning).toBe('demote');
  });

  it('promotes a digest item to push when learning says promote', () => {
    for (let i = 0; i < 3; i++) {
      recordBehavior('gmail', 'important@co.com', 'digest', 'immediate_action');
    }

    const result = classify({
      ...baseInput,
      senderPattern: 'important@co.com',
      superpilotLabel: 'fyi',
    });
    expect(result.decision).toBe('push');
    expect(result.reason.learning).toBe('promote');
  });
});
