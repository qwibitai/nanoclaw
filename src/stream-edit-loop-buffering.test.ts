import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createStreamEditLoop } from './stream-edit-loop.js';
import { makeImmediateSendOrEdit } from './stream-edit-loop-test-harness.js';

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('StreamEditLoop — core buffering', () => {
  it('does not call sendOrEdit synchronously within throttle window', () => {
    const { fn } = makeImmediateSendOrEdit();
    const loop = createStreamEditLoop({ throttleMs: 500, sendOrEdit: fn });

    loop.update('first');
    loop.update('second');

    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn).toHaveBeenCalledWith('first');

    loop.stop();
  });

  it('overwrites pending text on rapid updates (last wins)', async () => {
    const { fn } = makeImmediateSendOrEdit();
    const loop = createStreamEditLoop({ throttleMs: 500, sendOrEdit: fn });

    loop.update('a');
    await vi.advanceTimersByTimeAsync(0);

    loop.update('b');
    loop.update('c');
    loop.update('d');

    await vi.advanceTimersByTimeAsync(500);

    expect(fn).toHaveBeenCalledTimes(2);
    expect(fn).toHaveBeenNthCalledWith(1, 'a');
    expect(fn).toHaveBeenNthCalledWith(2, 'd');

    loop.stop();
  });

  it('never drops chunks — all updates eventually delivered', async () => {
    const { fn } = makeImmediateSendOrEdit();
    const loop = createStreamEditLoop({ throttleMs: 100, sendOrEdit: fn });

    for (let i = 0; i < 50; i++) {
      loop.update(`chunk-${i}`);
    }

    await vi.advanceTimersByTimeAsync(200);

    const lastCall = fn.mock.calls[fn.mock.calls.length - 1];
    expect(lastCall[0]).toBe('chunk-49');

    loop.stop();
  });
});

describe('StreamEditLoop — throttle scheduling', () => {
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
    await vi.advanceTimersByTimeAsync(0);

    await vi.advanceTimersByTimeAsync(100);
    loop.update('second');
    expect(fn).toHaveBeenCalledTimes(1);

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

    loop.update('a');
    loop.update('b');
    loop.update('c');

    await vi.advanceTimersByTimeAsync(500);

    expect(fn).toHaveBeenCalledTimes(2);
    expect(fn).toHaveBeenNthCalledWith(2, 'c');

    loop.stop();
  });

  it('respects configurable throttleMs', async () => {
    const { fn } = makeImmediateSendOrEdit();
    const loop = createStreamEditLoop({ throttleMs: 200, sendOrEdit: fn });

    loop.update('first');
    await vi.advanceTimersByTimeAsync(0);

    loop.update('second');

    await vi.advanceTimersByTimeAsync(150);
    expect(fn).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(50);
    expect(fn).toHaveBeenCalledTimes(2);

    loop.stop();
  });
});
