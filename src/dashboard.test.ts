import { EventEmitter } from 'events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const initDatabaseMock = vi.fn();
const loggerInfoMock = vi.fn();
const loggerWarnMock = vi.fn();

vi.mock('./channels/index.js', () => ({}));

vi.mock('./config.js', () => ({
  ASSISTANT_NAME: 'TestAssistant',
  DATA_DIR: '/tmp/nanoclaw-dashboard-test',
}));

vi.mock('./dashboard-state.js', () => ({
  DASHBOARD_EVENTS_FILE: '/tmp/nanoclaw-dashboard-test/events.jsonl',
  DASHBOARD_RUNTIME_FILE: '/tmp/nanoclaw-dashboard-test/runtime.json',
}));

vi.mock('./channels/registry.js', () => ({
  getRegisteredChannelNames: () => ['telegram'],
}));

vi.mock('./db.js', () => ({
  getAllChats: () => [],
  getAllRegisteredGroups: () => ({}),
  getAllTasks: () => [],
  getMessagesSince: () => [],
  getRecentTaskRunLogs: () => [],
  getRouterState: () => undefined,
  initDatabase: () => initDatabaseMock(),
}));

vi.mock('./env.js', () => ({
  applySupportedEnvAliases: vi.fn(),
}));

vi.mock('./logger.js', () => ({
  logger: {
    info: (...args: unknown[]) => loggerInfoMock(...args),
    warn: (...args: unknown[]) => loggerWarnMock(...args),
    error: vi.fn(),
  },
}));

import { startDashboardServer } from './dashboard.js';

class MockServer extends EventEmitter {
  public boundPort: number | null = null;
  public boundHost: string | null = null;
  private readonly busyPort: number;

  constructor(busyPort: number) {
    super();
    this.busyPort = busyPort;
  }

  listen(port: number, host: string): this {
    queueMicrotask(() => {
      if (port === this.busyPort) {
        const err = Object.assign(new Error('address in use'), {
          code: 'EADDRINUSE',
        });
        this.emit('error', err);
        return;
      }

      this.boundPort = port === 0 ? 49152 : port;
      this.boundHost = host;
      this.emit('listening');
    });
    return this;
  }

  address(): { address: string; port: number } | null {
    if (this.boundPort == null || this.boundHost == null) {
      return null;
    }
    return {
      address: this.boundHost,
      port: this.boundPort,
    };
  }

  close(callback?: () => void): this {
    queueMicrotask(() => callback?.());
    return this;
  }
}

describe('startDashboardServer', () => {
  const serversToClose = new Set<MockServer>();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(async () => {
    await Promise.all(
      [...serversToClose].map(
        (server) =>
          new Promise<void>((resolve) => {
            server.close(() => resolve());
          }),
      ),
    );
    serversToClose.clear();
  });

  it('falls back to an ephemeral port when the requested port is already in use', async () => {
    const busyPort = 4781;
    const server = new MockServer(busyPort);
    serversToClose.add(server);

    const started = await startDashboardServer({
      host: '127.0.0.1',
      port: busyPort,
      server: server as any,
    });

    expect(started).toBe(server);
    expect(server.address()).toEqual({
      address: '127.0.0.1',
      port: 49152,
    });

    expect(initDatabaseMock).toHaveBeenCalled();
    expect(loggerWarnMock).toHaveBeenCalledWith(
      expect.objectContaining({
        host: '127.0.0.1',
        port: busyPort,
      }),
      'Requested NanoClaw dashboard address is in use; retrying with an ephemeral port',
    );
    expect(loggerInfoMock).toHaveBeenCalledWith(
      expect.objectContaining({
        requestedHost: '127.0.0.1',
        requestedPort: busyPort,
        fallbackUsed: true,
      }),
      'NanoClaw dashboard listening',
    );
  });
});
