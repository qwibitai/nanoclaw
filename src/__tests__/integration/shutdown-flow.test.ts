/**
 * Integration: graceful shutdown during in-flight work
 *
 * Ensures that GroupQueue.shutdown():
 * - prevents new work from being accepted
 * - leaves in-flight processMessagesFn calls alone (does not cancel them)
 * - is idempotent (can be called multiple times)
 *
 * Exercises the shutdown path that callers in src/index.ts rely on when
 * the process receives SIGINT/SIGTERM.
 */
import { beforeEach, describe, expect, it } from 'vitest';

import { GroupQueue } from '../../group-queue.js';

describe('integration: graceful shutdown', () => {
  let queue: GroupQueue;

  beforeEach(() => {
    queue = new GroupQueue();
  });

  it('rejects new enqueues after shutdown', async () => {
    await queue.shutdown(0);

    let called = 0;
    queue.setProcessMessagesFn(async () => {
      called++;
      return true;
    });

    queue.enqueueMessageCheck('group@g.us');
    queue.enqueueTask('group@g.us', 't1', async () => {
      called++;
    });

    // Give the runtime a chance to run anything that slipped through.
    await new Promise((r) => setTimeout(r, 10));
    expect(called).toBe(0);
  });

  it('in-flight processing completes after shutdown is initiated', async () => {
    let resolveProcess: () => void = () => {};
    let startedAt = 0;
    let finishedAt = 0;
    const processing = new Promise<void>((r) => {
      resolveProcess = r;
    });

    queue.setProcessMessagesFn(async () => {
      startedAt = Date.now();
      await processing;
      finishedAt = Date.now();
      return true;
    });

    queue.enqueueMessageCheck('group@g.us');
    // Let runForGroup begin.
    await new Promise((r) => setTimeout(r, 10));
    expect(startedAt).toBeGreaterThan(0);
    expect(finishedAt).toBe(0);

    // Shutdown signals intent to stop but must not cancel the running fn.
    const shutdownPromise = queue.shutdown(0);

    // Release the in-flight work — it should be allowed to complete.
    resolveProcess();
    await shutdownPromise;
    await new Promise((r) => setTimeout(r, 10));

    expect(finishedAt).toBeGreaterThanOrEqual(startedAt);
  });

  it('shutdown is idempotent', async () => {
    await queue.shutdown(0);
    await expect(queue.shutdown(0)).resolves.toBeUndefined();
    // Still refuses new work.
    let called = 0;
    queue.setProcessMessagesFn(async () => {
      called++;
      return true;
    });
    queue.enqueueMessageCheck('post-shutdown@g.us');
    await new Promise((r) => setTimeout(r, 10));
    expect(called).toBe(0);
  });
});
