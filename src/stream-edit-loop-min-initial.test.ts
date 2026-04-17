import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createStreamEditLoop } from './stream-edit-loop.js';
import { makeImmediateSendOrEdit } from './stream-edit-loop-test-harness.js';

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('StreamEditLoop — minInitialChars (sendOrEdit returns false for too-short)', () => {
  it('skips first send when text is shorter than minInitialChars', async () => {
    const { fn } = makeImmediateSendOrEdit();
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

    expect(wrappedFn).toHaveBeenCalledTimes(1);
    expect(fn).not.toHaveBeenCalled();

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

    skipShort = false;
    await loop.flush();

    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn).toHaveBeenCalledWith('Hi');

    loop.stop();
  });
});
