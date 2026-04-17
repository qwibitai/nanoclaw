import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createStreamEditLoop } from './stream-edit-loop.js';
import { makeSendOrEdit } from './stream-edit-loop-test-harness.js';

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('StreamEditLoop — in-flight handling', () => {
  it('does not invoke sendOrEdit while previous call is in-flight', async () => {
    const mock = makeSendOrEdit();
    const loop = createStreamEditLoop({
      throttleMs: 100,
      sendOrEdit: mock.fn,
    });

    loop.update('first');
    expect(mock.fn).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(200);
    loop.update('second');
    await vi.advanceTimersByTimeAsync(200);
    expect(mock.fn).toHaveBeenCalledTimes(1);

    mock.resolve();
    await vi.advanceTimersByTimeAsync(0);

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

    loop.update('second');
    loop.update('third');

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

    loop.update('second');
    await vi.advanceTimersByTimeAsync(200);

    expect(fn).toHaveBeenCalledTimes(1);
  });
});
