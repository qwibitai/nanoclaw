import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import { DownloadTracker } from './download-tracker.js';

/**
 * INVARIANT: DownloadTracker accurately reflects pending download state
 * and waitForCompletion resolves only when all downloads for a chat complete.
 * SUT: DownloadTracker
 * VERIFICATION: Unit tests covering tracking, waiting, timeout, and race conditions.
 */

describe('DownloadTracker', () => {
  let tracker: DownloadTracker;

  beforeEach(() => {
    vi.useFakeTimers();
    tracker = new DownloadTracker();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('hasPending returns false when no downloads tracked', () => {
    expect(tracker.hasPending('chat1')).toBe(false);
  });

  it('hasPending returns true after start, false after complete', () => {
    tracker.start('chat1', 'dl-1');
    expect(tracker.hasPending('chat1')).toBe(true);

    tracker.complete('chat1', 'dl-1');
    expect(tracker.hasPending('chat1')).toBe(false);
  });

  it('tracks multiple concurrent downloads for same chat', () => {
    tracker.start('chat1', 'dl-1');
    tracker.start('chat1', 'dl-2');
    expect(tracker.hasPending('chat1')).toBe(true);

    tracker.complete('chat1', 'dl-1');
    expect(tracker.hasPending('chat1')).toBe(true);

    tracker.complete('chat1', 'dl-2');
    expect(tracker.hasPending('chat1')).toBe(false);
  });

  it('tracks downloads independently across chats', () => {
    tracker.start('chat1', 'dl-1');
    tracker.start('chat2', 'dl-2');

    tracker.complete('chat1', 'dl-1');
    expect(tracker.hasPending('chat1')).toBe(false);
    expect(tracker.hasPending('chat2')).toBe(true);

    tracker.complete('chat2', 'dl-2');
    expect(tracker.hasPending('chat2')).toBe(false);
  });

  it('complete is safe to call for unknown chat or download', () => {
    expect(() => tracker.complete('unknown', 'dl-1')).not.toThrow();
    tracker.start('chat1', 'dl-1');
    expect(() => tracker.complete('chat1', 'dl-nonexistent')).not.toThrow();
    // dl-1 should still be pending
    expect(tracker.hasPending('chat1')).toBe(true);
  });

  it('waitForCompletion resolves immediately when no pending downloads', async () => {
    await tracker.waitForCompletion('chat1', 5000);
    // No error means it resolved
  });

  it('waitForCompletion resolves when all downloads complete', async () => {
    tracker.start('chat1', 'dl-1');
    tracker.start('chat1', 'dl-2');

    const promise = tracker.waitForCompletion('chat1', 10000);
    let resolved = false;
    promise.then(() => {
      resolved = true;
    });

    // Complete first download — should not resolve yet
    tracker.complete('chat1', 'dl-1');
    await vi.advanceTimersByTimeAsync(0);
    expect(resolved).toBe(false);

    // Complete second download — should resolve
    tracker.complete('chat1', 'dl-2');
    await vi.advanceTimersByTimeAsync(0);
    expect(resolved).toBe(true);
  });

  it('waitForCompletion rejects on timeout', async () => {
    tracker.start('chat1', 'dl-1');

    const promise = tracker.waitForCompletion('chat1', 5000);
    // Attach rejection handler before advancing timers to avoid unhandled rejection
    const rejection = expect(promise).rejects.toThrow(
      'Download wait timed out',
    );
    await vi.advanceTimersByTimeAsync(5000);
    await rejection;
  });

  it('waitForCompletion ignores completions from other chats', async () => {
    tracker.start('chat1', 'dl-1');
    tracker.start('chat2', 'dl-2');

    const promise = tracker.waitForCompletion('chat1', 10000);
    let resolved = false;
    promise.then(() => {
      resolved = true;
    });

    // Complete chat2 — should not resolve chat1's wait
    tracker.complete('chat2', 'dl-2');
    await vi.advanceTimersByTimeAsync(0);
    expect(resolved).toBe(false);

    // Complete chat1 — should resolve
    tracker.complete('chat1', 'dl-1');
    await vi.advanceTimersByTimeAsync(0);
    expect(resolved).toBe(true);
  });

  it('handles race: complete between hasPending and listener registration', async () => {
    tracker.start('chat1', 'dl-1');

    // Simulate: complete fires synchronously before the promise handler runs
    // by completing immediately after starting the wait
    const promise = tracker.waitForCompletion('chat1', 10000);
    tracker.complete('chat1', 'dl-1');

    // Should resolve without needing timer advance
    await vi.advanceTimersByTimeAsync(0);
    await promise;
  });

  it('emits allComplete event when last download for a chat completes', () => {
    const listener = vi.fn();
    tracker.on('allComplete', listener);

    tracker.start('chat1', 'dl-1');
    tracker.start('chat1', 'dl-2');

    tracker.complete('chat1', 'dl-1');
    expect(listener).not.toHaveBeenCalled();

    tracker.complete('chat1', 'dl-2');
    expect(listener).toHaveBeenCalledWith('chat1');
    expect(listener).toHaveBeenCalledTimes(1);
  });
});
