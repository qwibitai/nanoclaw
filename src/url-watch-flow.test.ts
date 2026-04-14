import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Channel, InboundMessage, RegisteredGroup } from './types.js';

const {
  storeMessageMock,
  storeChatMetadataMock,
  getMessagesSinceMock,
  resetStoredMessages,
  setRegisteredGroupMock,
  reserveSpawnedThreadMock,
  finalizeSpawnedThreadMock,
  releaseSpawnedThreadReservationMock,
  enqueueMessageCheckMock,
  enqueueTaskMock,
  runContainerAgentMock,
  loggerErrorMock,
} = vi.hoisted(() => {
  const storedMessages: InboundMessage[] = [];
  const storeMessageMock = vi.fn((msg: InboundMessage) => {
    storedMessages.push(msg);
  });
  const getMessagesSinceMock = vi.fn(
    (chatJid: string, sinceTimestamp: string) =>
      storedMessages
        .filter(
          (m) =>
            m.chat_jid === chatJid &&
            m.timestamp > sinceTimestamp &&
            !!m.content,
        )
        .sort((a, b) => a.timestamp.localeCompare(b.timestamp))
        .map((m) => ({
          id: m.id,
          chat_jid: m.chat_jid,
          sender: m.sender,
          sender_name: m.sender_name,
          content: m.content,
          timestamp: m.timestamp,
          is_from_me: !!m.is_from_me,
        })),
  );
  return {
    storeMessageMock,
    storeChatMetadataMock: vi.fn(),
    getMessagesSinceMock,
    resetStoredMessages: () => {
      storedMessages.length = 0;
    },
    setRegisteredGroupMock: vi.fn(),
    reserveSpawnedThreadMock: vi.fn(() => true),
    finalizeSpawnedThreadMock: vi.fn(),
    releaseSpawnedThreadReservationMock: vi.fn(),
    enqueueMessageCheckMock: vi.fn(),
    enqueueTaskMock: vi.fn(),
    runContainerAgentMock: vi.fn(async () => ({ status: 'success' })),
    loggerErrorMock: vi.fn(),
  };
});

vi.mock('./logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: loggerErrorMock,
  },
}));

vi.mock('./container-runner.js', () => ({
  runContainerAgent: runContainerAgentMock,
  writeGroupsSnapshot: vi.fn(),
  writeTasksSnapshot: vi.fn(),
}));

vi.mock('./db.js', () => ({
  _initTestDatabase: vi.fn(),
  finalizeSpawnedThread: finalizeSpawnedThreadMock,
  getAllRegisteredGroups: vi.fn(() => ({})),
  getAllSessions: vi.fn(() => ({})),
  getAllTasks: vi.fn(() => []),
  getAllChats: vi.fn(() => []),
  getMessagesSince: getMessagesSinceMock,
  getNewMessages: vi.fn(() => ({ messages: [], newTimestamp: '' })),
  getRegisteredGroup: vi.fn(),
  getRouterState: vi.fn(() => null),
  initDatabase: vi.fn(),
  releaseSpawnedThreadReservation: releaseSpawnedThreadReservationMock,
  reserveSpawnedThread: reserveSpawnedThreadMock,
  setRegisteredGroup: setRegisteredGroupMock,
  setRouterState: vi.fn(),
  setSession: vi.fn(),
  storeChatMetadata: storeChatMetadataMock,
  storeMessage: storeMessageMock,
}));

vi.mock('./group-queue.js', () => ({
  GroupQueue: class {
    setProcessMessagesFn = vi.fn();
    enqueueMessageCheck(groupJid: string): void {
      enqueueMessageCheckMock(groupJid);
    }
    enqueueTask(
      groupJid: string,
      taskId: string,
      fn: () => Promise<void>,
    ): void {
      enqueueTaskMock(groupJid, taskId);
      void fn();
    }
    registerProcess = vi.fn();
    notifyIdle = vi.fn();
    closeStdin = vi.fn();
    sendMessage = vi.fn(() => false);
    shutdown = vi.fn(async () => {});
  },
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

import {
  _maybeHandleUrlWatchMessage,
  _processMessagesForGroup,
  _setRegisteredGroups,
} from './index.js';

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

async function flushAsyncWork(turns = 6): Promise<void> {
  for (let i = 0; i < turns; i += 1) {
    await Promise.resolve();
  }
}

describe('url_watch flow', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetStoredMessages();
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
    expect(createThread).toHaveBeenCalledWith(
      chatJid,
      expect.any(String),
      'msg-1',
    );
    expect(finalizeSpawnedThreadMock).toHaveBeenCalledWith(
      'msg-1',
      'dc:thread-1',
    );
    expect(setRegisteredGroupMock).toHaveBeenCalledWith(
      'dc:thread-1',
      expect.objectContaining({
        type: 'thread',
        parent_folder: 'discord_main',
      }),
    );
    expect(storeChatMetadataMock).toHaveBeenCalledWith(
      'dc:thread-1',
      '2024-01-01T00:00:01.000Z',
      expect.any(String),
      'discord',
      true,
    );
    expect(storeMessageMock).toHaveBeenCalledTimes(1);
    expect(storeMessageMock).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'msg-1_url',
        chat_jid: 'dc:thread-1',
        content: 'https://example.com/post',
      }),
    );
    const metadataCallOrder =
      storeChatMetadataMock.mock.invocationCallOrder[0] ?? -1;
    const syntheticStoreCallOrder =
      storeMessageMock.mock.invocationCallOrder[0] ?? -1;
    const enqueueTaskCallOrder =
      enqueueTaskMock.mock.invocationCallOrder[0] ?? -1;
    const finalizeCallOrder =
      finalizeSpawnedThreadMock.mock.invocationCallOrder[0] ?? -1;
    expect(metadataCallOrder).toBeLessThan(syntheticStoreCallOrder);
    expect(enqueueTaskCallOrder).toBeLessThan(finalizeCallOrder);
    expect(enqueueTaskMock).toHaveBeenCalledWith(
      'dc:thread-1',
      'url-watch-initial:msg-1',
    );
    expect(enqueueMessageCheckMock).not.toHaveBeenCalled();
    expect(runContainerAgentMock).toHaveBeenCalledTimes(1);
    const firstCall = runContainerAgentMock.mock.calls.at(0) as
      | unknown[]
      | undefined;
    const firstPrompt =
      (firstCall?.[1] as { prompt?: string } | undefined)?.prompt ?? '';
    expect(firstPrompt).toContain('https://example.com/post');
  });

  it('初期化失敗時は予約解放し元メッセージ保存へフォールバックする', async () => {
    const createThread = vi.fn(async () => 'dc:thread-init-fail');
    const msg = makeMsg({ id: 'msg-init-fail' });
    storeChatMetadataMock.mockImplementationOnce(() => {
      throw new Error('chat metadata failed');
    });

    const handled = _maybeHandleUrlWatchMessage(chatJid, msg, [
      makeChannel(createThread),
    ]);
    expect(handled).toBe(true);
    await flushAsyncWork();

    expect(releaseSpawnedThreadReservationMock).toHaveBeenCalledWith(
      'msg-init-fail',
    );
    expect(finalizeSpawnedThreadMock).not.toHaveBeenCalled();
    expect(setRegisteredGroupMock).not.toHaveBeenCalled();
    expect(storeMessageMock).toHaveBeenCalledTimes(1);
    expect(storeMessageMock).toHaveBeenCalledWith(msg);
    expect(loggerErrorMock).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceMessageId: 'msg-init-fail',
        threadJid: 'dc:thread-init-fail',
        stage: 'chat_metadata',
      }),
      'Failed to initialize URL watch thread',
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

  it('初回直接起動が失敗したらエラーログを残す', async () => {
    runContainerAgentMock.mockResolvedValueOnce({
      status: 'error',
    });
    const createThread = vi.fn(async () => 'dc:thread-direct-fail');
    const msg = makeMsg({ id: 'msg-direct-fail' });

    const handled = _maybeHandleUrlWatchMessage(chatJid, msg, [
      makeChannel(createThread),
    ]);
    expect(handled).toBe(true);
    await flushAsyncWork();

    expect(loggerErrorMock).toHaveBeenCalledWith(
      expect.objectContaining({
        chatJid,
        threadJid: 'dc:thread-direct-fail',
        sourceMessageId: 'msg-direct-fail',
      }),
      'Initial URL direct processing failed',
    );
  });

  it('url_watch で createThread が未実装でも元メッセージを保存する', () => {
    const msg = makeMsg({ id: 'msg-no-create-thread' });
    const handled = _maybeHandleUrlWatchMessage(chatJid, msg, [makeChannel()]);
    expect(handled).toBe(true);
    expect(storeMessageMock).toHaveBeenCalledTimes(1);
    expect(storeMessageMock).toHaveBeenCalledWith(msg);
  });

  it('url_watch 親配下の thread で URL あり: synthetic メッセージを保存する', () => {
    const threadJid = 'dc:thread-99';
    _setRegisteredGroups({
      [chatJid]: baseGroup,
      [threadJid]: {
        name: 'Thread',
        folder: baseGroup.folder,
        parent_folder: baseGroup.folder,
        trigger: baseGroup.trigger,
        added_at: '2024-01-01T00:00:02.000Z',
        type: 'thread',
      },
    });
    const msg = makeMsg({
      id: 'msg-thread-url',
      chat_jid: threadJid,
      content: 'please summarize https://example.com/next',
      is_thread: true,
      parent_jid: chatJid,
    });

    const handled = _maybeHandleUrlWatchMessage(threadJid, msg, [
      makeChannel(),
    ]);

    expect(handled).toBe(true);
    expect(storeMessageMock).toHaveBeenCalledTimes(1);
    expect(storeMessageMock).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'msg-thread-url_url',
        chat_jid: threadJid,
        content: 'https://example.com/next',
        parent_jid: chatJid,
        is_thread: true,
      }),
    );
    expect(reserveSpawnedThreadMock).not.toHaveBeenCalled();
  });

  it('url_watch 親配下の thread で URL 複数: 最初の URL を保存する', () => {
    const threadJid = 'dc:thread-99-multi';
    _setRegisteredGroups({
      [chatJid]: baseGroup,
      [threadJid]: {
        name: 'Thread',
        folder: baseGroup.folder,
        parent_folder: baseGroup.folder,
        trigger: baseGroup.trigger,
        added_at: '2024-01-01T00:00:02.500Z',
        type: 'thread',
      },
    });
    const msg = makeMsg({
      id: 'msg-thread-url-multi',
      chat_jid: threadJid,
      content:
        'first https://example.com/first then https://example.com/second',
      is_thread: true,
      parent_jid: chatJid,
    });

    const handled = _maybeHandleUrlWatchMessage(threadJid, msg, [
      makeChannel(),
    ]);

    expect(handled).toBe(true);
    expect(storeMessageMock).toHaveBeenCalledTimes(1);
    expect(storeMessageMock).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'msg-thread-url-multi_url',
        chat_jid: threadJid,
        content: 'https://example.com/first',
      }),
    );
    expect(reserveSpawnedThreadMock).not.toHaveBeenCalled();
  });

  it('url_watch 親配下の thread で URL なし: 元メッセージを通常保存する', () => {
    const threadJid = 'dc:thread-100';
    _setRegisteredGroups({
      [chatJid]: baseGroup,
      [threadJid]: {
        name: 'Thread',
        folder: baseGroup.folder,
        parent_folder: baseGroup.folder,
        trigger: baseGroup.trigger,
        added_at: '2024-01-01T00:00:03.000Z',
        type: 'thread',
      },
    });
    const msg = makeMsg({
      id: 'msg-thread-no-url',
      chat_jid: threadJid,
      content: 'just chatting',
      is_thread: true,
      parent_jid: chatJid,
    });

    const handled = _maybeHandleUrlWatchMessage(threadJid, msg, [
      makeChannel(),
    ]);

    expect(handled).toBe(true);
    expect(storeMessageMock).toHaveBeenCalledTimes(1);
    expect(storeMessageMock).toHaveBeenCalledWith(msg);
  });

  it('url_watch スレッド後続会話でも初回 URL をコンテキストに含める', async () => {
    const threadJid = 'dc:thread-context';
    const threadGroup: RegisteredGroup = {
      name: 'Thread',
      folder: baseGroup.folder,
      parent_folder: baseGroup.folder,
      trigger: baseGroup.trigger,
      added_at: '2024-01-01T00:00:02.000Z',
      requiresTrigger: false,
      type: 'thread',
      channel_mode: 'url_watch',
    };
    _setRegisteredGroups({
      [chatJid]: baseGroup,
      [threadJid]: threadGroup,
    });

    const initialUrl = makeMsg({
      id: 'msg-thread-seed',
      chat_jid: threadJid,
      content: 'https://example.com/root',
      timestamp: '2024-01-01T00:00:10.000Z',
      is_thread: true,
      parent_jid: chatJid,
    });
    const followup = makeMsg({
      id: 'msg-thread-followup',
      chat_jid: threadJid,
      content: 'next question without url',
      timestamp: '2024-01-01T00:00:20.000Z',
      is_thread: true,
      parent_jid: chatJid,
    });

    _maybeHandleUrlWatchMessage(threadJid, initialUrl, [makeChannel()]);
    await _processMessagesForGroup(threadJid, threadGroup, makeChannel());
    runContainerAgentMock.mockClear();
    _maybeHandleUrlWatchMessage(threadJid, followup, [makeChannel()]);
    await _processMessagesForGroup(threadJid, threadGroup, makeChannel());

    expect(runContainerAgentMock).toHaveBeenCalledTimes(1);
    const followupCall = runContainerAgentMock.mock.calls.at(0) as
      | unknown[]
      | undefined;
    const followupPrompt =
      (followupCall?.[1] as { prompt?: string } | undefined)?.prompt ?? '';
    expect(followupPrompt).toContain('https://example.com/root');
    expect(followupPrompt).toContain('next question without url');
  });

  it('url_watch 以外の親配下 thread は処理せずスキップする', () => {
    const parentJid = 'dc:parent-non-url-watch';
    const threadJid = 'dc:thread-101';
    _setRegisteredGroups({
      [parentJid]: { ...baseGroup, channel_mode: 'chat' },
      [threadJid]: {
        name: 'Thread',
        folder: baseGroup.folder,
        parent_folder: baseGroup.folder,
        trigger: baseGroup.trigger,
        added_at: '2024-01-01T00:00:04.000Z',
        type: 'thread',
      },
    });
    const msg = makeMsg({
      id: 'msg-thread-skipped',
      chat_jid: threadJid,
      content: 'https://example.com/not-handled',
      is_thread: true,
      parent_jid: parentJid,
    });

    const handled = _maybeHandleUrlWatchMessage(threadJid, msg, [
      makeChannel(),
    ]);

    expect(handled).toBe(false);
    expect(storeMessageMock).not.toHaveBeenCalled();
  });
});
