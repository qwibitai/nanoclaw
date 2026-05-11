import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import http from 'http';

import { startSSEFeed, stopSSEFeed, emitDashboardEvent, eventsHandler } from './events.js';
import type { AuthedRequestContext } from '../router.js';

// ── chokidar mock ────────────────────────────────────────────────────────────
const mockWatcher = {
  on: vi.fn().mockReturnThis(),
  close: vi.fn().mockResolvedValue(undefined),
};
const mockWatch = vi.fn().mockReturnValue(mockWatcher);

vi.mock('chokidar', () => ({
  watch: mockWatch,
}));

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeNodeRes(): http.ServerResponse {
  return {
    writeHead: vi.fn(),
    write: vi.fn().mockReturnValue(true),
    end: vi.fn(),
  } as unknown as http.ServerResponse;
}

function makeNodeReq(): http.IncomingMessage {
  const emitter = { listeners: [], on: vi.fn(), emit: vi.fn() } as unknown as http.IncomingMessage;
  return emitter;
}

function makeCtx(
  userId: string,
  opts: { no_filter?: boolean; allowed_group_ids?: string[] } = {},
): AuthedRequestContext {
  return {
    user: { id: userId, kind: 'dashboard', display_name: userId, created_at: new Date().toISOString() },
    scopes: {
      role: opts.no_filter ? 'owner' : 'admin_of_group',
      allowed_group_ids: opts.allowed_group_ids ?? [],
      no_filter: opts.no_filter ?? false,
    },
    rawNodeReq: makeNodeReq(),
    rawNodeRes: makeNodeRes() as unknown as http.ServerResponse,
  };
}

async function openConnection(
  userId: string,
  opts: { no_filter?: boolean; allowed_group_ids?: string[] } = {},
): Promise<{ ctx: AuthedRequestContext; nodeRes: http.ServerResponse }> {
  const ctx = makeCtx(userId, opts);
  const nodeRes = (ctx as unknown as { rawNodeRes: http.ServerResponse }).rawNodeRes;
  const req = new Request('http://localhost/dashboard/api/events');
  const result = await eventsHandler(req, {}, ctx);
  expect(result).toBeNull();
  return { ctx, nodeRes };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('SSE feed — D1', () => {
  beforeEach(() => {
    mockWatch.mockClear();
    mockWatcher.on.mockClear();
    mockWatcher.close.mockClear();
  });

  afterEach(async () => {
    stopSSEFeed();
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it('test_keepalive_single_global_timer: exactly 1 setInterval, not per-connection', async () => {
    const setIntervalSpy = vi.spyOn(global, 'setInterval');
    startSSEFeed();

    // Open 5 connections
    for (let i = 0; i < 5; i++) {
      await openConnection(`u${i}`, { no_filter: true });
    }

    // Exactly 1 setInterval registered (the global keepalive)
    expect(setIntervalSpy.mock.calls.length).toBe(1);
    setIntervalSpy.mockRestore();
  });

  it('test_keepalive_writes_every_25s: keepalive frame sent after 25s', async () => {
    vi.useFakeTimers();
    startSSEFeed();
    const { nodeRes } = await openConnection('u1', { no_filter: true });
    const writeSpy = vi.mocked(nodeRes.write);

    vi.advanceTimersByTime(25_001);
    await Promise.resolve();

    const keepaliveCalls = writeSpy.mock.calls.filter((c) => c[0] === ':keepalive\n\n');
    expect(keepaliveCalls.length).toBeGreaterThanOrEqual(1);
  });

  it('test_per_user_cap_429: 21st connection from same user returns 429', async () => {
    startSSEFeed();
    for (let i = 0; i < 20; i++) {
      await openConnection('u1', { no_filter: true });
    }
    const ctx = makeCtx('u1', { no_filter: true });
    const req = new Request('http://localhost/dashboard/api/events');
    const result = await eventsHandler(req, {}, ctx);
    expect(result).not.toBeNull();
    expect(result!.status).toBe(429);
    expect(result!.headers.get('Retry-After')).toBe('1');
  });

  it('test_aggregate_cap_429: 201st connection across users returns 429', async () => {
    startSSEFeed();
    // 10 users * 20 connections = 200
    for (let u = 0; u < 10; u++) {
      for (let c = 0; c < 20; c++) {
        await openConnection(`user${u}`, { no_filter: true });
      }
    }
    // 201st from a fresh user
    const ctx = makeCtx('fresh-user', { no_filter: true });
    const req = new Request('http://localhost/dashboard/api/events');
    const result = await eventsHandler(req, {}, ctx);
    expect(result).not.toBeNull();
    expect(result!.status).toBe(429);
  });

  it('test_emitDashboardEvent_inbound_message_filtered_by_scope', async () => {
    startSSEFeed();

    // u1 — scoped to ag-1
    const { nodeRes: res1 } = await openConnection('u1', { allowed_group_ids: ['ag-1'] });
    // u2 — scoped to ag-2
    const { nodeRes: res2 } = await openConnection('u2', { allowed_group_ids: ['ag-2'] });
    // u3 — no_filter (owner)
    const { nodeRes: res3 } = await openConnection('u3', { no_filter: true });

    emitDashboardEvent('inbound_message', {
      task_id: 'spawn-x',
      child_session_id: 'sess-1',
      parent_agent_group_id: 'ag-1',
      message_id: 'msg-1',
    });

    // u1 received event
    expect(vi.mocked(res1.write)).toHaveBeenCalledWith(expect.stringContaining('inbound_message'));
    // u2 did NOT receive
    expect(vi.mocked(res2.write)).not.toHaveBeenCalled();
    // u3 received
    expect(vi.mocked(res3.write)).toHaveBeenCalledWith(expect.stringContaining('inbound_message'));
  });

  it('test_chokidar_no_glob_no_central_db: watch called once on sessions dir', async () => {
    vi.useRealTimers();
    startSSEFeed();
    // Dynamic import is async — flush microtasks and actual timers
    await new Promise<void>((resolve) => setTimeout(resolve, 20));

    expect(mockWatch).toHaveBeenCalledTimes(1);
    const [dir, opts] = mockWatch.mock.calls[0] as [string, Record<string, unknown>];
    expect(dir).toContain('v2-sessions');
    expect(opts).toHaveProperty('ignored');
    expect(typeof opts.ignored).toBe('function');
    // No central db watch
    expect(mockWatch).not.toHaveBeenCalledWith(expect.stringContaining('v2.db'), expect.anything());
  });

  it('test_chokidar_ignored_accepts_inbound_and_outbound', async () => {
    vi.useRealTimers();
    startSSEFeed();
    await new Promise<void>((resolve) => setTimeout(resolve, 20));

    expect(mockWatch).toHaveBeenCalledTimes(1);
    const [, opts] = mockWatch.mock.calls[0] as [string, { ignored: (p: string) => boolean }];
    const ignored = opts.ignored;

    // inbound.db and outbound.db should NOT be ignored (return false)
    expect(ignored('/data/v2-sessions/ag-1/sess-1/inbound.db')).toBe(false);
    expect(ignored('/data/v2-sessions/ag-1/sess-1/outbound.db')).toBe(false);
    // Other files should be ignored
    expect(ignored('/data/v2-sessions/ag-1/sess-1/other.txt')).toBe(true);
  });

  it('test_sse_handler_registers_close_listener: connection removed on close', async () => {
    startSSEFeed();
    const ctx = makeCtx('u1', { no_filter: true });
    const nodeReq = ctx.rawNodeReq as unknown as { on: ReturnType<typeof vi.fn>; listeners: unknown[] };
    const req = new Request('http://localhost/dashboard/api/events');
    await eventsHandler(req, {}, ctx);

    // Find the close handler
    const closeCalls = nodeReq.on.mock.calls as Array<[string, () => void]>;
    const closeEntry = closeCalls.find(([event]) => event === 'close');
    expect(closeEntry).toBeDefined();

    // Fire the close handler
    closeEntry![1]();
    // Connection should be removed — next per-user count should allow 20 more
    const ctx2 = makeCtx('u1', { no_filter: true });
    const req2 = new Request('http://localhost/dashboard/api/events');
    const result = await eventsHandler(req2, {}, ctx2);
    expect(result).toBeNull(); // not 429
  });

  it('test_sse_handler_returns_null', async () => {
    startSSEFeed();
    const ctx = makeCtx('u1', { no_filter: true });
    const req = new Request('http://localhost/dashboard/api/events');
    const result = await eventsHandler(req, {}, ctx);
    expect(result).toBeNull();
  });
});
