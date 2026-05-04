import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createInboundDebouncer } from './inbound-debouncer.js';

interface TestItem {
  text: string;
}

const FLUSH_MS = 1500;

function joinTexts(items: TestItem[]): TestItem {
  return { text: items.map((i) => i.text).join('\n') };
}

describe('createInboundDebouncer', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('flushes a single push after flushMs with the single item passed through coalesce', async () => {
    const flushed: Array<{ key: string; item: TestItem }> = [];
    const debouncer = createInboundDebouncer<TestItem>({
      flushMs: FLUSH_MS,
      coalesce: joinTexts,
      onFlush: async (key, item) => {
        flushed.push({ key, item });
      },
    });

    debouncer.push('chat-1', { text: 'hello' });
    expect(flushed).toEqual([]);

    await vi.advanceTimersByTimeAsync(FLUSH_MS + 50);

    expect(flushed).toEqual([{ key: 'chat-1', item: { text: 'hello' } }]);
  });

  it('coalesces three rapid pushes within the window into a single onFlush call (in arrival order)', async () => {
    const flushed: Array<{ key: string; item: TestItem }> = [];
    const debouncer = createInboundDebouncer<TestItem>({
      flushMs: FLUSH_MS,
      coalesce: joinTexts,
      onFlush: async (key, item) => {
        flushed.push({ key, item });
      },
    });

    debouncer.push('chat-1', { text: 'hey' });
    await vi.advanceTimersByTimeAsync(200);
    debouncer.push('chat-1', { text: 'hello' });
    await vi.advanceTimersByTimeAsync(200);
    debouncer.push('chat-1', { text: 'are you there?' });

    expect(flushed).toEqual([]);

    await vi.advanceTimersByTimeAsync(FLUSH_MS + 50);

    expect(flushed).toEqual([{ key: 'chat-1', item: { text: 'hey\nhello\nare you there?' } }]);
  });

  it('resets the timer on each push — half-window-spaced pushes coalesce instead of firing twice', async () => {
    const flushed: Array<{ key: string; item: TestItem }> = [];
    const debouncer = createInboundDebouncer<TestItem>({
      flushMs: FLUSH_MS,
      coalesce: joinTexts,
      onFlush: async (key, item) => {
        flushed.push({ key, item });
      },
    });

    debouncer.push('chat-1', { text: 'first' });
    await vi.advanceTimersByTimeAsync(FLUSH_MS / 2);
    expect(flushed).toEqual([]);

    debouncer.push('chat-1', { text: 'second' });
    // After the second push, the timer is reset. We've consumed half a
    // window; another half wouldn't be enough — the second push pushed
    // the deadline out by a full FLUSH_MS.
    await vi.advanceTimersByTimeAsync(FLUSH_MS / 2 + 50);
    expect(flushed).toEqual([]);

    await vi.advanceTimersByTimeAsync(FLUSH_MS / 2 + 50);
    expect(flushed).toEqual([{ key: 'chat-1', item: { text: 'first\nsecond' } }]);
  });

  it('flushes different keys independently', async () => {
    const flushed: Array<{ key: string; item: TestItem }> = [];
    const debouncer = createInboundDebouncer<TestItem>({
      flushMs: FLUSH_MS,
      coalesce: joinTexts,
      onFlush: async (key, item) => {
        flushed.push({ key, item });
      },
    });

    debouncer.push('chat-1', { text: 'a1' });
    debouncer.push('chat-2', { text: 'b1' });
    await vi.advanceTimersByTimeAsync(200);
    debouncer.push('chat-1', { text: 'a2' });
    // chat-2 has not been touched since first push — its timer is older
    // by 200ms than chat-1's freshly-reset timer.

    await vi.advanceTimersByTimeAsync(FLUSH_MS - 200 + 10);
    // chat-2 should have flushed by now; chat-1 still buffered.
    expect(flushed).toEqual([{ key: 'chat-2', item: { text: 'b1' } }]);

    await vi.advanceTimersByTimeAsync(FLUSH_MS);
    expect(flushed).toEqual([
      { key: 'chat-2', item: { text: 'b1' } },
      { key: 'chat-1', item: { text: 'a1\na2' } },
    ]);
  });

  it('dispose cancels pending timers — onFlush is never called after dispose', async () => {
    const flushed: Array<{ key: string; item: TestItem }> = [];
    const debouncer = createInboundDebouncer<TestItem>({
      flushMs: FLUSH_MS,
      coalesce: joinTexts,
      onFlush: async (key, item) => {
        flushed.push({ key, item });
      },
    });

    debouncer.push('chat-1', { text: 'pending' });
    debouncer.push('chat-2', { text: 'also pending' });

    debouncer.dispose();

    await vi.advanceTimersByTimeAsync(FLUSH_MS * 10);

    expect(flushed).toEqual([]);
  });

  it('push is a no-op after dispose', async () => {
    const flushed: Array<{ key: string; item: TestItem }> = [];
    const debouncer = createInboundDebouncer<TestItem>({
      flushMs: FLUSH_MS,
      coalesce: joinTexts,
      onFlush: async (key, item) => {
        flushed.push({ key, item });
      },
    });

    debouncer.dispose();
    debouncer.push('chat-1', { text: 'too late' });

    await vi.advanceTimersByTimeAsync(FLUSH_MS * 10);

    expect(flushed).toEqual([]);
  });

  it('coalesce is called even for a single buffered item (uniform path)', async () => {
    const coalesceSpy = vi.fn(joinTexts);
    const debouncer = createInboundDebouncer<TestItem>({
      flushMs: FLUSH_MS,
      coalesce: coalesceSpy,
      onFlush: async () => {},
    });

    debouncer.push('chat-1', { text: 'just one' });
    await vi.advanceTimersByTimeAsync(FLUSH_MS + 50);

    expect(coalesceSpy).toHaveBeenCalledTimes(1);
    expect(coalesceSpy).toHaveBeenCalledWith([{ text: 'just one' }]);
  });

  it('routes onFlush rejection through onError', async () => {
    const errors: Array<{ err: unknown; key: string }> = [];
    const boom = new Error('downstream blew up');
    const debouncer = createInboundDebouncer<TestItem>({
      flushMs: FLUSH_MS,
      coalesce: joinTexts,
      onFlush: async () => {
        throw boom;
      },
      onError: (err, key) => {
        errors.push({ err, key });
      },
    });

    debouncer.push('chat-1', { text: 'x' });
    await vi.advanceTimersByTimeAsync(FLUSH_MS + 50);

    expect(errors).toEqual([{ err: boom, key: 'chat-1' }]);
  });

  it('routes synchronous coalesce throws through onError', async () => {
    const errors: Array<{ err: unknown; key: string }> = [];
    const boom = new Error('coalesce boom');
    const debouncer = createInboundDebouncer<TestItem>({
      flushMs: FLUSH_MS,
      coalesce: () => {
        throw boom;
      },
      onFlush: async () => {},
      onError: (err, key) => {
        errors.push({ err, key });
      },
    });

    debouncer.push('chat-1', { text: 'x' });
    await vi.advanceTimersByTimeAsync(FLUSH_MS + 50);

    expect(errors).toEqual([{ err: boom, key: 'chat-1' }]);
  });

  it('a key buffered, flushed, then pushed again starts a fresh buffer', async () => {
    const flushed: Array<{ key: string; item: TestItem }> = [];
    const debouncer = createInboundDebouncer<TestItem>({
      flushMs: FLUSH_MS,
      coalesce: joinTexts,
      onFlush: async (key, item) => {
        flushed.push({ key, item });
      },
    });

    debouncer.push('chat-1', { text: 'first burst' });
    await vi.advanceTimersByTimeAsync(FLUSH_MS + 50);

    debouncer.push('chat-1', { text: 'second burst' });
    await vi.advanceTimersByTimeAsync(FLUSH_MS + 50);

    expect(flushed).toEqual([
      { key: 'chat-1', item: { text: 'first burst' } },
      { key: 'chat-1', item: { text: 'second burst' } },
    ]);
  });
});
