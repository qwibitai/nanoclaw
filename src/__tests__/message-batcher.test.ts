import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { MessageBatcher } from '../message-batcher.js';

describe('MessageBatcher', () => {
  let batcher: MessageBatcher;
  let flushed: string[][];

  beforeEach(() => {
    vi.useFakeTimers();
    flushed = [];
    batcher = new MessageBatcher({
      maxItems: 5,
      maxWaitMs: 10_000,
      onFlush: (items) => {
        flushed.push([...items]);
      },
    });
  });

  afterEach(() => {
    batcher.destroy();
    vi.useRealTimers();
  });

  it('flushes after maxItems reached', () => {
    for (let i = 0; i < 5; i++) {
      batcher.add(`item ${i}`);
    }
    expect(flushed).toHaveLength(1);
    expect(flushed[0]).toHaveLength(5);
  });

  it('flushes after maxWaitMs elapsed', () => {
    batcher.add('item 1');
    batcher.add('item 2');
    expect(flushed).toHaveLength(0);

    vi.advanceTimersByTime(10_000);
    expect(flushed).toHaveLength(1);
    expect(flushed[0]).toHaveLength(2);
  });

  it('flushes on priority interrupt', () => {
    batcher.add('item 1');
    batcher.add('item 2');
    expect(flushed).toHaveLength(0);

    batcher.flushNow();
    expect(flushed).toHaveLength(1);
    expect(flushed[0]).toHaveLength(2);
  });

  it('does not flush when empty', () => {
    batcher.flushNow();
    expect(flushed).toHaveLength(0);
  });

  it('resets timer after flush', () => {
    batcher.add('item 1');
    vi.advanceTimersByTime(10_000);
    expect(flushed).toHaveLength(1);

    batcher.add('item 2');
    vi.advanceTimersByTime(5_000);
    expect(flushed).toHaveLength(1); // not yet

    vi.advanceTimersByTime(5_000);
    expect(flushed).toHaveLength(2);
  });
});
