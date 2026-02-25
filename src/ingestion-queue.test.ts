/**
 * Tests for the ingestion queue — bounded async FIFO with concurrency control.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createIngestionQueue } from './ingestion-queue.js';
import type { Logger } from 'pino';

function mockLogger(): Logger {
  return {
    warn: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
    trace: vi.fn(),
  } as unknown as Logger;
}

describe('createIngestionQueue', () => {
  let logger: Logger;

  beforeEach(() => {
    logger = mockLogger();
  });

  it('processes enqueued work', async () => {
    const queue = createIngestionQueue({ maxConcurrency: 2, maxDepth: 10, logger });
    const results: string[] = [];

    queue.enqueue('a', async () => { results.push('a'); });
    queue.enqueue('b', async () => { results.push('b'); });

    await queue.drain();

    expect(results).toEqual(['a', 'b']);
  });

  it('respects concurrency limit', async () => {
    const queue = createIngestionQueue({ maxConcurrency: 1, maxDepth: 10, logger });
    let concurrent = 0;
    let maxConcurrent = 0;

    const makeWork = () => async () => {
      concurrent++;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      await new Promise((r) => setTimeout(r, 10));
      concurrent--;
    };

    queue.enqueue('a', makeWork());
    queue.enqueue('b', makeWork());
    queue.enqueue('c', makeWork());

    await queue.drain();

    expect(maxConcurrent).toBe(1);
  });

  it('allows concurrent execution up to limit', async () => {
    const queue = createIngestionQueue({ maxConcurrency: 3, maxDepth: 10, logger });
    let concurrent = 0;
    let maxConcurrent = 0;

    const makeWork = () => async () => {
      concurrent++;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      await new Promise((r) => setTimeout(r, 50));
      concurrent--;
    };

    queue.enqueue('a', makeWork());
    queue.enqueue('b', makeWork());
    queue.enqueue('c', makeWork());

    await queue.drain();

    expect(maxConcurrent).toBeLessThanOrEqual(3);
    expect(maxConcurrent).toBeGreaterThanOrEqual(2);
  });

  it('drops oldest on overflow', async () => {
    const queue = createIngestionQueue({ maxConcurrency: 0, maxDepth: 2, logger });
    // maxConcurrency: 0 means nothing gets picked up, so items stack in the queue.
    // Actually concurrency 0 means pump() never starts. Let's use a gate instead.

    let gate: (() => void) | null = null;
    const gatePromise = new Promise<void>((resolve) => { gate = resolve; });

    const realQueue = createIngestionQueue({ maxConcurrency: 1, maxDepth: 2, logger });
    const results: string[] = [];

    // First item blocks the pump
    realQueue.enqueue('blocker', async () => {
      await gatePromise;
      results.push('blocker');
    });

    // These go into the pending queue (maxDepth: 2)
    realQueue.enqueue('a', async () => { results.push('a'); });
    realQueue.enqueue('b', async () => { results.push('b'); });

    // This should cause overflow — 'a' gets dropped
    realQueue.enqueue('c', async () => { results.push('c'); });

    expect(realQueue.pending).toBe(2); // 'b' and 'c'

    // Release blocker
    gate!();
    await realQueue.drain();

    expect(results).toEqual(['blocker', 'b', 'c']);
    expect((logger.debug as ReturnType<typeof vi.fn>)).toHaveBeenCalled();
  });

  it('isolates errors — failed tasks do not propagate', async () => {
    const queue = createIngestionQueue({ maxConcurrency: 2, maxDepth: 10, logger });
    const results: string[] = [];

    queue.enqueue('fail', async () => { throw new Error('boom'); });
    queue.enqueue('ok', async () => { results.push('ok'); });

    await queue.drain();

    expect(results).toEqual(['ok']);
    expect((logger.warn as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith(
      expect.objectContaining({ label: 'fail' }),
      'Ingestion task failed',
    );
  });

  it('drain resolves immediately when queue is empty', async () => {
    const queue = createIngestionQueue({ maxConcurrency: 2, maxDepth: 10, logger });
    await expect(queue.drain()).resolves.toBeUndefined();
  });

  it('reports pending and inflight counts', async () => {
    let gate: (() => void) | null = null;
    const gatePromise = new Promise<void>((resolve) => { gate = resolve; });

    const queue = createIngestionQueue({ maxConcurrency: 1, maxDepth: 10, logger });

    queue.enqueue('slow', async () => { await gatePromise; });
    queue.enqueue('waiting', async () => {});

    // Give pump a tick to start
    await new Promise((r) => setTimeout(r, 5));

    expect(queue.inflight).toBe(1);
    expect(queue.pending).toBe(1);

    gate!();
    await queue.drain();

    expect(queue.inflight).toBe(0);
    expect(queue.pending).toBe(0);
  });
});
