/**
 * thread 自動登録のテスト。
 * discord adapter の onMessage callback を経由した統合テスト的なアプローチ。
 * index.ts の autoRegisterThread は _autoRegisterThread としてエクスポートされ、
 * registeredGroups の状態変化と DB 永続化を観察することでテストする。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('./logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('./db.js', () => ({
  _initTestDatabase: vi.fn(),
  getAllRegisteredGroups: vi.fn(() => ({})),
  getAllSessions: vi.fn(() => ({})),
  getAllTasks: vi.fn(() => []),
  getAllChats: vi.fn(() => []),
  getRouterState: vi.fn(() => null),
  initDatabase: vi.fn(),
  setRegisteredGroup: vi.fn(),
  setRouterState: vi.fn(),
  setSession: vi.fn(),
  storeMessage: vi.fn(),
  storeChatMetadata: vi.fn(),
  getMessagesSince: vi.fn(() => []),
  getNewMessages: vi.fn(() => ({ messages: [], newTimestamp: '' })),
}));

vi.mock('./group-folder.js', () => ({
  resolveGroupFolderPath: vi.fn(() => '/tmp/test-group'),
  isValidGroupFolder: vi.fn(() => true),
}));

vi.mock('fs', () => ({
  default: { mkdirSync: vi.fn(), existsSync: vi.fn(() => false) },
  mkdirSync: vi.fn(),
  existsSync: vi.fn(() => false),
}));

import { _setRegisteredGroups, _autoRegisterThread } from './index.js';
import { setRegisteredGroup } from './db.js';
import { RegisteredGroup, InboundMessage } from './types.js';

describe('autoRegisterThread (via _setRegisteredGroups)', () => {
  let registeredGroups: Record<string, RegisteredGroup>;

  beforeEach(() => {
    registeredGroups = {};
    _setRegisteredGroups(registeredGroups);
    vi.clearAllMocks();
  });

  it('registeredGroups starts empty', () => {
    expect(Object.keys(registeredGroups)).toHaveLength(0);
  });

  it('manually registered parent group is accessible', () => {
    const parent: RegisteredGroup = {
      name: 'Parent',
      folder: 'discord_main',
      trigger: '@Andy',
      added_at: '2024-01-01T00:00:00.000Z',
      type: 'main',
      thread_defaults: { type: 'thread', requiresTrigger: false },
    };
    registeredGroups['dc:parent123'] = parent;
    _setRegisteredGroups(registeredGroups);

    expect(registeredGroups['dc:parent123']).toBeDefined();
    expect(registeredGroups['dc:parent123'].thread_defaults).toBeDefined();
    expect(registeredGroups['dc:parent123'].thread_defaults!.type).toBe(
      'thread',
    );
  });
});

describe('_autoRegisterThread (actual auto-registration path)', () => {
  let registeredGroups: Record<string, RegisteredGroup>;
  const parentJid = 'dc:parent123';
  const threadJid = 'dc:thread456';

  const parent: RegisteredGroup = {
    name: 'Parent',
    folder: 'discord_main',
    trigger: '@Andy',
    added_at: '2024-01-01T00:00:00.000Z',
    type: 'main',
    thread_defaults: { type: 'thread', requiresTrigger: false },
  };

  beforeEach(() => {
    registeredGroups = { [parentJid]: parent };
    _setRegisteredGroups(registeredGroups);
    vi.clearAllMocks();
  });

  it('creates a child group entry in registeredGroups', () => {
    const msg: InboundMessage = {
      id: 'msg1',
      chat_jid: threadJid,
      sender: 'user123',
      sender_name: 'Alice',
      content: 'Hello thread',
      timestamp: '2024-01-01T00:01:00.000Z',
      parent_jid: parentJid,
    };

    _autoRegisterThread(threadJid, msg, parent);

    expect(registeredGroups[threadJid]).toBeDefined();
  });

  it('auto-registered child group reflects thread_defaults.type (chat)', () => {
    const parentWithChatType: RegisteredGroup = {
      ...parent,
      thread_defaults: { type: 'chat', requiresTrigger: false },
    };
    const msg: InboundMessage = {
      id: 'msg2',
      chat_jid: threadJid,
      sender: 'user123',
      sender_name: 'Bob',
      content: 'Hi',
      timestamp: '2024-01-01T00:02:00.000Z',
      parent_jid: parentJid,
    };

    _autoRegisterThread(threadJid, msg, parentWithChatType);

    expect(registeredGroups[threadJid].type).toBe('chat');
    expect(setRegisteredGroup).toHaveBeenCalledWith(
      threadJid,
      expect.objectContaining({ type: 'chat' }),
    );
  });

  it('child group inherits folder from parent', () => {
    const msg: InboundMessage = {
      id: 'msg3',
      chat_jid: threadJid,
      sender: 'user123',
      sender_name: 'Carol',
      content: 'Test',
      timestamp: '2024-01-01T00:03:00.000Z',
      parent_jid: parentJid,
    };

    _autoRegisterThread(threadJid, msg, parent);

    expect(registeredGroups[threadJid].folder).toBe(parent.folder);
  });

  it('persists child group via setRegisteredGroup', () => {
    const msg: InboundMessage = {
      id: 'msg4',
      chat_jid: threadJid,
      sender: 'user123',
      sender_name: 'Dave',
      content: 'Test',
      timestamp: '2024-01-01T00:04:00.000Z',
      parent_jid: parentJid,
    };

    _autoRegisterThread(threadJid, msg, parent);

    expect(setRegisteredGroup).toHaveBeenCalledWith(
      threadJid,
      expect.objectContaining({ type: 'thread', folder: parent.folder }),
    );
  });

  it('child group requiresTrigger inherits from thread_defaults', () => {
    const parentWithTrigger: RegisteredGroup = {
      ...parent,
      thread_defaults: { type: 'thread', requiresTrigger: true },
    };
    const msg: InboundMessage = {
      id: 'msg5',
      chat_jid: threadJid,
      sender: 'user123',
      sender_name: 'Eve',
      content: 'Test',
      timestamp: '2024-01-01T00:05:00.000Z',
      parent_jid: parentJid,
    };

    _autoRegisterThread(threadJid, msg, parentWithTrigger);

    expect(registeredGroups[threadJid].requiresTrigger).toBe(true);
  });

  it('does not create a privileged group type even when parent is main', () => {
    const msg: InboundMessage = {
      id: 'msg6',
      chat_jid: threadJid,
      sender: 'user123',
      sender_name: 'Frank',
      content: 'Test',
      timestamp: '2024-01-01T00:06:00.000Z',
      parent_jid: parentJid,
    };

    _autoRegisterThread(threadJid, msg, parent);

    const childType = registeredGroups[threadJid].type;
    expect(childType).not.toBe('main');
    expect(childType).not.toBe('override');
    expect(childType).toBe('thread');
  });
});
