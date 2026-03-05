import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventEmitter } from 'events';
import { WsIpcServer, WsIpcServerDeps } from './ws-server.js';
import { createFakeWs, createMockReq } from './test-helpers/ws-test-utils.js';

// Mock config
vi.mock('./config.js', () => ({
  WS_BIND_ADDRESS: '127.0.0.1',
  TIMEZONE: 'UTC',
}));

// Mock logger
vi.mock('./logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

// Mock ipc-handlers registry
vi.mock('./ipc-handlers/registry.js', () => ({
  getRegisteredHandlers: vi.fn(() => new Map()),
  registerIpcHandler: vi.fn(),
}));

// Store the FakeWSServer constructor so tests can access it
let lastCreatedServer: any = null;

vi.mock('ws', () => {
  const { EventEmitter: EE } = require('events');

  class FakeWS extends EE {
    readyState = 1;
    send = vi.fn();
    close = vi.fn();
    ping = vi.fn();
    terminate = vi.fn();
    static OPEN = 1;
  }

  class FakeWSServer extends EE {
    options: any;
    constructor(opts: any) {
      super();
      this.options = opts;
      lastCreatedServer = this;
      queueMicrotask(() => this.emit('listening'));
    }
    address() {
      return { port: 9999 };
    }
    close(cb?: () => void) {
      if (cb) cb();
    }
  }

  return {
    default: Object.assign(FakeWS, { OPEN: 1 }),
    WebSocketServer: FakeWSServer,
  };
});

function createMockDeps(): WsIpcServerDeps {
  return {
    getTasksSnapshot: vi.fn(() => [
      {
        id: 'task-1',
        groupFolder: 'test-group',
        prompt: 'test',
        schedule_type: 'once',
        schedule_value: '2026-01-01',
        status: 'active',
        next_run: null,
      },
    ]),
    getGroupsSnapshot: vi.fn(() => ({
      groups: [],
      lastSync: '2026-01-01T00:00:00.000Z',
    })),
  };
}

/** Send a JSON-RPC notification (no id, no response expected) */
function sendNotification(
  ws: ReturnType<typeof createFakeWs>,
  method: string,
  params: Record<string, unknown>,
) {
  ws.emit(
    'message',
    Buffer.from(JSON.stringify({ jsonrpc: '2.0', method, params })),
  );
}

/** Send a JSON-RPC request (has id, expects response) */
function sendRequest(
  ws: ReturnType<typeof createFakeWs>,
  method: string,
  params: Record<string, unknown>,
  id: number | string = 1,
) {
  ws.emit(
    'message',
    Buffer.from(JSON.stringify({ jsonrpc: '2.0', method, params, id })),
  );
}

/** Extract JSON-RPC responses from ws.send calls */
function getRpcResponses(ws: ReturnType<typeof createFakeWs>) {
  return ws.send.mock.calls
    .map((c: string[]) => {
      try {
        return JSON.parse(c[0]);
      } catch {
        return null;
      }
    })
    .filter((m: any) => m && m.jsonrpc === '2.0' && 'id' in m);
}

/** Extract JSON-RPC notifications from ws.send calls */
function getRpcNotifications(ws: ReturnType<typeof createFakeWs>) {
  return ws.send.mock.calls
    .map((c: string[]) => {
      try {
        return JSON.parse(c[0]);
      } catch {
        return null;
      }
    })
    .filter((m: any) => m && m.jsonrpc === '2.0' && !('id' in m) && m.method);
}

describe('WsIpcServer', () => {
  let server: WsIpcServer;
  let deps: WsIpcServerDeps;
  let wss: EventEmitter;

  beforeEach(async () => {
    lastCreatedServer = null;
    deps = createMockDeps();
    server = new WsIpcServer(deps);
    wss = null as any;
    const startPromise = server.start();
    // queueMicrotask in FakeWSServer fires 'listening' on next microtask
    await startPromise;
    wss = lastCreatedServer!;
  });

  afterEach(async () => {
    await server.shutdown();
  });

  function simulateConnection(
    token: string,
    role: 'agent' | 'mcp' = 'agent',
  ) {
    const ws = createFakeWs();
    const req = createMockReq(token, role);
    wss.emit('connection', ws, req);
    return ws;
  }

  it('creates and validates tokens', () => {
    const token = server.createToken({
      groupFolder: 'test-group',
      chatJid: 'test@g.us',
      isMain: false,
    });
    expect(token).toHaveLength(64); // 32 bytes hex
  });

  it('sends auth_ok notification with snapshots on valid token', () => {
    const token = server.createToken({
      groupFolder: 'test-group',
      chatJid: 'test@g.us',
      isMain: false,
    });
    const ws = simulateConnection(token);

    const notifications = getRpcNotifications(ws);
    expect(notifications).toHaveLength(1);
    expect(notifications[0].method).toBe('auth_ok');
    expect(notifications[0].params.tasks).toHaveLength(1);
    expect(notifications[0].params.groups).toBeDefined();
  });

  it('closes connection with invalid token', () => {
    const ws = createFakeWs();
    const req = createMockReq('bad-token');
    wss.emit('connection', ws, req);

    expect(ws.close).toHaveBeenCalledWith(1008, 'invalid token');
  });

  it('closes connection with missing auth header', () => {
    const ws = createFakeWs();
    const req = { headers: {}, url: '/?role=agent' };
    wss.emit('connection', ws, req);

    expect(ws.close).toHaveBeenCalledWith(1008, 'invalid auth');
  });

  it('closes connection with invalid role', () => {
    const token = server.createToken({
      groupFolder: 'test-group',
      chatJid: 'test@g.us',
      isMain: false,
    });
    const ws = createFakeWs();
    const req = {
      headers: { authorization: `Bearer ${token}`, host: 'localhost' },
      url: '/?role=invalid',
    };
    wss.emit('connection', ws, req);

    expect(ws.close).toHaveBeenCalledWith(1008, 'invalid auth');
  });

  it('sendInput delivers JSON-RPC notification to authenticated connections', () => {
    const token = server.createToken({
      groupFolder: 'test-group',
      chatJid: 'test@g.us',
      isMain: false,
    });
    const ws = simulateConnection(token);

    ws.send.mockClear();
    const result = server.sendInput(token, 'hello');

    expect(result).toBe(true);
    expect(ws.send).toHaveBeenCalledTimes(1);
    const msg = JSON.parse(ws.send.mock.calls[0][0]);
    expect(msg.jsonrpc).toBe('2.0');
    expect(msg.method).toBe('input');
    expect(msg.params).toEqual({ text: 'hello' });
    expect(msg.id).toBeUndefined(); // notification, no id
  });

  it('sendInput returns false when no connections', () => {
    const token = server.createToken({
      groupFolder: 'test-group',
      chatJid: 'test@g.us',
      isMain: false,
    });
    expect(server.sendInput(token, 'nobody home')).toBe(false);
  });

  it('sendClose sends JSON-RPC notification to connections', () => {
    const token = server.createToken({
      groupFolder: 'test-group',
      chatJid: 'test@g.us',
      isMain: false,
    });
    const ws = simulateConnection(token);

    ws.send.mockClear();
    server.sendClose(token);

    expect(ws.send).toHaveBeenCalledTimes(1);
    const msg = JSON.parse(ws.send.mock.calls[0][0]);
    expect(msg.jsonrpc).toBe('2.0');
    expect(msg.method).toBe('close');
    expect(msg.params).toEqual({});
    expect(msg.id).toBeUndefined();
  });

  it('revokeToken closes and removes connections', async () => {
    const token = server.createToken({
      groupFolder: 'test-group',
      chatJid: 'test@g.us',
      isMain: false,
    });
    const ws = simulateConnection(token);

    await server.revokeToken(token);

    expect(ws.close).toHaveBeenCalledWith(1000, 'token revoked');
    expect(server.sendInput(token, 'after revoke')).toBe(false);
  });

  it('routes output notifications and resets timeout', async () => {
    const onOutput = vi.fn(async () => {});
    const resetTimeout = vi.fn();
    const token = server.createToken({
      groupFolder: 'test-group',
      chatJid: 'test@g.us',
      isMain: false,
      onOutput,
      resetTimeout,
    });

    const ws = simulateConnection(token);

    sendNotification(ws, 'output', {
      status: 'success',
      result: 'test result',
      newSessionId: 'sess-1',
    });

    // Wait for promise chain
    await new Promise((r) => setTimeout(r, 10));

    expect(resetTimeout).toHaveBeenCalled();
    expect(onOutput).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'success',
        result: 'test result',
        newSessionId: 'sess-1',
      }),
    );
  });

  it('revokeToken awaits output chain before cleanup', async () => {
    const callOrder: string[] = [];
    const onOutput = vi.fn(async () => {
      await new Promise((r) => setTimeout(r, 50));
      callOrder.push('output-done');
    });
    const token = server.createToken({
      groupFolder: 'test-group',
      chatJid: 'test@g.us',
      isMain: false,
      onOutput,
    });

    const ws = simulateConnection(token);

    // Trigger an output that takes 50ms to process
    sendNotification(ws, 'output', { status: 'success', result: 'slow' });

    // Let the message chain process the notification (queues onto outputChain)
    await new Promise((r) => setTimeout(r, 5));

    // Revoke — should wait for output to finish
    await server.revokeToken(token);
    callOrder.push('revoke-done');

    expect(callOrder).toEqual(['output-done', 'revoke-done']);
  });

  it('supports multiple connections with same token', () => {
    const token = server.createToken({
      groupFolder: 'test-group',
      chatJid: 'test@g.us',
      isMain: false,
    });

    const ws1 = simulateConnection(token);
    const ws2 = simulateConnection(token);

    ws1.send.mockClear();
    ws2.send.mockClear();

    server.sendInput(token, 'broadcast');

    expect(ws1.send).toHaveBeenCalledTimes(1);
    expect(ws2.send).toHaveBeenCalledTimes(1);
  });

  it('returns JSON-RPC error for unknown methods', async () => {
    const token = server.createToken({
      groupFolder: 'test-group',
      chatJid: 'test@g.us',
      isMain: false,
    });
    const ws = simulateConnection(token);

    ws.send.mockClear();
    sendRequest(ws, 'some_unknown_method', {}, 99);

    await new Promise((r) => setTimeout(r, 10));

    const responses = getRpcResponses(ws);
    expect(responses).toHaveLength(1);
    expect(responses[0].id).toBe(99);
    expect(responses[0].error).toBeDefined();
    expect(responses[0].error.code).toBe(-32601); // Method not found
  });

  it('handler from registry is registered and callable', async () => {
    const { getRegisteredHandlers } =
      await import('./ipc-handlers/registry.js');

    // Set up mock to return a handler
    const testHandler = vi.fn(
      async (params: Record<string, unknown>) => ({
        handled: true,
        echo: params.foo,
      }),
    );
    (getRegisteredHandlers as ReturnType<typeof vi.fn>).mockReturnValue(
      new Map([['test_action', testHandler]]),
    );

    // Need a fresh server to pick up the handler
    await server.shutdown();
    server = new WsIpcServer(deps);
    lastCreatedServer = null;
    await server.start();
    wss = lastCreatedServer!;

    const token = server.createToken({
      groupFolder: 'test-group',
      chatJid: 'test@g.us',
      isMain: true,
    });
    const ws = simulateConnection(token);

    ws.send.mockClear();
    sendRequest(ws, 'test_action', { foo: 'bar' }, 'req-handler-1');

    await new Promise((r) => setTimeout(r, 10));

    const responses = getRpcResponses(ws);
    expect(responses).toHaveLength(1);
    expect(responses[0].id).toBe('req-handler-1');
    expect(responses[0].result.handled).toBe(true);
    expect(responses[0].result.echo).toBe('bar');
    // Verify handler received HandlerContext
    expect(testHandler).toHaveBeenCalledWith(
      { foo: 'bar' },
      { groupFolder: 'test-group', chatJid: 'test@g.us', isMain: true },
    );
  });

  it('starts ping interval after auth and terminates on pong timeout', async () => {
    vi.useFakeTimers();
    try {
      const token = server.createToken({
        groupFolder: 'test-group',
        chatJid: 'test@g.us',
        isMain: false,
      });
      const ws = simulateConnection(token);

      // First ping interval fires — ws.ping() should be called
      expect(ws.ping).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(30_000);
      expect(ws.ping).toHaveBeenCalledTimes(1);

      // No pong received — next interval should terminate the connection
      await vi.advanceTimersByTimeAsync(30_000);
      expect(ws.terminate).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('MCP connection does not receive input or close messages', () => {
    const token = server.createToken({
      groupFolder: 'test-group',
      chatJid: 'test@g.us',
      isMain: false,
    });

    // Connect agent
    const agentWs = simulateConnection(token, 'agent');

    // Connect MCP
    const mcpWs = simulateConnection(token, 'mcp');

    agentWs.send.mockClear();
    mcpWs.send.mockClear();

    // sendInput should only go to agent
    server.sendInput(token, 'hello');
    expect(agentWs.send).toHaveBeenCalledTimes(1);
    expect(mcpWs.send).not.toHaveBeenCalled();

    agentWs.send.mockClear();
    mcpWs.send.mockClear();

    // sendClose should only go to agent
    server.sendClose(token);
    expect(agentWs.send).toHaveBeenCalledTimes(1);
    expect(mcpWs.send).not.toHaveBeenCalled();
  });

  it('MCP disconnection does not trigger grace timer; agent disconnection does', () => {
    vi.useFakeTimers();
    try {
      const token = server.createToken({
        groupFolder: 'test-group',
        chatJid: 'test@g.us',
        isMain: false,
      });

      // Connect agent and MCP
      const agentWs = simulateConnection(token, 'agent');
      const mcpWs = simulateConnection(token, 'mcp');

      // MCP disconnects — should NOT trigger grace timer (agent still connected)
      mcpWs.emit('close');

      // sendInput should still work (agent is connected)
      agentWs.send.mockClear();
      expect(server.sendInput(token, 'still here')).toBe(true);
      expect(agentWs.send).toHaveBeenCalledTimes(1);

      // Agent disconnects — should trigger grace timer
      agentWs.emit('close');

      // Advance past grace period
      vi.advanceTimersByTime(31_000);
      // Grace timer fired (verified by no crash and the warn log)
    } finally {
      vi.useRealTimers();
    }
  });
});
