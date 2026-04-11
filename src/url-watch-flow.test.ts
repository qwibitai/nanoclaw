import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Channel, InboundMessage, RegisteredGroup } from './types.js';

const {
  storeMessageMock,
  setRegisteredGroupMock,
  reserveSpawnedThreadMock,
  finalizeSpawnedThreadMock,
  releaseSpawnedThreadReservationMock,
} = vi.hoisted(() => ({
  storeMessageMock: vi.fn(),
  setRegisteredGroupMock: vi.fn(),
  reserveSpawnedThreadMock: vi.fn(() => true),
  finalizeSpawnedThreadMock: vi.fn(),
  releaseSpawnedThreadReservationMock: vi.fn(),
}));

vi.mock('./logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('./db.js', () => ({
  _initTestDatabase: vi.fn(),
  finalizeSpawnedThread: finalizeSpawnedThreadMock,
  getAllRegisteredGroups: vi.fn(() => ({})),
  getAllSessions: vi.fn(() => ({})),
  getAllTasks: vi.fn(() => []),
  getAllChats: vi.fn(() => []),
  getMessagesSince: vi.fn(() => []),
  getNewMessages: vi.fn(() => ({ messages: [], newTimestamp: '' })),
  getRegisteredGroup: vi.fn(),
  getRouterState: vi.fn(() => null),
  initDatabase: vi.fn(),
  releaseSpawnedThreadReservation: releaseSpawnedThreadReservationMock,
  reserveSpawnedThread: reserveSpawnedThreadMock,
  setRegisteredGroup: setRegisteredGroupMock,
  setRouterState: vi.fn(),
  setSession: vi.fn(),
  storeChatMetadata: vi.fn(),
  storeMessage: storeMessageMock,
}));

vi.mock('./group-folder.js', () => ({
  encodeIpcNamespaceKey: vi.fn((jid: string) => jid),
  isValidGroupFolder: vi.fn(() => true),
  resolveGroupFolderPath: vi.fn(() => '/tmp/test-group'),
  resolveGroupIpcPathByJid: vi.fn(() => '/tmp/test-ipc'),
}));

vi.mock('fs', () => ({
  default: { mkdirSync: vi.fn(), existsSync: vi.fn(() => false) },
  mkdirSync: vi.fn(),
  existsSync: vi.fn(() => false),
}));

import { _maybeHandleUrlWatchMessage, _setRegisteredGroups } from './index.js';

const chatJid = 'dc:parent';
const baseGroup: RegisteredGroup = {
  name: 'Parent',
  folder: 'discord_main',
  trigger: '@Andy',
  added_at: '2024-01-01T00:00:00.000Z',
  type: 'chat',
  channel_mode: 'url_watch',
};

function makeMsg(overrides?: Partial<InboundMessage>): InboundMessage {
  return {
    id: 'msg-1',
    chat_jid: chatJid,
    sender: 'user-1',
    sender_name: 'User',
    content: 'https://example.com/post',
    timestamp: '2024-01-01T00:00:01.000Z',
    ...overrides,
  };
}

function makeChannel(createThread?: Channel['createThread']): Channel {
  return {
    name: 'discord',
    connect: async () => {},
    disconnect: async () => {},
    isConnected: () => true,
    ownsJid: (jid: string) => jid === chatJid,
    sendMessage: async () => {},
    ...(createThread ? { createThread } : {}),
  };
}

async function flushAsyncWork(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe('url_watch flow', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    reserveSpawnedThreadMock.mockReturnValue(true);
    _setRegisteredGroups({ [chatJid]: baseGroup });
  });

  it('URL あり + createThread 成功: スレッド作成し元メッセージ保存をスキップ', async () => {
    const createThread = vi.fn(async () => 'dc:thread-1');
    const msg = makeMsg();

    const handled = _maybeHandleUrlWatchMessage(chatJid, msg, [
      makeChannel(createThread),
    ]);
    expect(handled).toBe(true);
    await flushAsyncWork();

    expect(createThread).toHaveBeenCalledTimes(1);
    expect(finalizeSpawnedThreadMock).toHaveBeenCalledWith('msg-1', 'dc:thread-1');
    expect(setRegisteredGroupMock).toHaveBeenCalledWith(
      'dc:thread-1',
      expect.objectContaining({ type: 'thread', parent_folder: 'discord_main' }),
    );
    expect(storeMessageMock).toHaveBeenCalledTimes(1);
    expect(storeMessageMock).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'msg-1_url',
        chat_jid: 'dc:thread-1',
        content: 'https://example.com/post',
      }),
    );
  });

  it('URL なし: 元メッセージを通常保存する', async () => {
    const createThread = vi.fn(async () => 'dc:thread-1');
    const msg = makeMsg({ id: 'msg-no-url', content: 'hello world' });

    const handled = _maybeHandleUrlWatchMessage(chatJid, msg, [
      makeChannel(createThread),
    ]);
    expect(handled).toBe(true);
    await flushAsyncWork();

    expect(createThread).not.toHaveBeenCalled();
    expect(storeMessageMock).toHaveBeenCalledTimes(1);
    expect(storeMessageMock).toHaveBeenCalledWith(msg);
  });

  it('URL あり + createThread が null: 元メッセージを通常保存する', async () => {
    const createThread = vi.fn(async () => null);
    const msg = makeMsg({ id: 'msg-null-thread' });

    const handled = _maybeHandleUrlWatchMessage(chatJid, msg, [
      makeChannel(createThread),
    ]);
    expect(handled).toBe(true);
    await flushAsyncWork();

    expect(releaseSpawnedThreadReservationMock).toHaveBeenCalledWith(
      'msg-null-thread',
    );
    expect(finalizeSpawnedThreadMock).not.toHaveBeenCalled();
    expect(storeMessageMock).toHaveBeenCalledTimes(1);
    expect(storeMessageMock).toHaveBeenCalledWith(msg);
  });

  it('URL あり + createThread が例外: 元メッセージを通常保存する', async () => {
    const createThread = vi.fn(async () => {
      throw new Error('createThread failed');
    });
    const msg = makeMsg({ id: 'msg-create-throws' });

    const handled = _maybeHandleUrlWatchMessage(chatJid, msg, [
      makeChannel(createThread),
    ]);
    expect(handled).toBe(true);
    await flushAsyncWork();

    expect(releaseSpawnedThreadReservationMock).toHaveBeenCalledWith(
      'msg-create-throws',
    );
    expect(finalizeSpawnedThreadMock).not.toHaveBeenCalled();
    expect(storeMessageMock).toHaveBeenCalledTimes(1);
    expect(storeMessageMock).toHaveBeenCalledWith(msg);
  });

  it('url_watch で createThread が未実装でも元メッセージを保存する', () => {
    const msg = makeMsg({ id: 'msg-no-create-thread' });
    const handled = _maybeHandleUrlWatchMessage(chatJid, msg, [makeChannel()]);
    expect(handled).toBe(true);
    expect(storeMessageMock).toHaveBeenCalledTimes(1);
    expect(storeMessageMock).toHaveBeenCalledWith(msg);
  });
});
