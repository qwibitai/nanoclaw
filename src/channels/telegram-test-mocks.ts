import { vi } from 'vitest';

import { botRef } from './telegram-test-harness.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Handler = (...args: any[]) => any;

/**
 * Module-mock factories used by every telegram-*.test.ts file. Each
 * test file passes the appropriate factory to its own `vi.mock(path,
 * factory)` call (vi.mock factories are file-scoped due to hoisting, so
 * the DRY bit is the factory body — the mock call itself cannot be
 * shared).
 */

export const registryMockFactory = () => ({ registerChannel: vi.fn() });

export const envMockFactory = () => ({ readEnvFile: vi.fn(() => ({})) });

export const configMockFactory = () => ({
  ASSISTANT_NAME: 'Andy',
  DEFAULT_MODEL: 'claude-sonnet-4-20250514',
  TIMEZONE: 'Asia/Tokyo',
  TRIGGER_PATTERN: /^@Andy\b/i,
  LIVE_LOCATION_IDLE_TIMEOUT_MS: 600000,
  LIVE_LOCATION_LOG_DIR: '/tmp/test-data/location_logs',
  resolveModelAlias: vi.fn((name: string) => {
    const aliases: Record<string, string> = {
      opus: 'claude-opus-4-20250514',
      sonnet: 'claude-sonnet-4-20250514',
      haiku: 'claude-haiku-4-20250514',
    };
    return aliases[name.toLowerCase()] || name;
  }),
  loadModelAliases: vi.fn(() => ({
    opus: 'claude-opus-4-20250514',
    sonnet: 'claude-sonnet-4-20250514',
    haiku: 'claude-haiku-4-20250514',
  })),
});

export const liveLocationMockFactory = () => {
  const MockLiveLocationManager = vi.fn(function MockLiveLocationManager() {
    return {
      initialize: vi.fn(),
      startSession: vi.fn(
        () => '/tmp/test-data/location_logs/_100200300_1.log',
      ),
      updateSession: vi.fn(() => 'updated'),
      stopSession: vi.fn(),
      getLatestPosition: vi.fn(() => undefined),
      destroy: vi.fn(),
    };
  });
  return {
    LiveLocationManager: MockLiveLocationManager,
    buildLocationPrefix: vi.fn(
      (label: string, lat: number, lng: number, logPath: string) =>
        `${label} lat: ${lat}, long: ${lng}. check \`tail ${logPath}\``,
    ),
    _setActiveLiveLocationManager: vi.fn(),
    getActiveLiveLocationContext: vi.fn(() => ''),
  };
};

export const dbMockFactory = () => ({
  setGroupModel: vi.fn(),
  setGroupEffort: vi.fn(),
  setGroupThinkingBudget: vi.fn(),
  getTaskById: vi.fn((id: string) => {
    if (id === 'task-123') {
      return {
        id: 'task-123',
        group_folder: 'test-group',
        chat_jid: 'tg:100200300',
        prompt: 'heartbeat',
        schedule_type: 'cron',
        schedule_value: '0 */4 * * *',
        model: null,
        status: 'active',
      };
    }
    return undefined;
  }),
  getTasksForGroup: vi.fn((folder: string) => {
    if (folder === 'test-group') {
      return [
        {
          id: 'task-123',
          prompt: 'heartbeat flow',
          schedule_type: 'cron',
          schedule_value: '0 */4 * * *',
          model: 'claude-haiku-4-20250514',
          status: 'active',
          last_run: '2026-04-05T23:00:00.000Z',
          next_run: '2026-04-06T03:00:00.000Z',
        },
        {
          id: 'task-456',
          prompt: 'weekly report',
          schedule_type: 'once',
          schedule_value: '2026-04-10T09:00',
          model: null,
          status: 'active',
          last_run: null,
          next_run: '2026-04-10T00:00:00.000Z',
        },
      ];
    }
    return [];
  }),
  updateTask: vi.fn(),
});

export const loggerMockFactory = () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
});

export const groupFolderMockFactory = () => ({
  resolveGroupFolderPath: vi.fn(
    (folder: string) => `/tmp/test-groups/${folder}`,
  ),
});

export const grammyMockFactory = () => ({
  InputFile: class MockInputFile {
    path: string;
    constructor(path: string) {
      this.path = path;
    }
  },
  InlineKeyboard: class MockInlineKeyboard {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    buttons: any[][] = [[]];
    text(label: string, data: string) {
      this.buttons[this.buttons.length - 1].push({
        text: label,
        callback_data: data,
      });
      return this;
    }
    row() {
      this.buttons.push([]);
      return this;
    }
  },
  Bot: class MockBot {
    token: string;
    commandHandlers = new Map<string, Handler>();
    callbackQueryHandlers: Array<{
      pattern: RegExp | string;
      handler: Handler;
    }> = [];
    filterHandlers = new Map<string, Handler[]>();
    errorHandler: Handler | null = null;

    api = {
      sendMessage: vi.fn().mockResolvedValue(undefined),
      sendPhoto: vi.fn().mockResolvedValue(undefined),
      sendChatAction: vi.fn().mockResolvedValue(undefined),
      editMessageText: vi.fn().mockResolvedValue(undefined),
      deleteMessage: vi.fn().mockResolvedValue(undefined),
      getFile: vi.fn().mockResolvedValue({ file_path: 'photos/file_0.jpg' }),
      setMyCommands: vi.fn().mockResolvedValue(undefined),
      deleteMyCommands: vi.fn().mockResolvedValue(undefined),
    };

    constructor(token: string) {
      this.token = token;
      botRef.current = this;
    }

    command(name: string, handler: Handler) {
      this.commandHandlers.set(name, handler);
    }

    callbackQuery(pattern: RegExp | string, handler: Handler) {
      this.callbackQueryHandlers.push({ pattern, handler });
    }

    on(filter: string, handler: Handler) {
      const existing = this.filterHandlers.get(filter) || [];
      existing.push(handler);
      this.filterHandlers.set(filter, existing);
    }

    catch(handler: Handler) {
      this.errorHandler = handler;
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    start(opts: { onStart: (botInfo: any) => void }) {
      opts.onStart({ username: 'andy_ai_bot', id: 12345 });
    }

    stop() {}
  },
});

// Each test file MUST repeat the `vi.mock(path, factory)` calls at its
// own top-level because vi.mock is hoisted per-file. The shared part is
// the factory bodies above; the 8 `vi.mock` calls are pure boilerplate:
//
//   vi.mock('./registry.js', registryMockFactory);
//   vi.mock('../env.js', envMockFactory);
//   vi.mock('../config.js', configMockFactory);
//   vi.mock('../live-location.js', liveLocationMockFactory);
//   vi.mock('../db.js', dbMockFactory);
//   vi.mock('../logger.js', loggerMockFactory);
//   vi.mock('../group-folder.js', groupFolderMockFactory);
//   vi.mock('grammy', grammyMockFactory);
