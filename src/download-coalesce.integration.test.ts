import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import fs from 'fs';

/**
 * INVARIANT: When a Telegram text message and document arrive in quick
 * succession, the coalescing pipeline batches them into a single container
 * start — the agent never sees the text without the document.
 *
 * SUT: Full pipeline: TelegramChannel → DownloadTracker → GroupQueue
 * VERIFICATION: Wire real instances together (only Grammy bot and file I/O
 * are mocked — unavoidable without a real Telegram connection). Control
 * download timing to simulate the race condition. Assert container starts
 * exactly once after both messages are available.
 */

// Grammy mock — minimal version of the mock in telegram.test.ts
type Handler = (...args: any[]) => any;
const botRef = vi.hoisted(() => ({ current: null as any }));

vi.mock('grammy', () => ({
  Bot: class MockBot {
    token: string;
    filterHandlers = new Map<string, Handler[]>();
    commandHandlers = new Map<string, Handler>();
    errorHandler: Handler | null = null;
    api = {
      sendMessage: vi.fn().mockResolvedValue(undefined),
      sendPhoto: vi.fn().mockResolvedValue(undefined),
      sendDocument: vi.fn().mockResolvedValue(undefined),
      sendChatAction: vi.fn().mockResolvedValue(undefined),
      getFile: vi.fn().mockResolvedValue({ file_path: 'docs/file_0.pdf' }),
    };
    constructor(token: string) {
      this.token = token;
      botRef.current = this;
    }
    command(name: string, handler: Handler) {
      this.commandHandlers.set(name, handler);
    }
    on(filter: string, handler: Handler) {
      const existing = this.filterHandlers.get(filter) || [];
      existing.push(handler);
      this.filterHandlers.set(filter, existing);
    }
    catch(handler: Handler) {
      this.errorHandler = handler;
    }
    start(opts: { onStart: (botInfo: any) => void }) {
      opts.onStart({ username: 'andy_ai_bot', id: 12345 });
    }
    stop() {}
  },
  InputFile: class MockInputFile {
    path: string;
    constructor(path: string) {
      this.path = path;
    }
  },
}));

// Mock registry (registerChannel runs at import time)
vi.mock('./channels/registry.js', () => ({ registerChannel: vi.fn() }));
vi.mock('./env.js', () => ({ readEnvFile: vi.fn(() => ({})) }));
vi.mock('./config.js', () => ({
  ASSISTANT_NAME: 'Andy',
  TRIGGER_PATTERN: /^@Andy\b/i,
  DATA_DIR: '/tmp/nanoclaw-integration-test',
  MAX_CONCURRENT_CONTAINERS: 2,
  COALESCE_MS: 500,
  MAX_DOWNLOAD_WAIT_MS: 60000,
}));
vi.mock('./logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));
vi.mock('./group-folder.js', () => ({
  resolveGroupFolderPath: vi.fn(
    (folder: string) => `/tmp/test-groups/${folder}`,
  ),
}));

// Controllable download mock — key to simulating the race condition
let downloadResolve: (() => void) | null = null;
let downloadReject: ((err: Error) => void) | null = null;
const mockDownloadFile = vi.fn();
vi.mock('./download.js', () => ({
  downloadFile: (...args: any[]) => mockDownloadFile(...args),
}));

// Mock fs to avoid real file I/O
vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    default: {
      ...actual,
      mkdirSync: vi.fn(),
      writeFileSync: vi.fn(),
      renameSync: vi.fn(),
    },
  };
});

import { TelegramChannel } from './channels/telegram.js';
import { DownloadTracker } from './download-tracker.js';
import { GroupQueue } from './group-queue.js';

const CHAT_JID = 'tg:-1001234567';
const CHAT_ID = -1001234567;

function createTextCtx(text: string, messageId: number) {
  return {
    chat: { id: CHAT_ID, type: 'group' as const, title: 'Test Group' },
    from: { id: 99001, first_name: 'Alice', username: 'alice' },
    message: {
      date: Math.floor(Date.now() / 1000),
      message_id: messageId,
      text,
      entities: [],
      reply_to_message: undefined,
    },
    me: { username: 'andy_ai_bot' },
  };
}

function createDocumentCtx(
  messageId: number,
  filename: string,
  caption?: string,
) {
  return {
    chat: { id: CHAT_ID, type: 'group' as const, title: 'Test Group' },
    from: { id: 99001, first_name: 'Alice', username: 'alice' },
    message: {
      date: Math.floor(Date.now() / 1000),
      message_id: messageId,
      caption,
      document: { file_id: 'doc_file_id', file_name: filename },
      reply_to_message: undefined,
    },
    api: {
      getFile: vi
        .fn()
        .mockResolvedValue({ file_path: `documents/${filename}` }),
    },
    me: { username: 'andy_ai_bot' },
  };
}

async function triggerHandler(filter: string, ctx: any) {
  const handlers = botRef.current.filterHandlers.get(filter) || [];
  for (const h of handlers) await h(ctx);
}

describe('full pipeline integration: TelegramChannel → DownloadTracker → GroupQueue', () => {
  let tracker: DownloadTracker;
  let queue: GroupQueue;
  let channel: TelegramChannel;
  let processMessages: ReturnType<typeof vi.fn>;
  let storedMessages: Array<{ chatJid: string; content: string }>;

  beforeEach(async () => {
    vi.useFakeTimers();
    vi.clearAllMocks();

    // Default: downloads resolve immediately
    mockDownloadFile.mockResolvedValue(undefined);

    tracker = new DownloadTracker();
    // coalesceMs=500, maxDownloadWaitMs=5000
    queue = new GroupQueue(500, 5000);
    queue.setDownloadTracker(tracker);

    processMessages = vi.fn(async () => true);
    queue.setProcessMessagesFn(
      processMessages as (groupJid: string) => Promise<boolean>,
    );

    storedMessages = [];

    // Wire TelegramChannel → DownloadTracker + message storage
    channel = new TelegramChannel('test-token', {
      onMessage: (chatJid, msg) => {
        storedMessages.push({ chatJid, content: msg.content });
        // Simulate what the message loop does: enqueue a check
        queue.enqueueMessageCheck(chatJid);
      },
      onChatMetadata: vi.fn(),
      registeredGroups: () => ({
        [CHAT_JID]: {
          name: 'Test Group',
          folder: 'test-group',
          trigger: '@Andy',
          added_at: '2024-01-01T00:00:00.000Z',
        },
      }),
      onDownloadStart: (chatJid, id) => tracker.start(chatJid, id),
      onDownloadComplete: (chatJid, id) => tracker.complete(chatJid, id),
    });

    await channel.connect();
  });

  afterEach(async () => {
    await queue.shutdown(100);
    vi.useRealTimers();
  });

  it('text-only message: container starts after coalesce window', async () => {
    // User sends: "@Andy hello"
    const ctx = createTextCtx('@Andy hello', 100);
    await triggerHandler('message:text', ctx);

    // Message stored, enqueueMessageCheck called
    expect(storedMessages).toHaveLength(1);

    // Container should NOT start immediately (coalesce window)
    await vi.advanceTimersByTimeAsync(499);
    expect(processMessages).not.toHaveBeenCalled();

    // After coalesce window, container starts
    await vi.advanceTimersByTimeAsync(1);
    expect(processMessages).toHaveBeenCalledTimes(1);
  });

  it('text + document: container waits for download, starts once with both', async () => {
    // Make downloadFile hang until we resolve it manually
    let resolveDownload!: () => void;
    mockDownloadFile.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          resolveDownload = resolve;
        }),
    );

    // T=0: User sends text: "@Andy turn this pdf into jpg"
    const textCtx = createTextCtx('@Andy turn this pdf into jpg', 200);
    await triggerHandler('message:text', textCtx);
    expect(storedMessages).toHaveLength(1);
    expect(storedMessages[0].content).toBe('@Andy turn this pdf into jpg');

    // T=100: Document webhook arrives (separate Telegram message)
    await vi.advanceTimersByTimeAsync(100);
    // Don't await — the handler will hang on downloadFile
    const docCtx = createDocumentCtx(201, 'report.pdf');
    const docPromise = triggerHandler('message:document', docCtx);

    // At this point: onDownloadStart has been called (it's before the await)
    // The download is "in progress"
    expect(tracker.hasPending(CHAT_JID)).toBe(true);

    // T=500: Coalesce window expires — but download still pending
    await vi.advanceTimersByTimeAsync(400);
    expect(processMessages).not.toHaveBeenCalled();

    // T=2000: Download completes
    await vi.advanceTimersByTimeAsync(1500);
    resolveDownload();
    // Let the handler finish (storeNonText + onDownloadComplete)
    await docPromise;
    // Let GroupQueue's waitForCompletion resolve
    await vi.advanceTimersByTimeAsync(0);

    // Container started exactly ONCE — with both messages available
    expect(processMessages).toHaveBeenCalledTimes(1);
    expect(processMessages).toHaveBeenCalledWith(CHAT_JID);

    // Both messages were stored before container started
    expect(storedMessages).toHaveLength(2);
    expect(storedMessages[0].content).toBe('@Andy turn this pdf into jpg');
    expect(storedMessages[1].content).toContain('[Document:');
    expect(storedMessages[1].content).toContain('report.pdf');
  });

  it('text + failed download: container starts with both messages (fallback placeholder)', async () => {
    // Download will fail
    mockDownloadFile.mockRejectedValue(new Error('Network timeout'));

    // T=0: Text arrives
    const textCtx = createTextCtx('@Andy process this file', 300);
    await triggerHandler('message:text', textCtx);

    // T=50: Document arrives — download fails immediately
    await vi.advanceTimersByTimeAsync(50);
    const docCtx = createDocumentCtx(301, 'data.csv');
    await triggerHandler('message:document', docCtx);

    // Download failed → onDownloadComplete already called in finally block
    expect(tracker.hasPending(CHAT_JID)).toBe(false);

    // T=500: Coalesce window expires → container starts
    await vi.advanceTimersByTimeAsync(450);
    expect(processMessages).toHaveBeenCalledTimes(1);

    // Both messages stored — document has fallback placeholder
    expect(storedMessages).toHaveLength(2);
    expect(storedMessages[1].content).toContain('download failed');
  });

  it('rapid text messages: all coalesced into single container start', async () => {
    const msg1 = createTextCtx('@Andy first message', 400);
    await triggerHandler('message:text', msg1);

    await vi.advanceTimersByTimeAsync(100);
    const msg2 = createTextCtx('second message', 401);
    await triggerHandler('message:text', msg2);

    await vi.advanceTimersByTimeAsync(100);
    const msg3 = createTextCtx('third message', 402);
    await triggerHandler('message:text', msg3);

    // All 3 messages stored
    expect(storedMessages).toHaveLength(3);

    // Coalesce window from first message: 500ms total
    await vi.advanceTimersByTimeAsync(300);
    expect(processMessages).toHaveBeenCalledTimes(1);
  });

  it('text + slow document download: container waits up to timeout then starts anyway', async () => {
    // Download that never resolves
    mockDownloadFile.mockImplementation(() => new Promise(() => {}));

    // Use a shorter timeout for this test
    await queue.shutdown(0);
    queue = new GroupQueue(100, 500);
    queue.setDownloadTracker(tracker);
    queue.setProcessMessagesFn(
      processMessages as (groupJid: string) => Promise<boolean>,
    );

    // Rewire onMessage to use new queue
    const origChannel = channel;
    channel = new TelegramChannel('test-token', {
      onMessage: (chatJid, msg) => {
        storedMessages.push({ chatJid, content: msg.content });
        queue.enqueueMessageCheck(chatJid);
      },
      onChatMetadata: vi.fn(),
      registeredGroups: origChannel['opts'].registeredGroups,
      onDownloadStart: (chatJid, id) => tracker.start(chatJid, id),
      onDownloadComplete: (chatJid, id) => tracker.complete(chatJid, id),
    });
    await channel.connect();

    // T=0: Text arrives
    const textCtx = createTextCtx('@Andy process this', 500);
    await triggerHandler('message:text', textCtx);

    // T=50: Document arrives, download hangs forever
    await vi.advanceTimersByTimeAsync(50);
    const docCtx = createDocumentCtx(501, 'huge-file.pdf');
    // Don't await — it'll never resolve
    triggerHandler('message:document', docCtx);

    // T=100: Coalesce expires, download still pending
    await vi.advanceTimersByTimeAsync(50);
    expect(processMessages).not.toHaveBeenCalled();

    // T=599: Still waiting
    await vi.advanceTimersByTimeAsync(499);
    expect(processMessages).not.toHaveBeenCalled();

    // T=600: coalesce(100) + download timeout(500) = 600ms
    await vi.advanceTimersByTimeAsync(1);
    expect(processMessages).toHaveBeenCalledTimes(1);

    // Text message was stored; document handler is still hanging
    // but container started anyway after timeout
    expect(storedMessages.length).toBeGreaterThanOrEqual(1);
    expect(storedMessages[0].content).toContain('process this');
  });

  it('document without preceding text: still tracks download correctly', async () => {
    let resolveDownload!: () => void;
    mockDownloadFile.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          resolveDownload = resolve;
        }),
    );

    // Document arrives alone (with caption as trigger)
    const docCtx = createDocumentCtx(600, 'invoice.pdf', '@Andy check this');
    const docPromise = triggerHandler('message:document', docCtx);

    // Download in progress
    expect(tracker.hasPending(CHAT_JID)).toBe(true);

    // But no enqueueMessageCheck yet (onMessage hasn't fired — download pending)
    expect(processMessages).not.toHaveBeenCalled();

    // Download completes → storeNonText → onMessage → enqueueMessageCheck
    await vi.advanceTimersByTimeAsync(200);
    resolveDownload();
    await docPromise;
    await vi.advanceTimersByTimeAsync(0);

    // Download complete, message stored
    expect(tracker.hasPending(CHAT_JID)).toBe(false);
    expect(storedMessages).toHaveLength(1);
    expect(storedMessages[0].content).toContain('[Document:');

    // Coalesce window for the enqueue
    await vi.advanceTimersByTimeAsync(500);
    expect(processMessages).toHaveBeenCalledTimes(1);
  });
});
