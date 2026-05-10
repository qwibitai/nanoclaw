/**
 * Unit tests for the stuck-container decision logic introduced by
 * ACTION-ITEMS item 9. Lives on the pure helper `decideStuckAction` so we
 * don't have to mock the filesystem or the container runner.
 *
 * Also contains C3 watchdog integration tests.
 */
import Database from 'better-sqlite3';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

import { deleteOrphanProcessingClaims, getProcessingClaims } from './db/session-db.js';
import {
  ABSOLUTE_CEILING_MS,
  CLAIM_STUCK_MS,
  SPAWN_GRACE_MS,
  _resetStuckProcessingRowsForTesting,
  _sweepTaskWatchdogForTesting,
  decideStuckAction,
  parseSqliteUtc,
} from './host-sweep.js';
import type { Session } from './types.js';

// ─── Module mocks for C3 watchdog integration tests ──────────────────────────
// These mocks are hoisted and only affect tests that use them. The existing
// decideStuckAction / resetStuckProcessingRows tests are pure and don't invoke
// these imports, so they are unaffected.

const mockGetActiveTasks = vi.fn();
const mockTransitionToTerminal = vi.fn();
const mockGetCapabilityConfig = vi.fn();
const mockPendingTerminalDispatchOutboundSeenAt = vi.fn();
const mockWriteSessionMessage = vi.fn();
const mockWakeContainer = vi.fn();
const mockIsContainerRunning = vi.fn();
const mockGetSession = vi.fn();
const mockRunReconcilerSweep = vi.fn();

vi.mock('./modules/orchestrator-dispatch/db/tasks.js', () => ({
  getActiveTasks: (...args: unknown[]) => mockGetActiveTasks(...args),
  transitionToTerminal: (...args: unknown[]) => mockTransitionToTerminal(...args),
  getOrphanedTasks: vi.fn().mockReturnValue([]),
}));

vi.mock('./modules/orchestrator-dispatch/db/agent-group-capabilities.js', () => ({
  getCapabilityConfig: (...args: unknown[]) => mockGetCapabilityConfig(...args),
}));

vi.mock('./modules/orchestrator-dispatch/watchdog.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('./modules/orchestrator-dispatch/watchdog.js')>();
  return {
    ...real,
    pendingTerminalDispatchOutboundSeenAt: (...args: unknown[]) =>
      mockPendingTerminalDispatchOutboundSeenAt(...args),
  };
});

vi.mock('./session-manager.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('./session-manager.js')>();
  return {
    ...real,
    writeSessionMessage: (...args: unknown[]) => mockWriteSessionMessage(...args),
    outboundDbPath: real.outboundDbPath,
  };
});

vi.mock('./container-runner.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('./container-runner.js')>();
  return {
    ...real,
    isContainerRunning: (...args: unknown[]) => mockIsContainerRunning(...args),
    wakeContainer: (...args: unknown[]) => mockWakeContainer(...args),
  };
});

vi.mock('./db/sessions.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('./db/sessions.js')>();
  return {
    ...real,
    getSession: (...args: unknown[]) => mockGetSession(...args),
  };
});

vi.mock('./modules/orchestrator-dispatch/reconciler.js', () => ({
  runReconcilerSweep: () => mockRunReconcilerSweep(),
  runReconcilerOnStartup: vi.fn(),
}));

const BASE = Date.parse('2026-04-20T12:00:00.000Z');

function claim(id: string, offsetMs: number) {
  return { message_id: id, status_changed: new Date(BASE - offsetMs).toISOString() };
}

describe('decideStuckAction', () => {
  it('returns ok when heartbeat is fresh and no claims', () => {
    expect(
      decideStuckAction({
        now: BASE,
        heartbeatMtimeMs: BASE - 5_000,
        containerState: null,
        claims: [],
      }),
    ).toEqual({ action: 'ok' });
  });

  it('returns kill-ceiling when heartbeat older than 30 min', () => {
    const heartbeatMtimeMs = BASE - ABSOLUTE_CEILING_MS - 1_000;
    const res = decideStuckAction({
      now: BASE,
      heartbeatMtimeMs,
      containerState: null,
      claims: [],
    });
    expect(res.action).toBe('kill-ceiling');
    if (res.action !== 'kill-ceiling') return;
    expect(res.ceilingMs).toBe(ABSOLUTE_CEILING_MS);
    expect(res.heartbeatAgeMs).toBeGreaterThan(ABSOLUTE_CEILING_MS);
  });

  it('skips the ceiling check when no heartbeat file exists (fresh container not yet ticked)', () => {
    // A freshly-spawned container hasn't produced any SDK events yet, so no
    // heartbeat. Prior behavior treated this as infinitely stale and killed
    // every container within seconds of spawn. With no claims either, we
    // should conclude everything is fine.
    const res = decideStuckAction({
      now: BASE,
      heartbeatMtimeMs: 0,
      containerState: null,
      claims: [],
    });
    expect(res.action).toBe('ok');
  });

  it('kills on claim-stuck when heartbeat is absent AND a claim has aged past tolerance', () => {
    // Hanging fresh container: spawned, picked up a message (claim recorded
    // in processing_ack), but never wrote a heartbeat. Falls through the
    // skipped ceiling check into claim-stuck — which correctly fires.
    const claimedAgeMs = CLAIM_STUCK_MS + 5_000;
    const res = decideStuckAction({
      now: BASE,
      heartbeatMtimeMs: 0,
      containerState: null,
      claims: [claim('msg-1', claimedAgeMs)],
    });
    expect(res.action).toBe('kill-claim');
  });

  it('extends the ceiling when Bash has a declared timeout longer than 30 min', () => {
    const twoHrMs = 2 * 60 * 60 * 1000;
    const res = decideStuckAction({
      now: BASE,
      // 45 min — over the default ceiling, but under the Bash timeout
      heartbeatMtimeMs: BASE - 45 * 60 * 1000,
      containerState: {
        current_tool: 'Bash',
        tool_declared_timeout_ms: twoHrMs,
        tool_started_at: new Date(BASE - 45 * 60 * 1000).toISOString(),
      },
      claims: [],
    });
    expect(res.action).toBe('ok');
  });

  it('returns kill-claim when a claim is past 60s and heartbeat has not moved', () => {
    const claimedAgeMs = CLAIM_STUCK_MS + 10_000;
    const res = decideStuckAction({
      now: BASE,
      heartbeatMtimeMs: BASE - claimedAgeMs - 5_000, // older than the claim
      containerState: null,
      claims: [claim('msg-1', claimedAgeMs)],
    });
    expect(res.action).toBe('kill-claim');
    if (res.action !== 'kill-claim') return;
    expect(res.messageId).toBe('msg-1');
    expect(res.toleranceMs).toBe(CLAIM_STUCK_MS);
  });

  it('does not kill when heartbeat has been touched since the claim', () => {
    const claimedAgeMs = CLAIM_STUCK_MS + 10_000;
    const res = decideStuckAction({
      now: BASE,
      heartbeatMtimeMs: BASE - 2_000, // fresh, updated after the claim
      containerState: null,
      claims: [claim('msg-1', claimedAgeMs)],
    });
    expect(res.action).toBe('ok');
  });

  it('does not kill when claim age is below tolerance', () => {
    const res = decideStuckAction({
      now: BASE,
      heartbeatMtimeMs: BASE - CLAIM_STUCK_MS - 10_000, // old, but claim is recent
      containerState: null,
      claims: [claim('msg-1', 5_000)],
    });
    expect(res.action).toBe('ok');
  });

  it('widens per-claim tolerance for a running Bash with long timeout', () => {
    const tenMinMs = 10 * 60 * 1000;
    const res = decideStuckAction({
      now: BASE,
      // 5 min since claim, over the 60s default but under the declared Bash timeout
      heartbeatMtimeMs: BASE - 5 * 60 * 1000 - 5_000,
      containerState: {
        current_tool: 'Bash',
        tool_declared_timeout_ms: tenMinMs,
        tool_started_at: new Date(BASE - 5 * 60 * 1000).toISOString(),
      },
      claims: [claim('msg-1', 5 * 60 * 1000)],
    });
    expect(res.action).toBe('ok');
  });

  it('ignores claims with unparseable timestamps', () => {
    const res = decideStuckAction({
      now: BASE,
      heartbeatMtimeMs: BASE - 5_000,
      containerState: null,
      claims: [{ message_id: 'x', status_changed: 'not-a-date' }],
    });
    expect(res.action).toBe('ok');
  });

  it('does not kill a fresh container for a claim made before it spawned', () => {
    // Pre-existing claim from a long-dead prior container; new one just
    // spawned and hasn't reached its agent-runner startup cleanup hook
    // yet. Without the grace window, every recovery attempt would be
    // killed within ms of spawn — the deadlock that stranded the
    // plugin-updater session for 4 days post-cutover.
    const res = decideStuckAction({
      now: BASE,
      heartbeatMtimeMs: 0, // fresh container, no heartbeat yet
      containerState: null,
      claims: [claim('msg-stale', CLAIM_STUCK_MS + 10_000 + SPAWN_GRACE_MS)],
      spawnedAtMs: BASE - 10_000, // spawned 10s ago, well within grace
    });
    expect(res.action).toBe('ok');
  });

  it('still kills for a fresh-container claim that aged past tolerance during the grace window', () => {
    // Claim was made AFTER spawn (so it's the current container's own work)
    // and has aged past tolerance with no heartbeat. The grace window only
    // covers pre-existing claims, not new ones produced by the live
    // container — those still need to be enforced normally.
    const claimedAgeMs = CLAIM_STUCK_MS + 5_000;
    const spawnedAtMs = BASE - claimedAgeMs - 1_000; // spawn predates the claim
    const res = decideStuckAction({
      now: BASE,
      heartbeatMtimeMs: 0,
      containerState: null,
      claims: [claim('msg-1', claimedAgeMs)],
      spawnedAtMs,
    });
    expect(res.action).toBe('kill-claim');
  });

  it('kills for a pre-existing claim once the grace window has elapsed', () => {
    // Container spawned > SPAWN_GRACE_MS ago and the stale claim is still
    // there — startup cleanup either failed to run or didn't cover this
    // row. After the grace window, the kill path runs as before so a
    // permanently-broken container can't camp on a session forever.
    const res = decideStuckAction({
      now: BASE,
      heartbeatMtimeMs: 0,
      containerState: null,
      claims: [claim('msg-stale', CLAIM_STUCK_MS + 10_000 + SPAWN_GRACE_MS)],
      spawnedAtMs: BASE - SPAWN_GRACE_MS - 5_000,
    });
    expect(res.action).toBe('kill-claim');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Orphan claim cleanup (regression test for the SIGKILL → claim-stuck loop)
//
// Repro of the production bug seen 2026-04-30: container A claimed message M
// (writes processing_ack row with status='processing'). Host kills A by
// absolute-ceiling. Old behavior: messages_in.M was reset to pending but
// processing_ack.M survived. On the next sweep tick, wakeContainer spawned B,
// the same-tick SLA check saw M's stale claim age (hours), and SIGKILL'd B
// before agent-runner could run clearStaleProcessingAcks(). Loop. The fix
// deletes processing_ack 'processing' rows when the host kills/cleans the
// container, breaking the loop atomically.
// ─────────────────────────────────────────────────────────────────────────────

function makeSessionDbs(): { inDb: Database.Database; outDb: Database.Database } {
  const inDb = new Database(':memory:');
  inDb.exec(`
    CREATE TABLE messages_in (
      id            TEXT PRIMARY KEY,
      seq           INTEGER UNIQUE,
      kind          TEXT NOT NULL,
      timestamp     TEXT NOT NULL,
      status        TEXT DEFAULT 'pending',
      process_after TEXT,
      recurrence    TEXT,
      series_id     TEXT,
      tries         INTEGER DEFAULT 0,
      trigger       INTEGER NOT NULL DEFAULT 1,
      platform_id   TEXT,
      channel_type  TEXT,
      thread_id     TEXT,
      content       TEXT NOT NULL
    );
  `);
  const outDb = new Database(':memory:');
  outDb.exec(`
    CREATE TABLE processing_ack (
      message_id     TEXT PRIMARY KEY,
      status         TEXT NOT NULL,
      status_changed TEXT NOT NULL
    );
    CREATE TABLE messages_out (
      id          TEXT PRIMARY KEY,
      seq         INTEGER UNIQUE,
      in_reply_to TEXT,
      timestamp   TEXT NOT NULL,
      kind        TEXT NOT NULL,
      content     TEXT NOT NULL
    );
  `);
  return { inDb, outDb };
}

function fakeSession(): Session {
  return {
    id: 'sess-test',
    agent_group_id: 'ag-test',
    messaging_group_id: null,
    thread_id: null,
    agent_provider: null,
    status: 'active',
    container_status: 'stopped',
    last_active: null,
    created_at: new Date().toISOString(),
  };
}

describe('deleteOrphanProcessingClaims', () => {
  it('removes only processing rows, leaves completed/failed alone', () => {
    const { outDb } = makeSessionDbs();
    const ts = new Date().toISOString();
    outDb.prepare("INSERT INTO processing_ack VALUES ('m-proc', 'processing', ?)").run(ts);
    outDb.prepare("INSERT INTO processing_ack VALUES ('m-done', 'completed', ?)").run(ts);
    outDb.prepare("INSERT INTO processing_ack VALUES ('m-fail', 'failed', ?)").run(ts);

    const removed = deleteOrphanProcessingClaims(outDb);

    expect(removed).toBe(1);
    const remaining = outDb.prepare('SELECT message_id, status FROM processing_ack ORDER BY message_id').all();
    expect(remaining).toEqual([
      { message_id: 'm-done', status: 'completed' },
      { message_id: 'm-fail', status: 'failed' },
    ]);
  });

  it('returns 0 when nothing to clear', () => {
    const { outDb } = makeSessionDbs();
    expect(deleteOrphanProcessingClaims(outDb)).toBe(0);
  });
});

describe('resetStuckProcessingRows — orphan claim cleanup', () => {
  it('deletes orphan processing_ack rows so next sweep tick does not see them', () => {
    const { inDb, outDb } = makeSessionDbs();
    const claimedAt = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(); // 2h ago

    // messages_in.status stays 'pending' during processing — only the
    // container's processing_ack moves to 'processing'. See
    // src/db/schema.ts header comment on processing_ack.
    inDb
      .prepare(
        "INSERT INTO messages_in (id, seq, kind, timestamp, status, content) VALUES ('m-1', 1, 'chat', ?, 'pending', '{}')",
      )
      .run(claimedAt);
    outDb.prepare("INSERT INTO processing_ack VALUES ('m-1', 'processing', ?)").run(claimedAt);

    // Sanity: the orphan claim is what would trip claim-stuck.
    expect(getProcessingClaims(outDb)).toHaveLength(1);

    _resetStuckProcessingRowsForTesting(inDb, outDb, fakeSession(), 'absolute-ceiling');

    // Regression assertion: orphan claim is gone — next sweep tick will see
    // an empty claims list and not kill the freshly respawned container.
    expect(getProcessingClaims(outDb)).toEqual([]);

    // And the message itself was rescheduled with backoff (existing behavior).
    const row = inDb.prepare('SELECT status, tries, process_after FROM messages_in WHERE id = ?').get('m-1') as {
      status: string;
      tries: number;
      process_after: string | null;
    };
    expect(row.status).toBe('pending');
    expect(row.tries).toBe(1);
    expect(row.process_after).not.toBeNull();
  });

  it('still clears orphan claims even when the inbound message has already been retried (skip path)', () => {
    // Edge case: the inbound row was already rescheduled (process_after in
    // future), so the per-message retry loop skips it. The orphan in
    // processing_ack must still be removed — otherwise the bug remains.
    const { inDb, outDb } = makeSessionDbs();
    const claimedAt = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    const future = new Date(Date.now() + 60_000).toISOString();

    inDb
      .prepare(
        "INSERT INTO messages_in (id, seq, kind, timestamp, status, process_after, tries, content) VALUES ('m-2', 2, 'chat', ?, 'pending', ?, 1, '{}')",
      )
      .run(claimedAt, future);
    outDb.prepare("INSERT INTO processing_ack VALUES ('m-2', 'processing', ?)").run(claimedAt);

    _resetStuckProcessingRowsForTesting(inDb, outDb, fakeSession(), 'claim-stuck');

    expect(getProcessingClaims(outDb)).toEqual([]);
    const row = inDb.prepare('SELECT tries FROM messages_in WHERE id = ?').get('m-2') as { tries: number };
    expect(row.tries).toBe(1); // not bumped, the skip path held
  });
});

describe('parseSqliteUtc', () => {
  // Regression: SQLite TIMESTAMP strings have no zone marker, but Date.parse
  // treats those as local time. On non-UTC hosts this made every claim look
  // (TZ offset) hours stale and tripped kill-claim on freshly-claimed messages.
  // The helper appends "Z" only when no marker is present, so parsing is
  // always anchored to UTC regardless of host timezone.

  const utcMs = Date.parse('2026-04-20T12:00:00.000Z');

  it('treats a SQLite-style timestamp (no zone) as UTC', () => {
    expect(parseSqliteUtc('2026-04-20 12:00:00')).toBe(utcMs);
    expect(parseSqliteUtc('2026-04-20T12:00:00')).toBe(utcMs);
    expect(parseSqliteUtc('2026-04-20T12:00:00.000')).toBe(utcMs);
  });

  it('preserves an explicit Z marker', () => {
    expect(parseSqliteUtc('2026-04-20T12:00:00.000Z')).toBe(utcMs);
    expect(parseSqliteUtc('2026-04-20T12:00:00z')).toBe(utcMs);
  });

  it('preserves an explicit numeric offset', () => {
    // 14:00+02:00 == 12:00 UTC
    expect(parseSqliteUtc('2026-04-20T14:00:00+02:00')).toBe(utcMs);
    expect(parseSqliteUtc('2026-04-20T14:00:00+0200')).toBe(utcMs);
    // 07:00-05:00 == 12:00 UTC
    expect(parseSqliteUtc('2026-04-20T07:00:00-05:00')).toBe(utcMs);
  });

  it('returns NaN for unparseable input', () => {
    expect(Number.isNaN(parseSqliteUtc('not a date'))).toBe(true);
  });

  it('does not drift across host timezones for SQLite-style input', () => {
    // The helper itself is timezone-independent because it forces UTC parsing.
    // (Verifying the regex branch — without the helper, `Date.parse` of the
    // bare string returns different values depending on the host TZ.)
    const bare = '2026-04-20T12:00:00';
    expect(parseSqliteUtc(bare)).toBe(Date.parse(bare + 'Z'));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// C3: Task watchdog integration tests
//
// Tests the sweepTaskWatchdog() pass that runs after the per-session sweep loop.
// Uses vi.mock (hoisted at top of file) to intercept DB and container calls.
// ─────────────────────────────────────────────────────────────────────────────

const NOW = Date.parse('2026-04-20T12:00:00.000Z');

function makeTask(overrides: Partial<{
  task_id: string;
  parent_session_id: string;
  parent_agent_group_id: string;
  child_session_id: string | null;
  status: 'pending' | 'running';
  admitted_at: string;
  started_at: string | null;
  last_progress_at: string | null;
  deadline: string | null;
}> = {}) {
  return {
    task_id: 'task-watchdog-1',
    idempotency_key: 'idem-w1',
    parent_session_id: 'parent-sess',
    parent_agent_group_id: 'parent-ag',
    parent_messaging_group_id: null,
    target_agent_group_id: 'target-ag',
    child_session_id: 'child-sess',
    status: 'running' as const,
    task_content: '{}',
    request_hash: 'hash',
    deadline: null,
    parent_platform_message_id: null,
    child_platform_thread_id: null,
    child_messaging_group_id: null,
    admitted_at: new Date(NOW - 10 * 60 * 1000).toISOString(),
    started_at: new Date(NOW - 9 * 60 * 1000).toISOString(),
    completed_at: null,
    failed_at: null,
    cancelled_at: null,
    last_progress_at: new Date(NOW - 2 * 60 * 1000).toISOString(),
    last_progress_message: null,
    fail_reason: null,
    result_summary: null,
    dispatch_completion_attempts: 0,
    completion_lease_at: null,
    surface_mode: 'headless' as const,
    created_at: new Date(NOW - 10 * 60 * 1000).toISOString(),
    ...overrides,
  };
}

function fakeParentSession() {
  return {
    id: 'parent-sess',
    agent_group_id: 'parent-ag',
    messaging_group_id: null,
    thread_id: null,
    agent_provider: null,
    status: 'active' as const,
    container_status: 'running' as const,
    last_active: null,
    created_at: new Date().toISOString(),
  };
}

describe('sweepTaskWatchdog (C3)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetSession.mockReturnValue(fakeParentSession());
    mockIsContainerRunning.mockReturnValue(true);
    mockWakeContainer.mockResolvedValue(true);
    mockWriteSessionMessage.mockResolvedValue(undefined);
    mockGetCapabilityConfig.mockReturnValue(null); // use defaults
    mockPendingTerminalDispatchOutboundSeenAt.mockReturnValue(null);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('test_watchdog_terminates_no_progress_task: reaped task gets failed + parent notified', async () => {
    const task = makeTask({
      last_progress_at: new Date(NOW - 2 * 60 * 60 * 1000).toISOString(), // 2 hours ago — past 30 min default
    });
    mockGetActiveTasks.mockReturnValue([task]);
    mockTransitionToTerminal.mockReturnValue(true);

    vi.useFakeTimers();
    vi.setSystemTime(NOW);

    await _sweepTaskWatchdogForTesting();

    expect(mockTransitionToTerminal).toHaveBeenCalledWith(
      task.task_id,
      'failed',
      expect.objectContaining({ fail_reason: 'no_progress_timeout' }),
    );
    expect(mockWriteSessionMessage).toHaveBeenCalledWith(
      task.parent_agent_group_id,
      task.parent_session_id,
      expect.objectContaining({ kind: 'system' }),
    );
    expect(mockWakeContainer).toHaveBeenCalled();
  });

  it('test_watchdog_skips_when_drain_active: task with recent terminal outbound is not reaped', async () => {
    const task = makeTask({
      last_progress_at: new Date(NOW - 2 * 60 * 60 * 1000).toISOString(), // 2 hours ago
    });
    // Drain guard: terminal action seen 30s ago, within 120s grace
    mockPendingTerminalDispatchOutboundSeenAt.mockReturnValue(new Date(NOW - 30 * 1000).toISOString());
    mockGetActiveTasks.mockReturnValue([task]);

    vi.useFakeTimers();
    vi.setSystemTime(NOW);

    await _sweepTaskWatchdogForTesting();

    expect(mockTransitionToTerminal).not.toHaveBeenCalled();
    expect(mockWriteSessionMessage).not.toHaveBeenCalled();
  });

  it('CAS guard: 0-rows transitionToTerminal skips parent notification', async () => {
    const task = makeTask({
      last_progress_at: new Date(NOW - 2 * 60 * 60 * 1000).toISOString(),
    });
    mockGetActiveTasks.mockReturnValue([task]);
    mockTransitionToTerminal.mockReturnValue(false); // CAS failed — already terminal

    vi.useFakeTimers();
    vi.setSystemTime(NOW);

    await _sweepTaskWatchdogForTesting();

    expect(mockTransitionToTerminal).toHaveBeenCalled();
    expect(mockWriteSessionMessage).not.toHaveBeenCalled();
  });

  it('test_one_task_failure_doesnt_skip_others: error in one task does not prevent processing others', async () => {
    // Both tasks have stale progress — both should trigger transitionToTerminal.
    // The first call throws (simulates a corrupt task failing mid-reap).
    const badTask = makeTask({
      task_id: 'bad-task',
      last_progress_at: new Date(NOW - 2 * 60 * 60 * 1000).toISOString(), // stale — triggers reap
    });
    const goodTask = makeTask({
      task_id: 'good-task',
      last_progress_at: new Date(NOW - 2 * 60 * 60 * 1000).toISOString(), // stale — should also be reaped
    });
    mockGetActiveTasks.mockReturnValue([badTask, goodTask]);
    // First call (bad task) — throws to simulate a corrupt/unrecoverable failure mid-loop
    // Second call (good task) — returns true
    mockTransitionToTerminal
      .mockImplementationOnce(() => { throw new Error('synthetic failure'); })
      .mockReturnValue(true);

    vi.useFakeTimers();
    vi.setSystemTime(NOW);

    await _sweepTaskWatchdogForTesting();

    // Both tasks were attempted — try/catch isolation ensures good task ran
    expect(mockTransitionToTerminal).toHaveBeenCalledTimes(2);
    // Only good task (second call) succeeded, so only one parent notification
    expect(mockWriteSessionMessage).toHaveBeenCalledTimes(1);
  });

  it('uses per-orchestrator config when available', async () => {
    const task = makeTask({
      last_progress_at: new Date(NOW - 35 * 60 * 1000).toISOString(), // 35 min ago
    });
    // Custom timeout of 60 min — 35 min is within timeout, so no reap
    mockGetCapabilityConfig.mockReturnValue({
      noProgressTimeoutSec: 3600,
      spawnDeadlineSec: 600,
      drainGraceSec: 180,
      concurrencyCap: 5,
    });
    mockGetActiveTasks.mockReturnValue([task]);

    vi.useFakeTimers();
    vi.setSystemTime(NOW);

    await _sweepTaskWatchdogForTesting();

    expect(mockTransitionToTerminal).not.toHaveBeenCalled();
  });

  it('falls back to default timeouts when capability config is absent', async () => {
    const task = makeTask({
      last_progress_at: new Date(NOW - 35 * 60 * 1000).toISOString(), // 35 min ago — past 30 min default
    });
    mockGetCapabilityConfig.mockReturnValue(null); // no config
    mockGetActiveTasks.mockReturnValue([task]);
    mockTransitionToTerminal.mockReturnValue(true);

    vi.useFakeTimers();
    vi.setSystemTime(NOW);

    await _sweepTaskWatchdogForTesting();

    // Default 1800s = 30 min; 35 min ago should trigger no-progress reap
    expect(mockTransitionToTerminal).toHaveBeenCalledWith(
      task.task_id,
      'failed',
      expect.objectContaining({ fail_reason: 'no_progress_timeout' }),
    );
  });

  // test_watchdog_fail_reason_canonical: all 4 watchdog actions produce canonical fail_reason values
  it.each([
    {
      label: 'no-progress → no_progress_timeout',
      taskOverrides: { last_progress_at: new Date(NOW - 2 * 60 * 60 * 1000).toISOString() },
      expectedFailReason: 'no_progress_timeout',
    },
    {
      label: 'deadline → deadline_exceeded',
      taskOverrides: {
        deadline: new Date(NOW - 60 * 60 * 1000).toISOString(),
        last_progress_at: new Date(NOW - 2 * 60 * 1000).toISOString(),
      },
      expectedFailReason: 'deadline_exceeded',
    },
    {
      label: 'spawn-deadline → spawn_deadline',
      taskOverrides: {
        status: 'pending' as const,
        started_at: null,
        last_progress_at: null,
        admitted_at: new Date(NOW - 10 * 60 * 1000).toISOString(), // 10 min > 5 min spawn deadline
      },
      expectedFailReason: 'spawn_deadline',
    },
    {
      label: 'container-exit → container_exit',
      taskOverrides: {
        child_session_id: 'child-sess',
        last_progress_at: new Date(NOW - 2 * 60 * 1000).toISOString(), // recent progress
      },
      expectedFailReason: 'container_exit',
      childContainerStopped: true,
    },
  ])('test_watchdog_fail_reason_canonical: $label', async ({ taskOverrides, expectedFailReason, childContainerStopped }) => {
    const task = makeTask(taskOverrides);
    mockGetActiveTasks.mockReturnValue([task]);
    mockTransitionToTerminal.mockReturnValue(true);
    if (childContainerStopped) {
      mockIsContainerRunning.mockReturnValue(false);
    }

    vi.useFakeTimers();
    vi.setSystemTime(NOW);

    await _sweepTaskWatchdogForTesting();

    expect(mockTransitionToTerminal).toHaveBeenCalledWith(
      task.task_id,
      'failed',
      expect.objectContaining({ fail_reason: expectedFailReason }),
    );
  });
});
