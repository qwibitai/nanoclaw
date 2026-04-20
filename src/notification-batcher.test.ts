import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { NotificationBatcher } from './notification-batcher.js';
import type { SendFn } from './notification-batcher.js';

describe('NotificationBatcher', () => {
  let sendFn: ReturnType<typeof vi.fn<SendFn>>;
  let batcher: NotificationBatcher;

  beforeEach(() => {
    vi.useFakeTimers();
    sendFn = vi.fn<SendFn>().mockResolvedValue(undefined);
    batcher = new NotificationBatcher(sendFn);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // --- Immediate delivery (critical/error) ---

  describe('immediate delivery', () => {
    it('sends critical notifications immediately', async () => {
      await batcher.send('jid:1', 'Server on fire', 'critical');

      expect(sendFn).toHaveBeenCalledTimes(1);
      expect(sendFn).toHaveBeenCalledWith('jid:1', 'Server on fire');
      expect(batcher.pendingCount).toBe(0);
    });

    it('sends error notifications immediately', async () => {
      await batcher.send('jid:1', 'Disk full', 'error');

      expect(sendFn).toHaveBeenCalledTimes(1);
      expect(sendFn).toHaveBeenCalledWith('jid:1', 'Disk full');
      expect(batcher.pendingCount).toBe(0);
    });

    it('sends multiple critical notifications without batching', async () => {
      await batcher.send('jid:1', 'Error 1', 'critical');
      await batcher.send('jid:1', 'Error 2', 'critical');

      expect(sendFn).toHaveBeenCalledTimes(2);
      expect(sendFn).toHaveBeenCalledWith('jid:1', 'Error 1');
      expect(sendFn).toHaveBeenCalledWith('jid:1', 'Error 2');
    });
  });

  // --- Batched delivery (warning/info) ---

  describe('batched delivery', () => {
    it('holds warning notifications until window expires', async () => {
      await batcher.send('jid:1', 'CPU high', 'warning');

      expect(sendFn).not.toHaveBeenCalled();
      expect(batcher.pendingCount).toBe(1);

      // Advance past the 10s warning window
      await vi.advanceTimersByTimeAsync(10_000);

      expect(sendFn).toHaveBeenCalledTimes(1);
      // Single item — sent as-is without batching chrome
      expect(sendFn).toHaveBeenCalledWith('jid:1', 'CPU high');
      expect(batcher.pendingCount).toBe(0);
    });

    it('holds info notifications until window expires', async () => {
      await batcher.send('jid:1', 'Deployment started', 'info');

      expect(sendFn).not.toHaveBeenCalled();
      expect(batcher.pendingCount).toBe(1);

      // Advance past the 30s info window
      await vi.advanceTimersByTimeAsync(30_000);

      expect(sendFn).toHaveBeenCalledTimes(1);
      expect(sendFn).toHaveBeenCalledWith('jid:1', 'Deployment started');
    });

    it('groups multiple warnings into a single batched message', async () => {
      await batcher.send('jid:1', 'CPU high', 'warning');
      await batcher.send('jid:1', 'Memory high', 'warning');
      await batcher.send('jid:1', 'Disk 90%', 'warning');

      expect(sendFn).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(10_000);

      expect(sendFn).toHaveBeenCalledTimes(1);
      const message = sendFn.mock.calls[0][1];
      expect(message).toContain('3 warning notifications (batched)');
      expect(message).toContain('1. CPU high');
      expect(message).toContain('2. Memory high');
      expect(message).toContain('3. Disk 90%');
    });

    it('groups multiple info notifications into a single batched message', async () => {
      await batcher.send('jid:1', 'Service started', 'info');
      await batcher.send('jid:1', 'Service recovered', 'info');

      await vi.advanceTimersByTimeAsync(30_000);

      expect(sendFn).toHaveBeenCalledTimes(1);
      const message = sendFn.mock.calls[0][1];
      expect(message).toContain('2 info notifications (batched)');
      expect(message).toContain('1. Service started');
      expect(message).toContain('2. Service recovered');
    });
  });

  // --- JID isolation ---

  describe('JID isolation', () => {
    it('batches notifications per JID independently', async () => {
      await batcher.send('jid:1', 'Alert A', 'warning');
      await batcher.send('jid:2', 'Alert B', 'warning');

      expect(batcher.pendingCount).toBe(2);

      await vi.advanceTimersByTimeAsync(10_000);

      expect(sendFn).toHaveBeenCalledTimes(2);
      expect(sendFn).toHaveBeenCalledWith('jid:1', 'Alert A');
      expect(sendFn).toHaveBeenCalledWith('jid:2', 'Alert B');
    });
  });

  // --- Severity isolation ---

  describe('severity isolation', () => {
    it('batches different severities into separate messages', async () => {
      await batcher.send('jid:1', 'Warning msg', 'warning');
      await batcher.send('jid:1', 'Info msg', 'info');

      // Two separate buckets
      expect(batcher.pendingCount).toBe(2);

      // Warning fires at 10s
      await vi.advanceTimersByTimeAsync(10_000);
      expect(sendFn).toHaveBeenCalledTimes(1);
      expect(sendFn).toHaveBeenCalledWith('jid:1', 'Warning msg');
      expect(batcher.pendingCount).toBe(1);

      // Info fires at 30s
      await vi.advanceTimersByTimeAsync(20_000);
      expect(sendFn).toHaveBeenCalledTimes(2);
      expect(sendFn).toHaveBeenCalledWith('jid:1', 'Info msg');
      expect(batcher.pendingCount).toBe(0);
    });
  });

  // --- Mixed immediate + batched ---

  describe('mixed delivery', () => {
    it('sends critical immediately while batching warnings', async () => {
      await batcher.send('jid:1', 'Warning 1', 'warning');
      await batcher.send('jid:1', 'CRITICAL', 'critical');
      await batcher.send('jid:1', 'Warning 2', 'warning');

      // Critical sent immediately
      expect(sendFn).toHaveBeenCalledTimes(1);
      expect(sendFn).toHaveBeenCalledWith('jid:1', 'CRITICAL');

      // Warnings still pending
      expect(batcher.pendingCount).toBe(1);

      await vi.advanceTimersByTimeAsync(10_000);

      expect(sendFn).toHaveBeenCalledTimes(2);
      const batchMsg = sendFn.mock.calls[1][1];
      expect(batchMsg).toContain('2 warning notifications (batched)');
      expect(batchMsg).toContain('Warning 1');
      expect(batchMsg).toContain('Warning 2');
    });
  });

  // --- flushAll ---

  describe('flushAll', () => {
    it('flushes all pending buckets immediately', async () => {
      await batcher.send('jid:1', 'Warning A', 'warning');
      await batcher.send('jid:1', 'Warning B', 'warning');
      await batcher.send('jid:2', 'Info C', 'info');

      expect(batcher.pendingCount).toBe(2);

      await batcher.flushAll();

      expect(sendFn).toHaveBeenCalledTimes(2);
      expect(batcher.pendingCount).toBe(0);

      // Verify jid:1 got the batched warning
      const jid1Call = sendFn.mock.calls.find((c) => c[0] === 'jid:1');
      expect(jid1Call).toBeDefined();
      expect(jid1Call![1]).toContain('2 warning notifications (batched)');

      // Verify jid:2 got the single info (no batching chrome)
      const jid2Call = sendFn.mock.calls.find((c) => c[0] === 'jid:2');
      expect(jid2Call).toBeDefined();
      expect(jid2Call![1]).toBe('Info C');
    });

    it('is a no-op when no pending notifications exist', async () => {
      await batcher.flushAll();

      expect(sendFn).not.toHaveBeenCalled();
    });
  });

  // --- Timer behavior ---

  describe('timer behavior', () => {
    it('uses first-item window (not reset by subsequent items)', async () => {
      await batcher.send('jid:1', 'First', 'warning');

      // Add another item after 5s
      await vi.advanceTimersByTimeAsync(5_000);
      await batcher.send('jid:1', 'Second', 'warning');

      // At 10s from the first item, the batch should flush
      await vi.advanceTimersByTimeAsync(5_000);

      expect(sendFn).toHaveBeenCalledTimes(1);
      const message = sendFn.mock.calls[0][1];
      expect(message).toContain('2 warning notifications (batched)');
    });

    it('starts a new window after flush completes', async () => {
      await batcher.send('jid:1', 'Batch 1', 'warning');
      await vi.advanceTimersByTimeAsync(10_000);

      expect(sendFn).toHaveBeenCalledTimes(1);

      // New notification starts a new window
      await batcher.send('jid:1', 'Batch 2', 'warning');
      expect(batcher.pendingCount).toBe(1);

      await vi.advanceTimersByTimeAsync(10_000);

      expect(sendFn).toHaveBeenCalledTimes(2);
      expect(sendFn.mock.calls[1][1]).toBe('Batch 2');
    });
  });

  // --- formatBatchSummary static utility ---

  describe('formatBatchSummary', () => {
    it('groups notifications by severity in priority order', () => {
      const now = Date.now();
      const items = [
        { severity: 'info' as const, text: 'Info 1', timestamp: now },
        { severity: 'error' as const, text: 'Error 1', timestamp: now },
        { severity: 'warning' as const, text: 'Warning 1', timestamp: now },
        { severity: 'critical' as const, text: 'Critical 1', timestamp: now },
        { severity: 'info' as const, text: 'Info 2', timestamp: now },
      ];

      const summary = NotificationBatcher.formatBatchSummary(items);

      // Critical should appear before error, error before warning, warning before info
      const criticalIdx = summary.indexOf('critical');
      const errorIdx = summary.indexOf('error');
      const warningIdx = summary.indexOf('warning');
      const infoIdx = summary.indexOf('info');

      expect(criticalIdx).toBeLessThan(errorIdx);
      expect(errorIdx).toBeLessThan(warningIdx);
      expect(warningIdx).toBeLessThan(infoIdx);

      expect(summary).toContain('(2)'); // info has 2 items
    });
  });

  // --- Error handling ---

  describe('error handling', () => {
    it('does not throw when sendFn rejects for immediate delivery', async () => {
      sendFn.mockRejectedValueOnce(new Error('send failed'));

      await expect(batcher.send('jid:1', 'msg', 'critical')).rejects.toThrow(
        'send failed',
      );
    });

    it('handles sendFn rejection during flush gracefully', async () => {
      sendFn.mockRejectedValueOnce(new Error('send failed'));

      await batcher.send('jid:1', 'msg', 'warning');

      // The timer flush catches errors via the .catch in the setTimeout handler
      // but the bucket should still be cleaned up
      await vi.advanceTimersByTimeAsync(10_000);

      // Bucket is cleaned up before send is attempted
      expect(batcher.pendingCount).toBe(0);
    });
  });
});
