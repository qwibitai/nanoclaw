/**
 * Outbound action-dispatch + SIGTERM drain.
 *
 * `dispatchResponse` fans an action payload (button click, approval reply,
 * etc.) out to registered response handlers. The first handler that claims
 * the payload (returns true) wins; otherwise we log an `Unclaimed response`.
 *
 * Like routeInbound, dispatchResponse is invoked fire-and-forget from channel
 * adapter callbacks (`onAction` in src/index.ts). Without in-flight tracking,
 * a SIGTERM mid-dispatch would tear down the delivery pipeline before the
 * handler's outbound write reaches the channel — same dropped-reply class
 * of bug as nanoclaw-10y, but on the approval / button-press path.
 *
 * The fix mirrors src/router.ts:
 *   - module-level Set<Promise<void>> tracks in-flight dispatches
 *   - awaitDispatchDrain(timeoutMs) waits for the Set to settle, with timeout
 *   - the public dispatchResponse wraps the actual work in try/finally so the
 *     Set is cleaned up on both happy-path and rejection
 *
 * src/index.ts shutdown calls awaitDispatchDrain after awaitInboundDrain,
 * before stopDeliveryPolls / stopHostSweep / teardownChannelAdapters.
 *
 * See nanoclaw-10y for the inbound-drain rationale; this module covers the
 * sibling gap on the dispatch side.
 */

import { getResponseHandlers, type ResponsePayload } from './response-registry.js';
import { log } from './log.js';

// ---------------------------------------------------------------------------
// In-flight tracking — SIGTERM drain
// ---------------------------------------------------------------------------

/**
 * Set of Promises for all currently-executing dispatchResponse calls.
 *
 * Maintained by the dispatchResponse wrapper below. The shutdown handler in
 * src/index.ts calls awaitDispatchDrain() to wait for these to settle before
 * tearing down channel adapters, preventing dropped replies when SIGTERM
 * arrives mid-dispatch (e.g. user clicked an approval button just before
 * launchd restarted nanoclaw).
 */
const inFlightDispatches = new Set<Promise<void>>();

/**
 * Wait for all in-flight dispatchResponse calls to complete, with a timeout.
 * Used by the shutdown handler. Logs a warning if the timeout fires; never
 * throws.
 *
 * @param timeoutMs  Maximum milliseconds to wait. Default in index.ts is
 *                   30 000 ms (env var DISPATCH_DRAIN_TIMEOUT_MS).
 */
export async function awaitDispatchDrain(timeoutMs: number): Promise<void> {
  if (inFlightDispatches.size === 0) return;
  const startCount = inFlightDispatches.size;
  log.info('Draining in-flight dispatch work', { count: startCount, timeoutMs });
  const drained = Promise.allSettled([...inFlightDispatches]).then(() => 'drained' as const);
  const timeout = new Promise<'timeout'>((resolve) => {
    setTimeout(() => resolve('timeout'), timeoutMs);
  });
  const result = await Promise.race([drained, timeout]);
  if (result === 'timeout') {
    log.warn('Dispatch drain timed out; proceeding with shutdown', {
      remaining: inFlightDispatches.size,
      startCount,
      timeoutMs,
    });
  } else {
    log.info('Dispatch drain complete', { drained: startCount });
  }
}

/**
 * Test-only: reset the in-flight tracking set between test cases.
 * Do NOT call from production code.
 */
export function _resetDispatchTrackingForTests(): void {
  inFlightDispatches.clear();
}

// ---------------------------------------------------------------------------
// Public dispatchResponse — wraps doDispatchResponse with in-flight tracking
// ---------------------------------------------------------------------------

/**
 * Dispatch an action-response payload to registered handlers. The first
 * handler that claims the payload (returns true) wins; otherwise we log
 * an `Unclaimed response` warning.
 *
 * This is the public entry point. It wraps doDispatchResponse and registers
 * the work in inFlightDispatches so the shutdown drain can wait for it to
 * settle.
 */
export async function dispatchResponse(payload: ResponsePayload): Promise<void> {
  const work = doDispatchResponse(payload);
  inFlightDispatches.add(work);
  try {
    await work;
  } finally {
    inFlightDispatches.delete(work);
  }
}

async function doDispatchResponse(payload: ResponsePayload): Promise<void> {
  for (const handler of getResponseHandlers()) {
    try {
      const claimed = await handler(payload);
      if (claimed) return;
    } catch (err) {
      log.error('Response handler threw', { questionId: payload.questionId, err });
    }
  }
  log.warn('Unclaimed response', { questionId: payload.questionId, value: payload.value });
}
