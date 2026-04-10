/**
 * Sub-Agent Lifecycle Contract Tests
 *
 * Verifies five lifecycle contracts for the sub-agent dispatch system.
 * All tests are standalone — no live infrastructure (no AHQ, no database,
 * no containers).
 *
 * Contracts under test:
 *  1. Dispatch idempotency    — same research directive submitted twice produces
 *                               identical result structure
 *  2. Heartbeat interval      — sub-agent sends progress signal within
 *                               configurable interval
 *  3. Stall detection         — no heartbeat within 2× interval triggers
 *                               graceful abort
 *  4. Terminal state idempotency — marking a result done twice does not
 *                               duplicate entries
 *  5. Callback_handled_at guard — completion callback fires exactly once per
 *                               result
 *
 * Rollback criteria:
 *   No schema migrations are required — all state is held in-memory by the
 *   SubAgentResultStore and HeartbeatEmitter/StallDetector helpers defined
 *   below.
 *
 *   If a persistent sub_agent_results table is added in the future, the
 *   down migration is:
 *     DROP TABLE IF EXISTS dead_letter_results;
 *     DROP TABLE IF EXISTS sub_agent_results;
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  DeadLetterResult,
  HeartbeatSignal,
  ResearchDirective,
  SubAgentResult,
} from './types.js';

// ---------------------------------------------------------------------------
// In-memory implementations (test doubles — no live infra dependency)
// ---------------------------------------------------------------------------

/**
 * In-memory store for sub-agent results.
 *
 * Implements dispatch idempotency, terminal state idempotency, and the
 * callback_handled_at guard.
 */
class SubAgentResultStore {
  private results = new Map<string, SubAgentResult>(); // keyed by directive_id
  private callbacks = new Map<string, Array<(r: SubAgentResult) => void>>();
  private deadLetters: DeadLetterResult[] = [];

  /** Idempotent: returns the existing result if directive.id was seen before. */
  submitDirective(directive: ResearchDirective): SubAgentResult {
    const existing = this.results.get(directive.id);
    if (existing) return existing;

    const result: SubAgentResult = {
      id: `result-${directive.id}`,
      directive_id: directive.id,
      ahq_task_id: `ahq-${directive.id}`,
      status: 'pending',
      result_text: null,
      last_heartbeat_at: null,
      terminal_at: null,
      callback_handled_at: null,
      created_at: new Date().toISOString(),
    };
    this.results.set(directive.id, result);
    return result;
  }

  /** Record a heartbeat from the running sub-agent. */
  recordHeartbeat(directiveId: string, signal: HeartbeatSignal): void {
    const result = this.results.get(directiveId);
    if (!result) return;
    result.last_heartbeat_at = signal.sent_at;
    result.status = 'running';
  }

  /**
   * Mark a result as done. Idempotent: subsequent calls after the first
   * terminal transition are silently ignored.
   */
  markDone(directiveId: string, resultText: string): void {
    const result = this.results.get(directiveId);
    // Guard: skip if the result is already in a terminal state
    if (!result || result.terminal_at !== null) return;

    result.status = 'done';
    result.result_text = resultText;
    result.terminal_at = new Date().toISOString();

    // callback_handled_at guard: fire callbacks exactly once
    const cbs = this.callbacks.get(directiveId) ?? [];
    if (cbs.length > 0 && result.callback_handled_at === null) {
      result.callback_handled_at = new Date().toISOString();
      for (const cb of cbs) cb(result);
    }
  }

  /** Move a result to the dead-letter queue (e.g. stall or dispatch error). */
  sendToDeadLetter(
    directiveId: string,
    reason: DeadLetterResult['failure_reason'],
    error: string | null = null,
  ): void {
    const result = this.results.get(directiveId);
    if (!result || result.terminal_at !== null) return;

    const dlr: DeadLetterResult = {
      id: `dlr-${result.id}`,
      directive_id: result.directive_id,
      ahq_task_id: result.ahq_task_id,
      failure_reason: reason,
      failed_at: new Date().toISOString(),
      attempts: 1,
      last_error: error,
      context: null,
    };
    this.deadLetters.push(dlr);

    result.status = 'failed';
    result.terminal_at = new Date().toISOString();
  }

  onDone(directiveId: string, callback: (r: SubAgentResult) => void): void {
    const existing = this.callbacks.get(directiveId) ?? [];
    this.callbacks.set(directiveId, [...existing, callback]);
  }

  count(): number {
    return this.results.size;
  }

  getByDirectiveId(id: string): SubAgentResult | undefined {
    return this.results.get(id);
  }

  deadLetterCount(): number {
    return this.deadLetters.length;
  }

  getDeadLetters(): DeadLetterResult[] {
    return [...this.deadLetters];
  }
}

/**
 * Emits HeartbeatSignal objects on a fixed interval.
 * Backed by setInterval so it integrates with vi.useFakeTimers().
 */
class HeartbeatEmitter {
  private timer: ReturnType<typeof setInterval> | null = null;
  private handlers: Array<(s: HeartbeatSignal) => void> = [];

  constructor(private readonly opts: { intervalMs: number }) {}

  onSignal(handler: (s: HeartbeatSignal) => void): void {
    this.handlers.push(handler);
  }

  start(resultId: string): void {
    this.timer = setInterval(() => {
      const signal: HeartbeatSignal = {
        result_id: resultId,
        sent_at: new Date().toISOString(),
      };
      for (const h of this.handlers) h(signal);
    }, this.opts.intervalMs);
  }

  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}

/**
 * Detects stalled sub-agents and fires registered stall handlers.
 *
 * A stall is defined as no heartbeat received for ≥ 2 × intervalMs
 * milliseconds. Detection runs on a setInterval tick so it integrates
 * with vi.useFakeTimers().
 */
class StallDetector {
  private lastHeartbeatMs: number | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private stallHandlers: Array<() => void> = [];
  private stalled = false;

  constructor(private readonly opts: { intervalMs: number }) {}

  onStall(handler: () => void): void {
    this.stallHandlers.push(handler);
  }

  watch(_resultId: string, initialHeartbeatAt: string): void {
    this.lastHeartbeatMs = new Date(initialHeartbeatAt).getTime();
    const threshold = this.opts.intervalMs * 2;

    this.timer = setInterval(() => {
      if (this.stalled) return;
      const now = Date.now();
      const elapsed = now - (this.lastHeartbeatMs ?? now);
      if (elapsed >= threshold) {
        this.stalled = true;
        for (const h of this.stallHandlers) h();
        this.stop();
      }
    }, this.opts.intervalMs);
  }

  recordHeartbeat(signal: HeartbeatSignal): void {
    this.lastHeartbeatMs = new Date(signal.sent_at).getTime();
  }

  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}

// ---------------------------------------------------------------------------
// Shared test fixture helper
// ---------------------------------------------------------------------------

function makeDirective(
  id: string,
  prompt = 'analyze dependencies',
): ResearchDirective {
  return { id, prompt, submitted_at: new Date().toISOString() };
}

// ===========================================================================
// Contract 1: Dispatch idempotency
//
// Failure scenario: without an idempotency guard, submitting the same research
// directive twice creates two result records with different IDs. Downstream
// consumers then race to handle both, causing duplicate work and inconsistent
// callback counts.
// ===========================================================================
describe('Contract 1: dispatch idempotency', () => {
  it('same directive submitted twice returns the exact same result object', () => {
    const store = new SubAgentResultStore();
    const directive = makeDirective('dir-001');

    const r1 = store.submitDirective(directive);
    const r2 = store.submitDirective(directive);

    expect(r1).toBe(r2); // reference equality — same object
    expect(store.count()).toBe(1);
  });

  it('result structure is identical on both calls (same fields and values)', () => {
    const store = new SubAgentResultStore();
    const directive = makeDirective('dir-002');

    const r1 = store.submitDirective(directive);
    const r2 = store.submitDirective(directive);

    expect(Object.keys(r1).sort()).toEqual(Object.keys(r2).sort());
    expect(r1.id).toBe(r2.id);
    expect(r1.directive_id).toBe(r2.directive_id);
    expect(r1.ahq_task_id).toBe(r2.ahq_task_id);
    expect(r1.status).toBe(r2.status);
  });

  it('two distinct directives produce two separate result records', () => {
    const store = new SubAgentResultStore();

    store.submitDirective(makeDirective('dir-A'));
    store.submitDirective(makeDirective('dir-B'));

    expect(store.count()).toBe(2);
    expect(store.getByDirectiveId('dir-A')!.id).not.toBe(
      store.getByDirectiveId('dir-B')!.id,
    );
  });
});

// ===========================================================================
// Contract 2: Heartbeat interval
//
// Failure scenario: a sub-agent silently hangs (e.g., blocked on a network
// call) with no signal to the orchestrator. Without a mandatory heartbeat
// cadence, the stall detector has no reference point and cannot fire,
// leaving the dispatch slot occupied indefinitely.
// ===========================================================================
describe('Contract 2: heartbeat interval', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it('emits at least one heartbeat within the configured interval', () => {
    const store = new SubAgentResultStore();
    const directive = makeDirective('dir-hb-01');
    const result = store.submitDirective(directive);

    const emitter = new HeartbeatEmitter({ intervalMs: 1_000 });
    const captured: HeartbeatSignal[] = [];

    emitter.onSignal((s) => {
      captured.push(s);
      store.recordHeartbeat(directive.id, s);
    });
    emitter.start(result.id);

    vi.advanceTimersByTime(1_000);
    emitter.stop();

    expect(captured.length).toBeGreaterThanOrEqual(1);
    expect(captured[0].result_id).toBe(result.id);
    expect(captured[0].sent_at).toBeTruthy();
    expect(
      store.getByDirectiveId(directive.id)!.last_heartbeat_at,
    ).not.toBeNull();
  });

  it('emits multiple heartbeats at the expected cadence over several intervals', () => {
    const store = new SubAgentResultStore();
    const directive = makeDirective('dir-hb-02');
    const result = store.submitDirective(directive);

    const emitter = new HeartbeatEmitter({ intervalMs: 500 });
    let signalCount = 0;
    emitter.onSignal(() => {
      signalCount++;
    });
    emitter.start(result.id);

    vi.advanceTimersByTime(2_000); // four intervals of 500 ms
    emitter.stop();

    expect(signalCount).toBe(4);
  });
});

// ===========================================================================
// Contract 3: Stall detection
//
// Failure scenario: a sub-agent's heartbeat loop crashes mid-run. Without a
// stall detector, the slot stays 'executing' and the task never reaches a
// terminal state, starving the pool of one worker slot permanently.
// ===========================================================================
describe('Contract 3: stall detection', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it('triggers graceful abort when no heartbeat received within 2× interval', () => {
    const store = new SubAgentResultStore();
    const directive = makeDirective('dir-stall-01');
    const result = store.submitDirective(directive);

    const detector = new StallDetector({ intervalMs: 1_000 });
    let aborted = false;

    detector.onStall(() => {
      aborted = true;
      store.sendToDeadLetter(directive.id, 'stall', 'heartbeat timeout');
    });

    // Watch from current fake-time T=0; no heartbeats will arrive
    detector.watch(result.id, new Date().toISOString());

    // Advance exactly to the 2× threshold — stall check fires at T=2000ms
    vi.advanceTimersByTime(2_000);

    expect(aborted).toBe(true);
    expect(store.getByDirectiveId(directive.id)!.status).toBe('failed');
    expect(store.deadLetterCount()).toBe(1);
    expect(store.getDeadLetters()[0].failure_reason).toBe('stall');
    expect(store.getDeadLetters()[0].last_error).toBe('heartbeat timeout');
  });

  it('does not abort when heartbeats arrive within the stall window', () => {
    const store = new SubAgentResultStore();
    const directive = makeDirective('dir-stall-02');
    const result = store.submitDirective(directive);

    // Emitter fires every 800 ms; stall threshold is 2 × 1000 = 2000 ms
    // Each detector tick finds elapsed < 2000 ms because a heartbeat arrived
    const emitter = new HeartbeatEmitter({ intervalMs: 800 });
    const detector = new StallDetector({ intervalMs: 1_000 });
    let aborted = false;

    detector.onStall(() => {
      aborted = true;
    });

    emitter.onSignal((s) => {
      store.recordHeartbeat(directive.id, s);
      detector.recordHeartbeat(s);
    });

    detector.watch(result.id, new Date().toISOString());
    emitter.start(result.id);

    // Heartbeats at 800 ms, 1600 ms, 2400 ms — each resets the stall clock
    vi.advanceTimersByTime(3_000);

    emitter.stop();
    detector.stop();

    expect(aborted).toBe(false);
    expect(store.getByDirectiveId(directive.id)!.status).toBe('running');
    expect(store.deadLetterCount()).toBe(0);
  });
});

// ===========================================================================
// Contract 4: Terminal state idempotency
//
// Failure scenario: a network retry or race condition causes markDone to be
// called twice for the same result. Without an idempotency guard, the result
// record is overwritten (different result_text, a new terminal_at timestamp)
// and the callback fires a second time, producing duplicate downstream side
// effects.
// ===========================================================================
describe('Contract 4: terminal state idempotency', () => {
  it('marking a result done twice produces exactly one result record', () => {
    const store = new SubAgentResultStore();
    const directive = makeDirective('dir-term-01');
    store.submitDirective(directive);

    store.markDone(directive.id, 'first call output');
    store.markDone(directive.id, 'second call output'); // must be a no-op

    expect(store.count()).toBe(1);
    expect(store.getByDirectiveId(directive.id)!.result_text).toBe(
      'first call output',
    );
    expect(store.getByDirectiveId(directive.id)!.status).toBe('done');
  });

  it('terminal_at is set exactly once, on the first done call', () => {
    const store = new SubAgentResultStore();
    const directive = makeDirective('dir-term-02');
    store.submitDirective(directive);

    store.markDone(directive.id, 'output');
    const t1 = store.getByDirectiveId(directive.id)!.terminal_at;

    store.markDone(directive.id, 'output again');
    const t2 = store.getByDirectiveId(directive.id)!.terminal_at;

    expect(t1).not.toBeNull();
    expect(t1).toBe(t2); // unchanged on second call
  });

  it('markDone after a stall/failure transition is a no-op', () => {
    const store = new SubAgentResultStore();
    const directive = makeDirective('dir-term-03');
    store.submitDirective(directive);

    // Stall moves the result to 'failed'
    store.sendToDeadLetter(directive.id, 'stall');
    expect(store.getByDirectiveId(directive.id)!.status).toBe('failed');

    // A late markDone must not flip the status
    store.markDone(directive.id, 'late output');

    expect(store.getByDirectiveId(directive.id)!.status).toBe('failed');
    expect(store.count()).toBe(1);
  });
});

// ===========================================================================
// Contract 5: Callback_handled_at guard
//
// Failure scenario: the completion callback triggers a paid third-party API
// call. Without the callback_handled_at guard, a duplicate markDone (from a
// network retry) fires the callback a second time, charging the API twice and
// producing duplicate entries in downstream systems.
// ===========================================================================
describe('Contract 5: callback_handled_at guard', () => {
  it('completion callback fires exactly once per result', () => {
    const store = new SubAgentResultStore();
    const directive = makeDirective('dir-cb-01');
    store.submitDirective(directive);

    const callbackSpy = vi.fn();
    store.onDone(directive.id, callbackSpy);

    store.markDone(directive.id, 'result text');
    store.markDone(directive.id, 'result text again'); // must not re-fire

    expect(callbackSpy).toHaveBeenCalledTimes(1);
  });

  it('callback_handled_at is null before done and non-null after the first done call', () => {
    const store = new SubAgentResultStore();
    const directive = makeDirective('dir-cb-02');
    store.submitDirective(directive);

    store.onDone(directive.id, vi.fn());

    expect(
      store.getByDirectiveId(directive.id)!.callback_handled_at,
    ).toBeNull();

    store.markDone(directive.id, 'output');

    expect(
      store.getByDirectiveId(directive.id)!.callback_handled_at,
    ).not.toBeNull();
  });

  it('callback_handled_at remains unchanged on subsequent markDone calls', () => {
    const store = new SubAgentResultStore();
    const directive = makeDirective('dir-cb-03');
    store.submitDirective(directive);

    store.onDone(directive.id, vi.fn());

    store.markDone(directive.id, 'output');
    const t1 = store.getByDirectiveId(directive.id)!.callback_handled_at;

    store.markDone(directive.id, 'output again');
    const t2 = store.getByDirectiveId(directive.id)!.callback_handled_at;

    expect(t1).toBe(t2);
  });

  it('no callback registered — callback_handled_at remains null after done', () => {
    const store = new SubAgentResultStore();
    const directive = makeDirective('dir-cb-04');
    store.submitDirective(directive);

    store.markDone(directive.id, 'output');

    // No onDone registered → callback_handled_at stays null
    expect(
      store.getByDirectiveId(directive.id)!.callback_handled_at,
    ).toBeNull();
  });
});
