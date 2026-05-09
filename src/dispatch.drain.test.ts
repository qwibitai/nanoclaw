/**
 * Tests for the SIGTERM-drain functionality in dispatch.ts.
 *
 * Sibling of router.drain.test.ts. These tests verify that:
 *   1. awaitDispatchDrain returns immediately when nothing is in flight.
 *   2. awaitDispatchDrain waits for an in-flight dispatchResponse call to settle.
 *   3. awaitDispatchDrain returns after timeoutMs when the handler hangs,
 *      and logs a warning (timeout path). Uses fake timers so tests are
 *      deterministic and do not wall-clock-wait.
 *   4. dispatchResponse correctly adds/removes from the in-flight set on the
 *      happy path (handler claims) and the unclaimed path (no handler returns
 *      true). Handler errors are swallowed inside doDispatchResponse, so the
 *      Promise resolves normally — cleanup goes through the `finally` block
 *      either way.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { ResponseHandler, ResponsePayload } from './response-registry.js';

// ---------------------------------------------------------------------------
// Module mocks — must be declared before any imports from the mocked modules.
// We mock response-registry so each test can install its own handler list,
// and log.js so we can assert on log calls.
// ---------------------------------------------------------------------------

vi.mock('./log.js', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const { handlers, registerResponseHandler, getResponseHandlers, resetHandlers } = vi.hoisted(() => {
  const handlers: ResponseHandler[] = [];
  return {
    handlers,
    registerResponseHandler: (h: ResponseHandler) => {
      handlers.push(h);
    },
    getResponseHandlers: (): readonly ResponseHandler[] => handlers,
    resetHandlers: () => {
      handlers.length = 0;
    },
  };
});

vi.mock('./response-registry.js', () => ({
  registerResponseHandler,
  getResponseHandlers,
  // The drain tests don't care about shutdown callbacks, but the real module
  // exports them — keep the surface congruent so unrelated imports don't break.
  onShutdown: vi.fn(),
  getShutdownCallbacks: () => [],
}));

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import { log } from './log.js';
import { dispatchResponse, awaitDispatchDrain, _resetDispatchTrackingForTests } from './dispatch.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makePayload(questionId = 'q-test'): ResponsePayload {
  return {
    questionId,
    value: 'option-a',
    userId: 'user-1',
    channelType: 'test',
    platformId: 'plat-1',
    threadId: null,
  };
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('awaitDispatchDrain', () => {
  beforeEach(() => {
    _resetDispatchTrackingForTests();
    resetHandlers();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // -------------------------------------------------------------------------
  // Test 1: empty drain
  // -------------------------------------------------------------------------
  it('returns immediately when no dispatch is in flight', async () => {
    await expect(awaitDispatchDrain(5_000)).resolves.toBeUndefined();
    expect(log.info).not.toHaveBeenCalledWith('Draining in-flight dispatch work', expect.anything());
  });

  // -------------------------------------------------------------------------
  // Test 2: drain waits for in-flight work to settle
  // -------------------------------------------------------------------------
  it('waits for an in-flight dispatchResponse call to settle before resolving', async () => {
    // Install a handler that hangs until we resolve it.
    let resolveHang!: () => void;
    const hangUntilReleased = new Promise<void>((r) => {
      resolveHang = r;
    });
    registerResponseHandler(async () => {
      await hangUntilReleased;
      return true; // claim — prevents the unclaimed-response warn
    });

    // Fire dispatchResponse without awaiting — puts the work in-flight.
    const dispatchDone = dispatchResponse(makePayload());

    // Yield to let doDispatchResponse start executing and hit the await.
    await Promise.resolve();

    // Start draining — should NOT resolve yet because work is still in-flight.
    let drainSettled = false;
    const drainPromise = awaitDispatchDrain(10_000).then(() => {
      drainSettled = true;
    });

    await Promise.resolve();
    expect(drainSettled).toBe(false);

    // Release the hanging handler.
    resolveHang();

    // Now both should complete.
    await Promise.all([dispatchDone, drainPromise]);
    expect(drainSettled).toBe(true);
    expect(log.info).toHaveBeenCalledWith('Dispatch drain complete', expect.any(Object));
    expect(log.warn).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Test 3: timeout path (fake timers)
  // -------------------------------------------------------------------------
  it('resolves after timeoutMs when in-flight work hangs, and logs a warning', async () => {
    vi.useFakeTimers();

    // Install a permanently-hanging handler.
    registerResponseHandler(async () => {
      await new Promise<void>(() => {
        /* never resolves */
      });
      return true;
    });

    // Fire dispatchResponse without awaiting.
    dispatchResponse(makePayload());

    // Yield so doDispatchResponse starts and the work is registered in-flight.
    await Promise.resolve();

    // Start drain with a 5 s timeout.
    const drainPromise = awaitDispatchDrain(5_000);

    // Advance fake clock past the timeout (+ 1 ms slack).
    await vi.advanceTimersByTimeAsync(5_001);

    // Drain should now resolve (via the timeout branch).
    await drainPromise;

    expect(log.warn).toHaveBeenCalledWith(
      'Dispatch drain timed out; proceeding with shutdown',
      expect.objectContaining({ timeoutMs: 5_000 }),
    );
  });

  // -------------------------------------------------------------------------
  // Test 4a: happy path — set is empty after dispatchResponse claims
  // -------------------------------------------------------------------------
  it('removes work from the in-flight set when a handler claims the response', async () => {
    registerResponseHandler(async () => true);

    await dispatchResponse(makePayload());

    // Drain should return immediately — set is empty.
    let resolved = false;
    await awaitDispatchDrain(1_000).then(() => {
      resolved = true;
    });
    expect(resolved).toBe(true);
    expect(log.info).not.toHaveBeenCalledWith('Draining in-flight dispatch work', expect.anything());
  });

  // -------------------------------------------------------------------------
  // Test 4b: unclaimed path — set is empty after dispatch finishes with a warn
  // -------------------------------------------------------------------------
  it('removes work from the in-flight set when no handler claims the response', async () => {
    // No handlers registered — every dispatch falls through to the warn.
    await dispatchResponse(makePayload('q-unclaimed'));

    expect(log.warn).toHaveBeenCalledWith('Unclaimed response', expect.objectContaining({ questionId: 'q-unclaimed' }));

    // Despite the warn, finally cleared the set. Drain resolves immediately.
    let resolved = false;
    await awaitDispatchDrain(1_000).then(() => {
      resolved = true;
    });
    expect(resolved).toBe(true);
    expect(log.info).not.toHaveBeenCalledWith('Draining in-flight dispatch work', expect.anything());
  });

  // -------------------------------------------------------------------------
  // Test 4c: handler-throws path — error is swallowed, set is still cleaned up
  // -------------------------------------------------------------------------
  it('removes work from the in-flight set when a handler throws (error is swallowed)', async () => {
    registerResponseHandler(async () => {
      throw new Error('handler exploded');
    });

    // dispatchResponse must NOT reject — doDispatchResponse catches handler errors.
    await expect(dispatchResponse(makePayload('q-throw'))).resolves.toBeUndefined();
    expect(log.error).toHaveBeenCalledWith(
      'Response handler threw',
      expect.objectContaining({ questionId: 'q-throw' }),
    );

    // Set must be empty (try/finally in dispatchResponse cleaned up).
    let resolved = false;
    await awaitDispatchDrain(1_000).then(() => {
      resolved = true;
    });
    expect(resolved).toBe(true);
    expect(log.info).not.toHaveBeenCalledWith('Draining in-flight dispatch work', expect.anything());
  });
});
