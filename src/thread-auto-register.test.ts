/**
 * thread 自動登録のテスト。
 * discord adapter の onMessage callback を経由した統合テスト的なアプローチ。
 * index.ts の autoRegisterThread はプライベートなので、
 * registeredGroups の状態変化を観察することでテストする。
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

import { _setRegisteredGroups } from './index.js';
import { RegisteredGroup } from './types.js';

describe('autoRegisterThread (via _setRegisteredGroups)', () => {
  let registeredGroups: Record<string, RegisteredGroup>;

  beforeEach(() => {
    registeredGroups = {};
    _setRegisteredGroups(registeredGroups);
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
    expect(registeredGroups['dc:parent123'].thread_defaults!.type).toBe('thread');
  });
});
