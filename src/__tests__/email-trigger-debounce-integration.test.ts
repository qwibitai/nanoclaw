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
    // Simulate the actual wire scenario: 3 emails, 45s apart each
    debouncer.add(
      [
        {
          thread_id: '19d9759c',
          account: 'personal',
          subject: 'Wire sent ····7958',
          sender: 'chase@chase.com',
        },
      ],
      'conn1',
    );
    expect(debouncer.has('19d9759c')).toBe(true);

    vi.advanceTimersByTime(45_000);
    debouncer.add(
      [
        {
          thread_id: '19d975a8',
          account: 'personal',
          subject: 'Wire sent ····1269',
          sender: 'chase@chase.com',
        },
      ],
      'conn1',
    );
    expect(debouncer.has('19d975a8')).toBe(true);

    vi.advanceTimersByTime(45_000);
    debouncer.add(
      [
        {
          thread_id: '19d975bf',
          account: 'personal',
          subject: 'Wire sent ····7958',
          sender: 'chase@chase.com',
        },
      ],
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
    debouncer.add([{ thread_id: 'wire1', account: 'personal' }], 'conn1');

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
    debouncer.add([{ thread_id: 't1', account: 'personal' }], 'conn1');
    debouncer.add([{ thread_id: 't2', account: 'personal' }], 'conn1');

    // Simulate shutdown
    debouncer.flush();
    expect(flushed).toHaveLength(1);
    expect(flushed[0].emails).toHaveLength(2);
  });
});
