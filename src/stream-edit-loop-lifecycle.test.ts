import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createStreamEditLoop } from './stream-edit-loop.js';
import {
  makeImmediateSendOrEdit,
  makeSendOrEdit,
} from './stream-edit-loop-test-harness.js';

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('StreamEditLoop — stop() and waitForInFlight()', () => {
  it('stop() clears pending and cancels timer', async () => {
    const { fn } = makeImmediateSendOrEdit();
    const loop = createStreamEditLoop({ throttleMs: 500, sendOrEdit: fn });

    loop.update('first');
    await vi.advanceTimersByTimeAsync(0);

    loop.update('pending');
    loop.stop();

    await vi.advanceTimersByTimeAsync(600);
    expect(fn).toHaveBeenCalledTimes(1);
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

    await loop.waitForInFlight();

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

describe('StreamEditLoop — resetForNextQuery()', () => {
  it('clears pending text and resets throttle window', async () => {
    const { fn } = makeImmediateSendOrEdit();
    const loop = createStreamEditLoop({ throttleMs: 500, sendOrEdit: fn });

    loop.update('first');
    await vi.advanceTimersByTimeAsync(0);

    loop.update('pending');
    loop.resetForNextQuery();

    await vi.advanceTimersByTimeAsync(600);
    expect(fn).toHaveBeenCalledTimes(1);

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

    loop.update('ignored');
    await vi.advanceTimersByTimeAsync(200);
    expect(fn).toHaveBeenCalledTimes(1);

    shouldFail = false;
    loop.resetForNextQuery();
    loop.update('works now');
    await vi.advanceTimersByTimeAsync(0);

    expect(fn).toHaveBeenCalledTimes(2);
    expect(fn).toHaveBeenNthCalledWith(2, 'works now');

    loop.stop();
  });
});
