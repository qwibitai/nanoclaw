import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventEmitter } from 'events';
import { WsIpcServer, WsIpcServerDeps } from './ws-server.js';
import { createFakeWs } from './test-helpers/ws-test-utils.js';

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

// Mock DB functions used by inlined handleTaskIpc
vi.mock('./db.js', () => ({
  createTask: vi.fn(),
  deleteTask: vi.fn(),
  getTaskById: vi.fn(),
  updateTask: vi.fn(),
}));

// Mock group-folder
vi.mock('./group-folder.js', () => ({
  isValidGroupFolder: vi.fn(() => true),
}));

// Store the FakeWSServer constructor so tests can access it
let lastCreatedServer: any = null;

vi.mock('ws', () => {
  const { EventEmitter: EE } = require('events');

  class FakeWS extends EE {
    readyState = 1;
    send = vi.fn();
    close = vi.fn();
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
    sendMessage: vi.fn(async () => {}),
    registeredGroups: vi.fn(() => ({
      'test@g.us': {
        name: 'Test',
        folder: 'test-group',
        trigger: '@Andy',
        added_at: '2024-01-01',
      },
    })),
    registerGroup: vi.fn(),
    syncGroups: vi.fn(async () => {}),
    getAvailableGroups: vi.fn(() => []),
  };
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

  function simulateConnection() {
    const ws = createFakeWs();
    wss.emit('connection', ws, {});
    return ws;
  }

  function authenticateWs(ws: ReturnType<typeof createFakeWs>, token: string) {
    ws.emit('message', Buffer.from(JSON.stringify({ type: 'auth', token })));
  }

  it('creates and validates tokens', () => {
    const token = server.createToken('test-group', 'test@g.us', false);
    expect(token).toHaveLength(64); // 32 bytes hex
  });

  it('sends auth_ok with snapshots on valid token', () => {
    const token = server.createToken('test-group', 'test@g.us', false);
    const ws = simulateConnection();

    authenticateWs(ws, token);

    expect(ws.send).toHaveBeenCalledTimes(1);
    const msg = JSON.parse(ws.send.mock.calls[0][0]);
    expect(msg.type).toBe('auth_ok');
    expect(msg.tasks).toHaveLength(1);
    expect(msg.groups).toBeDefined();
  });

  it('sends auth_error and closes on invalid token', () => {
    const ws = simulateConnection();

    authenticateWs(ws, 'bad-token');

    expect(ws.send).toHaveBeenCalledTimes(1);
    const msg = JSON.parse(ws.send.mock.calls[0][0]);
    expect(msg.type).toBe('auth_error');
    expect(ws.close).toHaveBeenCalledWith(4003, 'invalid token');
  });

  it('closes connection that sends non-auth first message', () => {
    const ws = simulateConnection();

    ws.emit(
      'message',
      Buffer.from(JSON.stringify({ type: 'output', status: 'success' })),
    );

    expect(ws.close).toHaveBeenCalledWith(4002, 'must authenticate first');
  });

  it('sendInput delivers to authenticated connections', () => {
    const token = server.createToken('test-group', 'test@g.us', false);
    const ws = simulateConnection();
    authenticateWs(ws, token);

    ws.send.mockClear();
    const result = server.sendInput(token, 'hello');

    expect(result).toBe(true);
    expect(ws.send).toHaveBeenCalledTimes(1);
    const msg = JSON.parse(ws.send.mock.calls[0][0]);
    expect(msg.type).toBe('input');
    expect(msg.text).toBe('hello');
  });

  it('sendInput returns false when no connections', () => {
    const token = server.createToken('test-group', 'test@g.us', false);
    expect(server.sendInput(token, 'nobody home')).toBe(false);
  });

  it('sendClose sends close message to connections', () => {
    const token = server.createToken('test-group', 'test@g.us', false);
    const ws = simulateConnection();
    authenticateWs(ws, token);

    ws.send.mockClear();
    server.sendClose(token);

    expect(ws.send).toHaveBeenCalledTimes(1);
    const msg = JSON.parse(ws.send.mock.calls[0][0]);
    expect(msg.type).toBe('close');
  });

  it('revokeToken closes and removes connections', () => {
    const token = server.createToken('test-group', 'test@g.us', false);
    const ws = simulateConnection();
    authenticateWs(ws, token);

    server.revokeToken(token);

    expect(ws.close).toHaveBeenCalledWith(1000, 'token revoked');
    expect(server.sendInput(token, 'after revoke')).toBe(false);
  });

  it('routes output messages and resets timeout', async () => {
    const token = server.createToken('test-group', 'test@g.us', false);
    const onOutput = vi.fn(async () => {});
    const resetTimeout = vi.fn();
    server.setTokenCallbacks(token, onOutput, resetTimeout);

    const ws = simulateConnection();
    authenticateWs(ws, token);

    ws.emit(
      'message',
      Buffer.from(
        JSON.stringify({
          type: 'output',
          status: 'success',
          result: 'test result',
          newSessionId: 'sess-1',
        }),
      ),
    );

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

  it('authorizes message from own group folder', async () => {
    const token = server.createToken('test-group', 'test@g.us', false);
    const ws = simulateConnection();
    authenticateWs(ws, token);

    ws.emit(
      'message',
      Buffer.from(
        JSON.stringify({
          type: 'message',
          chatJid: 'test@g.us',
          text: 'hello',
        }),
      ),
    );

    await new Promise((r) => setTimeout(r, 10));
    expect(deps.sendMessage).toHaveBeenCalledWith(
      'test@g.us',
      'hello',
      undefined,
    );
  });

  it('blocks unauthorized cross-group message', async () => {
    const token = server.createToken('other-group', 'other@g.us', false);
    const ws = simulateConnection();
    authenticateWs(ws, token);

    ws.emit(
      'message',
      Buffer.from(
        JSON.stringify({
          type: 'message',
          chatJid: 'test@g.us',
          text: 'unauthorized',
        }),
      ),
    );

    await new Promise((r) => setTimeout(r, 10));
    expect(deps.sendMessage).not.toHaveBeenCalled();
  });

  it('main group can send to any JID', async () => {
    const token = server.createToken('main-group', 'main@g.us', true);
    const ws = simulateConnection();
    authenticateWs(ws, token);

    ws.emit(
      'message',
      Buffer.from(
        JSON.stringify({
          type: 'message',
          chatJid: 'test@g.us',
          text: 'from main',
        }),
      ),
    );

    await new Promise((r) => setTimeout(r, 10));
    expect(deps.sendMessage).toHaveBeenCalledWith(
      'test@g.us',
      'from main',
      undefined,
    );
  });

  it('handles list_tasks request-response', async () => {
    const token = server.createToken('test-group', 'test@g.us', false);
    const ws = simulateConnection();
    authenticateWs(ws, token);

    ws.send.mockClear();
    ws.emit(
      'message',
      Buffer.from(JSON.stringify({ type: 'list_tasks', requestId: 'req-123' })),
    );

    await new Promise((r) => setTimeout(r, 10));

    // Find the ipc_response in send calls
    const responseCalls = ws.send.mock.calls
      .map((c: string[]) => JSON.parse(c[0]))
      .filter((m: { type: string }) => m.type === 'ipc_response');

    expect(responseCalls).toHaveLength(1);
    expect(responseCalls[0].requestId).toBe('req-123');
    expect(responseCalls[0].tasks).toHaveLength(1);
  });

  it('supports multiple connections with same token', () => {
    const token = server.createToken('test-group', 'test@g.us', false);

    const ws1 = simulateConnection();
    authenticateWs(ws1, token);

    const ws2 = simulateConnection();
    authenticateWs(ws2, token);

    ws1.send.mockClear();
    ws2.send.mockClear();

    server.sendInput(token, 'broadcast');

    expect(ws1.send).toHaveBeenCalledTimes(1);
    expect(ws2.send).toHaveBeenCalledTimes(1);
  });

  it('routes task IPC messages through handleTaskIpc', async () => {
    const { createTask } = await import('./db.js');

    const token = server.createToken('test-group', 'test@g.us', false);
    const ws = simulateConnection();
    authenticateWs(ws, token);

    ws.emit(
      'message',
      Buffer.from(
        JSON.stringify({
          type: 'schedule_task',
          prompt: 'do something',
          schedule_type: 'once',
          schedule_value: '2026-01-01',
          targetJid: 'test@g.us',
        }),
      ),
    );

    await new Promise((r) => setTimeout(r, 10));
    expect(createTask).toHaveBeenCalledWith(
      expect.objectContaining({
        group_folder: 'test-group',
        prompt: 'do something',
        schedule_type: 'once',
      }),
    );
  });

  it('routes unknown message types to handleTaskIpc default when no handler matches', async () => {
    const { logger } = await import('./logger.js');

    const token = server.createToken('test-group', 'test@g.us', false);
    const ws = simulateConnection();
    authenticateWs(ws, token);

    ws.emit(
      'message',
      Buffer.from(JSON.stringify({ type: 'some_custom_type' })),
    );

    await new Promise((r) => setTimeout(r, 10));
    expect(logger.warn).toHaveBeenCalledWith(
      { type: 'some_custom_type' },
      'Unknown IPC task type',
    );
  });

  it('routes x_* messages through IPC handler registry and sends ipc_response', async () => {
    const { registerIpcHandler } = await import('./ipc-handlers/registry.js');

    // Register a test handler for the test_ prefix
    registerIpcHandler('test_', async (msg, _groupFolder, _isMain) => ({
      success: true,
      message: `handled ${msg.type}`,
    }));

    const token = server.createToken('test-group', 'test@g.us', true);
    const ws = simulateConnection();
    authenticateWs(ws, token);

    ws.send.mockClear();
    ws.emit(
      'message',
      Buffer.from(
        JSON.stringify({
          type: 'test_action',
          requestId: 'req-handler-1',
        }),
      ),
    );

    await new Promise((r) => setTimeout(r, 10));

    const responseCalls = ws.send.mock.calls
      .map((c: string[]) => JSON.parse(c[0]))
      .filter((m: { type: string }) => m.type === 'ipc_response');

    expect(responseCalls).toHaveLength(1);
    expect(responseCalls[0].requestId).toBe('req-handler-1');
    expect(responseCalls[0].success).toBe(true);
    expect(responseCalls[0].message).toBe('handled test_action');
  });

  it('handler result without requestId does not send ipc_response', async () => {
    const { registerIpcHandler } = await import('./ipc-handlers/registry.js');

    registerIpcHandler('fire_', async () => ({
      success: true,
      message: 'fire and forget',
    }));

    const token = server.createToken('test-group', 'test@g.us', true);
    const ws = simulateConnection();
    authenticateWs(ws, token);

    ws.send.mockClear();
    ws.emit(
      'message',
      Buffer.from(JSON.stringify({ type: 'fire_action' })),
    );

    await new Promise((r) => setTimeout(r, 10));

    // No ipc_response should have been sent (no requestId)
    const responseCalls = ws.send.mock.calls
      .map((c: string[]) => JSON.parse(c[0]))
      .filter((m: { type: string }) => m.type === 'ipc_response');

    expect(responseCalls).toHaveLength(0);
  });

  it('getOutputChain returns token output chain', async () => {
    const token = server.createToken('test-group', 'test@g.us', false);
    const chain = server.getOutputChain(token);
    expect(chain).toBeInstanceOf(Promise);
    await chain; // should resolve immediately
  });

  it('getOutputChain returns resolved promise for unknown token', async () => {
    const chain = server.getOutputChain('nonexistent');
    expect(chain).toBeInstanceOf(Promise);
    await chain;
  });
});
