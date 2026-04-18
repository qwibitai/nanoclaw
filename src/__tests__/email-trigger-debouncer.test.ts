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
      expect(flushed[0].emails.map((e) => e.thread_id)).toEqual([
        't1',
        't2',
        't3',
      ]);
    });

    it('should deduplicate by thread_id within buffer', () => {
      debouncer.add(
        [{ thread_id: 't1', account: 'personal', subject: 'first' }],
        'conn1',
      );
      debouncer.add(
        [{ thread_id: 't1', account: 'personal', subject: 'resend' }],
        'conn1',
      );

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
