import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { extractImages } from './router.js';
import { createStreamEditLoop } from './stream-edit-loop.js';

// Simulates the sendOrEdit callback pattern from src/index.ts:
// extractImages strips <image> tags before streaming, returns false
// for image-only text so the loop buffers it without sending.
function makeImageStrippingSendOrEdit() {
  const sent: string[] = [];
  const fn = vi.fn(async (text: string) => {
    const { cleanText } = extractImages(text);
    if (!cleanText) return false as const;
    sent.push(cleanText);
  });
  return { fn, sent };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('StreamEditLoop — image tag stripping integration (issue #30)', () => {
  it('strips image tags and sends only the text portion', async () => {
    const { fn, sent } = makeImageStrippingSendOrEdit();
    const loop = createStreamEditLoop({ throttleMs: 100, sendOrEdit: fn });

    loop.update('Here is your chart: <image path="chart.png" />');
    await vi.advanceTimersByTimeAsync(0);

    expect(sent).toEqual(['Here is your chart:']);

    loop.stop();
  });

  it('returns false for image-only text, preventing a send', async () => {
    const { fn, sent } = makeImageStrippingSendOrEdit();
    const loop = createStreamEditLoop({ throttleMs: 100, sendOrEdit: fn });

    loop.update('<image path="chart.png" />');
    await vi.advanceTimersByTimeAsync(0);

    expect(fn).toHaveBeenCalledTimes(1);
    expect(sent).toEqual([]);

    loop.stop();
  });

  it('image-only text does not block subsequent text updates', async () => {
    const { fn, sent } = makeImageStrippingSendOrEdit();
    const loop = createStreamEditLoop({ throttleMs: 100, sendOrEdit: fn });

    loop.update('<image path="chart.png" />');
    await vi.advanceTimersByTimeAsync(0);
    expect(sent).toEqual([]);

    loop.update('Result: <image path="chart.png" />');
    await vi.advanceTimersByTimeAsync(200);

    expect(sent).toEqual(['Result:']);

    loop.stop();
  });

  it('flush on image-only text returns without sending', async () => {
    const { fn, sent } = makeImageStrippingSendOrEdit();
    const loop = createStreamEditLoop({ throttleMs: 100, sendOrEdit: fn });

    loop.update('<image path="a.png" /><image path="b.png" />');
    await vi.advanceTimersByTimeAsync(0);

    await loop.flush();
    expect(sent).toEqual([]);

    loop.resetForNextQuery();

    loop.update('Next query text');
    await vi.advanceTimersByTimeAsync(0);
    expect(sent).toEqual(['Next query text']);

    loop.stop();
  });

  it('mixed text and images: only clean text is sent during streaming', async () => {
    const { sent } = makeImageStrippingSendOrEdit();
    const loop = createStreamEditLoop({
      throttleMs: 100,
      sendOrEdit: async (text: string) => {
        const { cleanText } = extractImages(text);
        if (!cleanText) return false as const;
        sent.push(cleanText);
      },
    });

    loop.update('Analyzing');
    await vi.advanceTimersByTimeAsync(0);

    loop.update('Analyzing your data...\n<image path="plot.png" />');
    await vi.advanceTimersByTimeAsync(200);

    loop.update('Analyzing your data...\n<image path="plot.png" />\nDone!');
    await vi.advanceTimersByTimeAsync(200);

    expect(sent).toEqual([
      'Analyzing',
      'Analyzing your data...',
      'Analyzing your data...\n\nDone!',
    ]);

    loop.stop();
  });
});
