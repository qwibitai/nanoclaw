/**
 * Tests for the SIGTERM-drain functionality introduced in router.ts.
 *
 * These tests verify that:
 *   1. awaitInboundDrain returns immediately when nothing is in flight.
 *   2. awaitInboundDrain waits for an in-flight routeInbound call to settle.
 *   3. awaitInboundDrain returns after timeoutMs when in-flight work hangs,
 *      and logs a warning (timeout path). Uses fake timers so tests are
 *      deterministic and do not wall-clock-wait.
 *   4. routeInbound correctly adds/removes from the in-flight set on both the
 *      happy path (completes normally) and the error path (throws).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Module mocks — must be declared before any imports from the mocked modules.
// We mock everything routeInbound's body touches so we can invoke the real
// entry point without a live database or container runtime.
// ---------------------------------------------------------------------------

vi.mock('./log.js', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('./db/messaging-groups.js', () => ({
  getMessagingGroupWithAgentCount: vi.fn(() => null),
  getMessagingGroupAgents: vi.fn(() => []),
  createMessagingGroup: vi.fn(),
}));

vi.mock('./db/agent-groups.js', () => ({
  getAgentGroup: vi.fn(() => null),
}));

vi.mock('./db/dropped-messages.js', () => ({
  recordDroppedMessage: vi.fn(),
}));

vi.mock('./db/sessions.js', () => ({
  findSessionForAgent: vi.fn(() => undefined),
  getSession: vi.fn(() => null),
}));

vi.mock('./session-manager.js', () => ({
  resolveSession: vi.fn(() => ({ id: 'sess-test', agent_group_id: 'ag-test' })),
  writeSessionMessage: vi.fn(),
  writeOutboundDirect: vi.fn(),
}));

vi.mock('./container-runner.js', () => ({
  wakeContainer: vi.fn(async () => true),
}));

vi.mock('./modules/typing/index.js', () => ({
  startTypingRefresh: vi.fn(),
  stopTypingRefresh: vi.fn(),
}));

vi.mock('./channels/channel-registry.js', () => ({
  getChannelAdapter: vi.fn(() => null),
}));

vi.mock('./command-gate.js', () => ({
  gateCommand: vi.fn(() => ({ action: 'pass' })),
}));

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import { log } from './log.js';
import { routeInbound, awaitInboundDrain, setMessageInterceptor, _resetInboundTrackingForTests } from './router.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a minimal non-mention inbound event. */
function makeEvent(text = 'hello'): Parameters<typeof routeInbound>[0] {
  return {
    channelType: 'test',
    platformId: 'plat-1',
    threadId: null,
    message: {
      id: 'msg-test',
      kind: 'chat',
      content: JSON.stringify({ text }),
      timestamp: '2026-05-09T04:18:00Z',
      isMention: false,
      isGroup: false,
    },
  };
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('awaitInboundDrain', () => {
  beforeEach(() => {
    _resetInboundTrackingForTests();
    vi.clearAllMocks();
    // Reset the interceptor to a benign no-op so each test starts clean.
    // doRouteInbound checks the interceptor first — returning false lets it
    // fall through to the early-return path (non-mention + no mg row).
    setMessageInterceptor(async () => false);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // -------------------------------------------------------------------------
  // Test 1: empty drain
  // -------------------------------------------------------------------------
  it('returns immediately when no inbound is in flight', async () => {
    // No routeInbound calls have been made — set should be empty.
    await expect(awaitInboundDrain(5_000)).resolves.toBeUndefined();
    // Nothing to log about
    expect(log.info).not.toHaveBeenCalledWith('Draining in-flight inbound work', expect.anything());
  });

  // -------------------------------------------------------------------------
  // Test 2: drain waits for in-flight work to settle
  // -------------------------------------------------------------------------
  it('waits for an in-flight routeInbound call to settle before resolving', async () => {
    // Install a hanging interceptor so doRouteInbound blocks until we resolve it.
    let resolveHang!: () => void;
    const hangUntilReleased = new Promise<void>((r) => {
      resolveHang = r;
    });
    setMessageInterceptor(async () => {
      await hangUntilReleased;
      return true; // consume — prevents further routing work
    });

    // Fire routeInbound without awaiting — puts the work in-flight.
    const inboundDone = routeInbound(makeEvent());

    // Yield to let doRouteInbound start executing and hit the interceptor await.
    await Promise.resolve();

    // Start draining — should NOT resolve yet because work is still in-flight.
    let drainSettled = false;
    const drainPromise = awaitInboundDrain(10_000).then(() => {
      drainSettled = true;
    });

    // Drain hasn't settled yet.
    await Promise.resolve();
    expect(drainSettled).toBe(false);

    // Release the hanging work.
    resolveHang();

    // Now await both to completion.
    await Promise.all([inboundDone, drainPromise]);
    expect(drainSettled).toBe(true);
    expect(log.info).toHaveBeenCalledWith('Inbound drain complete', expect.any(Object));
    expect(log.warn).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Test 3: timeout path (fake timers)
  // -------------------------------------------------------------------------
  it('resolves after timeoutMs when in-flight work hangs, and logs a warning', async () => {
    vi.useFakeTimers();

    // Install a permanently-hanging interceptor.
    setMessageInterceptor(async () => {
      await new Promise<void>(() => {
        /* never resolves */
      });
      return true;
    });

    // Fire routeInbound without awaiting.
    routeInbound(makeEvent());

    // Yield so doRouteInbound starts and the work is registered in-flight.
    await Promise.resolve();

    // Start drain with a 5 s timeout.
    const drainPromise = awaitInboundDrain(5_000);

    // Advance fake clock past the timeout (+ 1 ms slack).
    await vi.advanceTimersByTimeAsync(5_001);

    // Drain should now resolve (via the timeout branch).
    await drainPromise;

    expect(log.warn).toHaveBeenCalledWith(
      'Inbound drain timed out; proceeding with shutdown',
      expect.objectContaining({ timeoutMs: 5_000 }),
    );
  });

  // -------------------------------------------------------------------------
  // Test 4a: happy path — set is empty after routeInbound completes normally
  // -------------------------------------------------------------------------
  it('removes work from the in-flight set when routeInbound completes normally', async () => {
    // Default no-op interceptor (set in beforeEach) returns false quickly.
    // getMessagingGroupWithAgentCount is mocked to return null, and the event
    // is not a mention, so doRouteInbound returns early via the fast path.

    await routeInbound(makeEvent());

    // Drain should return immediately — set is empty.
    let resolved = false;
    await awaitInboundDrain(1_000).then(() => {
      resolved = true;
    });
    expect(resolved).toBe(true);
    // No "Draining…" log since set was already empty.
    expect(log.info).not.toHaveBeenCalledWith('Draining in-flight inbound work', expect.anything());
  });

  // -------------------------------------------------------------------------
  // Test 4b: error path — set is empty even when routeInbound throws
  // -------------------------------------------------------------------------
  it('removes work from the in-flight set when routeInbound rejects', async () => {
    // Install an interceptor that throws.
    setMessageInterceptor(async () => {
      throw new Error('interceptor exploded');
    });

    // routeInbound should reject (re-throws from doRouteInbound).
    await expect(routeInbound(makeEvent())).rejects.toThrow('interceptor exploded');

    // Despite the rejection, the finally block in routeInbound must have
    // cleaned up inFlightInbounds. Drain resolves immediately.
    let resolved = false;
    await awaitInboundDrain(1_000).then(() => {
      resolved = true;
    });
    expect(resolved).toBe(true);
    expect(log.info).not.toHaveBeenCalledWith('Draining in-flight inbound work', expect.anything());
  });
});
