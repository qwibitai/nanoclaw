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

describe('StreamEditLoop — flush()', () => {
  it('sends pending text immediately', async () => {
    const mock = makeSendOrEdit();
    const loop = createStreamEditLoop({
      throttleMs: 1000,
      sendOrEdit: mock.fn,
    });

    loop.update('first');
    mock.resolve();
    await vi.advanceTimersByTimeAsync(0);

    loop.update('pending text');

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

    expect(mock.fn).toHaveBeenCalledTimes(1);

    mock.resolve();
    await vi.advanceTimersByTimeAsync(0);

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

    await loop.flush();
    expect(fn).toHaveBeenCalledTimes(2);
    expect(fn).toHaveBeenNthCalledWith(2, 'queued');

    await vi.advanceTimersByTimeAsync(600);
    expect(fn).toHaveBeenCalledTimes(2);

    loop.stop();
  });
});
