import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createStreamEditLoop } from './stream-edit-loop.js';

describe('StreamEditLoop', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // Helper: create a controllable sendOrEdit mock
  function makeSendOrEdit() {
    const calls: string[] = [];
    let resolve: () => void = () => {};
    const fn = vi.fn(async (text: string) => {
      calls.push(text);
      await new Promise<void>((r) => {
        resolve = r;
      });
    });
    return {
      fn,
      calls,
      resolve: () => resolve(),
    };
  }

  // Helper: create a sendOrEdit that resolves immediately
  function makeImmediateSendOrEdit() {
    const calls: string[] = [];
    const fn = vi.fn(async (text: string) => {
      calls.push(text);
    });
    return { fn, calls };
  }

  describe('core buffering', () => {
    it('does not call sendOrEdit synchronously within throttle window', () => {
      const { fn } = makeImmediateSendOrEdit();
      const loop = createStreamEditLoop({ throttleMs: 500, sendOrEdit: fn });

      // First update flushes immediately (window is clear)
      loop.update('first');
      // Second update within window should schedule, not call synchronously
      loop.update('second');

      // Only the first flush call should have happened
      expect(fn).toHaveBeenCalledTimes(1);
      expect(fn).toHaveBeenCalledWith('first');

      loop.stop();
    });

    it('overwrites pending text on rapid updates (last wins)', async () => {
      const { fn } = makeImmediateSendOrEdit();
      const loop = createStreamEditLoop({ throttleMs: 500, sendOrEdit: fn });

      loop.update('a');
      await vi.advanceTimersByTimeAsync(0); // flush 'a'

      // Rapid updates within throttle window
      loop.update('b');
      loop.update('c');
      loop.update('d');

      await vi.advanceTimersByTimeAsync(500);

      // Only 'd' should be sent (last wins)
      expect(fn).toHaveBeenCalledTimes(2);
      expect(fn).toHaveBeenNthCalledWith(1, 'a');
      expect(fn).toHaveBeenNthCalledWith(2, 'd');

      loop.stop();
    });

    it('never drops chunks — all updates eventually delivered', async () => {
      const { fn } = makeImmediateSendOrEdit();
      const loop = createStreamEditLoop({ throttleMs: 100, sendOrEdit: fn });

      // 50 rapid updates — only the last matters
      for (let i = 0; i < 50; i++) {
        loop.update(`chunk-${i}`);
      }

      // Advance past throttle
      await vi.advanceTimersByTimeAsync(200);

      // The last chunk must have been delivered
      const lastCall = fn.mock.calls[fn.mock.calls.length - 1];
      expect(lastCall[0]).toBe('chunk-49');

      loop.stop();
    });
  });

  describe('throttle scheduling', () => {
    it('flushes immediately on first update when throttle window is clear', () => {
      const { fn } = makeImmediateSendOrEdit();
      const loop = createStreamEditLoop({ throttleMs: 500, sendOrEdit: fn });

      loop.update('hello');

      expect(fn).toHaveBeenCalledTimes(1);
      expect(fn).toHaveBeenCalledWith('hello');

      loop.stop();
    });

    it('schedules delayed flush within throttle window', async () => {
      const { fn } = makeImmediateSendOrEdit();
      const loop = createStreamEditLoop({ throttleMs: 500, sendOrEdit: fn });

      loop.update('first');
      await vi.advanceTimersByTimeAsync(0); // complete first flush

      // 100ms later — within window
      await vi.advanceTimersByTimeAsync(100);
      loop.update('second');
      expect(fn).toHaveBeenCalledTimes(1); // not yet

      // 400ms more — window expires
      await vi.advanceTimersByTimeAsync(400);
      expect(fn).toHaveBeenCalledTimes(2);
      expect(fn).toHaveBeenNthCalledWith(2, 'second');

      loop.stop();
    });

    it('coalesces multiple updates into one sendOrEdit call', async () => {
      const { fn } = makeImmediateSendOrEdit();
      const loop = createStreamEditLoop({ throttleMs: 500, sendOrEdit: fn });

      loop.update('first');
      await vi.advanceTimersByTimeAsync(0);

      // Multiple updates within window
      loop.update('a');
      loop.update('b');
      loop.update('c');

      await vi.advanceTimersByTimeAsync(500);

      expect(fn).toHaveBeenCalledTimes(2); // 'first' + 'c' (coalesced)
      expect(fn).toHaveBeenNthCalledWith(2, 'c');

      loop.stop();
    });

    it('respects configurable throttleMs', async () => {
      const { fn } = makeImmediateSendOrEdit();
      const loop = createStreamEditLoop({ throttleMs: 200, sendOrEdit: fn });

      loop.update('first');
      await vi.advanceTimersByTimeAsync(0);

      loop.update('second');

      // At 150ms — still within 200ms window
      await vi.advanceTimersByTimeAsync(150);
      expect(fn).toHaveBeenCalledTimes(1);

      // At 200ms — window expires
      await vi.advanceTimersByTimeAsync(50);
      expect(fn).toHaveBeenCalledTimes(2);

      loop.stop();
    });
  });

  describe('in-flight handling', () => {
    it('does not invoke sendOrEdit while previous call is in-flight', async () => {
      const mock = makeSendOrEdit();
      const loop = createStreamEditLoop({
        throttleMs: 100,
        sendOrEdit: mock.fn,
      });

      loop.update('first');
      // 'first' is now in-flight (unresolved)
      expect(mock.fn).toHaveBeenCalledTimes(1);

      // Advance past throttle and update — should NOT call sendOrEdit again
      await vi.advanceTimersByTimeAsync(200);
      loop.update('second');
      await vi.advanceTimersByTimeAsync(200);
      expect(mock.fn).toHaveBeenCalledTimes(1); // still just 1

      // Resolve the in-flight call
      mock.resolve();
      await vi.advanceTimersByTimeAsync(0);

      // Now pending 'second' should be flushed
      await vi.advanceTimersByTimeAsync(100);
      expect(mock.fn).toHaveBeenCalledTimes(2);
      expect(mock.fn).toHaveBeenNthCalledWith(2, 'second');

      mock.resolve();
      loop.stop();
    });

    it('flushes pending text after in-flight resolves', async () => {
      const mock = makeSendOrEdit();
      const loop = createStreamEditLoop({
        throttleMs: 100,
        sendOrEdit: mock.fn,
      });

      loop.update('first');
      expect(mock.fn).toHaveBeenCalledTimes(1);

      // Queue more text while in-flight
      loop.update('second');
      loop.update('third');

      // Resolve in-flight
      mock.resolve();
      await vi.advanceTimersByTimeAsync(200);

      expect(mock.fn).toHaveBeenCalledTimes(2);
      expect(mock.fn).toHaveBeenNthCalledWith(2, 'third');

      mock.resolve();
      loop.stop();
    });

    it('marks stopped when sendOrEdit rejects', async () => {
      const fn = vi.fn(async () => {
        throw new Error('API failure');
      });
      const loop = createStreamEditLoop({ throttleMs: 100, sendOrEdit: fn });

      loop.update('first');
      await vi.advanceTimersByTimeAsync(0);

      // After rejection, subsequent updates should be ignored
      loop.update('second');
      await vi.advanceTimersByTimeAsync(200);

      expect(fn).toHaveBeenCalledTimes(1); // only the failed call
    });
  });

  describe('minInitialChars', () => {
    it('skips first send when text is shorter than minInitialChars', async () => {
      const { fn } = makeImmediateSendOrEdit();
      // sendOrEdit returns false when text is too short (caller checks minInitialChars)
      const wrappedFn = vi.fn(async (text: string) => {
        if (text.length < 20) return false as const;
        await fn(text);
      });
      const loop = createStreamEditLoop({
        throttleMs: 100,
        sendOrEdit: wrappedFn,
      });

      loop.update('Hi');
      await vi.advanceTimersByTimeAsync(0);

      // sendOrEdit was called but returned false — text put back as pending
      expect(wrappedFn).toHaveBeenCalledTimes(1);
      expect(fn).not.toHaveBeenCalled(); // inner fn not reached

      // Now update with enough text
      loop.update('Hi, I will look into that for you.');
      await vi.advanceTimersByTimeAsync(200);

      expect(fn).toHaveBeenCalledTimes(1);
      expect(fn).toHaveBeenCalledWith('Hi, I will look into that for you.');

      loop.stop();
    });

    it('flushes immediately when first text exceeds minInitialChars', async () => {
      const { fn } = makeImmediateSendOrEdit();
      const wrappedFn = vi.fn(async (text: string) => {
        if (text.length < 10) return false as const;
        await fn(text);
      });
      const loop = createStreamEditLoop({
        throttleMs: 500,
        sendOrEdit: wrappedFn,
      });

      loop.update('This is a long enough initial text');
      await vi.advanceTimersByTimeAsync(0);

      expect(fn).toHaveBeenCalledTimes(1);
      expect(fn).toHaveBeenCalledWith('This is a long enough initial text');

      loop.stop();
    });

    it('flush() forces delivery regardless of minInitialChars', async () => {
      const { fn } = makeImmediateSendOrEdit();
      let skipShort = true;
      const wrappedFn = vi.fn(async (text: string) => {
        if (skipShort && text.length < 20) return false as const;
        await fn(text);
      });
      const loop = createStreamEditLoop({
        throttleMs: 500,
        sendOrEdit: wrappedFn,
      });

      loop.update('Hi');
      await vi.advanceTimersByTimeAsync(0);
      expect(fn).not.toHaveBeenCalled();

      // Explicit flush should force delivery
      skipShort = false;
      await loop.flush();

      expect(fn).toHaveBeenCalledTimes(1);
      expect(fn).toHaveBeenCalledWith('Hi');

      loop.stop();
    });
  });

  describe('flush()', () => {
    it('sends pending text immediately', async () => {
      const mock = makeSendOrEdit();
      const loop = createStreamEditLoop({
        throttleMs: 1000,
        sendOrEdit: mock.fn,
      });

      loop.update('first');
      mock.resolve();
      await vi.advanceTimersByTimeAsync(0);

      // Queue text within throttle window
      loop.update('pending text');

      // flush() should send immediately, not wait for timer
      const flushPromise = loop.flush();
      expect(mock.fn).toHaveBeenCalledTimes(2);
      expect(mock.fn).toHaveBeenNthCalledWith(2, 'pending text');

      mock.resolve();
      await flushPromise;

      loop.stop();
    });

    it('waits for in-flight before sending pending', async () => {
      const mock = makeSendOrEdit();
      const loop = createStreamEditLoop({
        throttleMs: 100,
        sendOrEdit: mock.fn,
      });

      loop.update('in-flight');
      expect(mock.fn).toHaveBeenCalledTimes(1);

      loop.update('pending');
      const flushPromise = loop.flush();

      // Still waiting for in-flight
      expect(mock.fn).toHaveBeenCalledTimes(1);

      // Resolve in-flight
      mock.resolve();
      await vi.advanceTimersByTimeAsync(0);

      // Now pending should be sent
      expect(mock.fn).toHaveBeenCalledTimes(2);
      expect(mock.fn).toHaveBeenNthCalledWith(2, 'pending');

      mock.resolve();
      await flushPromise;

      loop.stop();
    });

    it('no-ops when nothing is pending and nothing is in-flight', async () => {
      const { fn } = makeImmediateSendOrEdit();
      const loop = createStreamEditLoop({ throttleMs: 100, sendOrEdit: fn });

      await loop.flush();

      expect(fn).not.toHaveBeenCalled();

      loop.stop();
    });

    it('clears scheduled timer to prevent double-send', async () => {
      const { fn } = makeImmediateSendOrEdit();
      const loop = createStreamEditLoop({ throttleMs: 500, sendOrEdit: fn });

      loop.update('first');
      await vi.advanceTimersByTimeAsync(0);

      loop.update('queued');
      // Timer is now scheduled for ~500ms

      // flush() should clear the timer and send immediately
      await loop.flush();
      expect(fn).toHaveBeenCalledTimes(2);
      expect(fn).toHaveBeenNthCalledWith(2, 'queued');

      // Advance past the original timer — should NOT send again
      await vi.advanceTimersByTimeAsync(600);
      expect(fn).toHaveBeenCalledTimes(2);

      loop.stop();
    });
  });

  describe('stop() and waitForInFlight()', () => {
    it('stop() clears pending and cancels timer', async () => {
      const { fn } = makeImmediateSendOrEdit();
      const loop = createStreamEditLoop({ throttleMs: 500, sendOrEdit: fn });

      loop.update('first');
      await vi.advanceTimersByTimeAsync(0);

      loop.update('pending');
      loop.stop();

      // Advance past timer — nothing should be sent
      await vi.advanceTimersByTimeAsync(600);
      expect(fn).toHaveBeenCalledTimes(1); // only 'first'
    });

    it('stop() causes subsequent update() calls to be ignored', async () => {
      const { fn } = makeImmediateSendOrEdit();
      const loop = createStreamEditLoop({ throttleMs: 100, sendOrEdit: fn });

      loop.stop();
      loop.update('after stop');

      await vi.advanceTimersByTimeAsync(200);
      expect(fn).not.toHaveBeenCalled();
    });

    it('waitForInFlight() resolves immediately when idle', async () => {
      const { fn } = makeImmediateSendOrEdit();
      const loop = createStreamEditLoop({ throttleMs: 100, sendOrEdit: fn });

      await loop.waitForInFlight(); // should not hang

      loop.stop();
    });

    it('waitForInFlight() blocks until in-flight settles', async () => {
      const mock = makeSendOrEdit();
      const loop = createStreamEditLoop({
        throttleMs: 100,
        sendOrEdit: mock.fn,
      });

      loop.update('in-flight');
      expect(mock.fn).toHaveBeenCalledTimes(1);

      let waited = false;
      const waitPromise = loop.waitForInFlight().then(() => {
        waited = true;
      });

      await vi.advanceTimersByTimeAsync(0);
      expect(waited).toBe(false);

      mock.resolve();
      await waitPromise;
      expect(waited).toBe(true);

      loop.stop();
    });
  });

  describe('resetForNextQuery()', () => {
    it('clears pending text and resets throttle window', async () => {
      const { fn } = makeImmediateSendOrEdit();
      const loop = createStreamEditLoop({ throttleMs: 500, sendOrEdit: fn });

      loop.update('first');
      await vi.advanceTimersByTimeAsync(0);

      loop.update('pending');
      loop.resetForNextQuery();

      // Pending text should be cleared
      await vi.advanceTimersByTimeAsync(600);
      expect(fn).toHaveBeenCalledTimes(1); // only 'first'

      // Throttle window reset — next update should flush immediately
      loop.update('new query');
      expect(fn).toHaveBeenCalledTimes(2);
      expect(fn).toHaveBeenNthCalledWith(2, 'new query');

      loop.stop();
    });

    it('does NOT mark the loop as stopped (reusable across queries)', async () => {
      const { fn } = makeImmediateSendOrEdit();
      const loop = createStreamEditLoop({ throttleMs: 100, sendOrEdit: fn });

      loop.update('query1');
      await vi.advanceTimersByTimeAsync(0);

      loop.resetForNextQuery();

      loop.update('query2');
      await vi.advanceTimersByTimeAsync(0);

      expect(fn).toHaveBeenCalledTimes(2);
      expect(fn).toHaveBeenNthCalledWith(1, 'query1');
      expect(fn).toHaveBeenNthCalledWith(2, 'query2');

      loop.stop();
    });

    it('resets stopped flag so loop can be reused after error', async () => {
      let shouldFail = true;
      const fn = vi.fn(async (_text: string) => {
        if (shouldFail) throw new Error('fail');
      });
      const loop = createStreamEditLoop({ throttleMs: 100, sendOrEdit: fn });

      loop.update('will fail');
      await vi.advanceTimersByTimeAsync(0);

      // Now stopped — update is ignored
      loop.update('ignored');
      await vi.advanceTimersByTimeAsync(200);
      expect(fn).toHaveBeenCalledTimes(1);

      // Reset and retry
      shouldFail = false;
      loop.resetForNextQuery();
      loop.update('works now');
      await vi.advanceTimersByTimeAsync(0);

      expect(fn).toHaveBeenCalledTimes(2);
      expect(fn).toHaveBeenNthCalledWith(2, 'works now');

      loop.stop();
    });
  });
});
