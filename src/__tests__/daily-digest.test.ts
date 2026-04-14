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
}));

import { _initTestDatabase, _closeDatabase } from '../db.js';
import { logEvent } from '../event-log.js';
import { generateDigest, runDailyDigest } from '../daily-digest.js';

describe('daily-digest', () => {
  beforeEach(() => {
    _initTestDatabase();
  });

  afterEach(() => {
    _closeDatabase();
  });

  it('generates a quiet digest when no events exist', () => {
    const result = generateDigest('main@jid');
    expect(result).toContain('Daily Digest');
    expect(result).toContain('Quiet night');
  });

  it('includes event type counts', () => {
    const now = Date.now();
    logEvent({
      type: 'message.inbound',
      source: 'channel',
      timestamp: now - 1000,
      payload: {},
    });
    logEvent({
      type: 'message.inbound',
      source: 'channel',
      timestamp: now - 2000,
      payload: {},
    });
    logEvent({
      type: 'task.complete',
      source: 'executor',
      timestamp: now - 3000,
      payload: {},
    });

    const result = generateDigest('main@jid', now);
    expect(result).toContain('Daily Digest');
    expect(result).toContain('Messages received: 2');
    expect(result).toContain('Tasks completed: 1');
  });

  it('highlights errors', () => {
    const now = Date.now();
    logEvent({
      type: 'system.error',
      source: 'event-bus',
      timestamp: now - 1000,
      payload: { error: 'test', handler: 'h', originalEvent: 'e' },
    });

    const result = generateDigest('main@jid', now);
    expect(result).toContain('1 error(s)');
  });

  it('includes email counts', () => {
    const now = Date.now();
    logEvent({
      type: 'email.received',
      source: 'email-sse',
      timestamp: now - 1000,
      payload: { count: 5, emails: [], connection: 'default' },
    });
    logEvent({
      type: 'email.received',
      source: 'email-sse',
      timestamp: now - 2000,
      payload: { count: 3, emails: [], connection: 'default' },
    });

    const result = generateDigest('main@jid', now);
    expect(result).toContain('8 email(s)');
    expect(result).toContain('2 batch(es)');
  });

  it('runDailyDigest skips when no main group', async () => {
    const sendMessage = vi.fn();
    await runDailyDigest({
      sendMessage,
      getMainGroupJid: () => undefined,
    });
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('runDailyDigest sends digest to main group', async () => {
    const sendMessage = vi.fn().mockResolvedValue(undefined);
    await runDailyDigest({
      sendMessage,
      getMainGroupJid: () => 'main@jid',
    });
    expect(sendMessage).toHaveBeenCalledOnce();
    expect(sendMessage.mock.calls[0][0]).toBe('main@jid');
    expect(sendMessage.mock.calls[0][1]).toContain('Daily Digest');
  });
});
