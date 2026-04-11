import { describe, it, expect, beforeEach, vi } from 'vitest';

import {
  cleanupSpawnedThreads,
  finalizeSpawnedThread,
  _parseContainerConfigJson,
  _shouldMigrateSessionKey,
  _parseThreadDefaultsJson,
  _sanitizeThreadDefaults,
  _initTestDatabase,
  createTask,
  deleteTask,
  getAllChats,
  getAllRegisteredGroups,
  getAllSessions,
  getMessagesSince,
  getNewMessages,
  getSession,
  getTaskById,
  hasSpawnedThread,
  recordSpawnedThread,
  releaseSpawnedThreadReservation,
  reserveSpawnedThread,
  setRegisteredGroup,
  setSession,
  storeChatMetadata,
  storeMessage,
  updateTask,
} from './db.js';

beforeEach(() => {
  _initTestDatabase();
});

// Helper to store a message using the normalized NewMessage interface
function store(overrides: {
  id: string;
  chat_jid: string;
  sender: string;
  sender_name: string;
  content: string;
  timestamp: string;
  is_from_me?: boolean;
}) {
  storeMessage({
    id: overrides.id,
    chat_jid: overrides.chat_jid,
    sender: overrides.sender,
    sender_name: overrides.sender_name,
    content: overrides.content,
    timestamp: overrides.timestamp,
    is_from_me: overrides.is_from_me ?? false,
  });
}

// --- storeMessage (NewMessage format) ---

describe('storeMessage', () => {
  it('stores a message and retrieves it', () => {
    storeChatMetadata('group@g.us', '2024-01-01T00:00:00.000Z');

    store({
      id: 'msg-1',
      chat_jid: 'group@g.us',
      sender: '123@s.whatsapp.net',
      sender_name: 'Alice',
      content: 'hello world',
      timestamp: '2024-01-01T00:00:01.000Z',
    });

    const messages = getMessagesSince(
      'group@g.us',
      '2024-01-01T00:00:00.000Z',
      'Andy',
    );
    expect(messages).toHaveLength(1);
    expect(messages[0].id).toBe('msg-1');
    expect(messages[0].sender).toBe('123@s.whatsapp.net');
    expect(messages[0].sender_name).toBe('Alice');
    expect(messages[0].content).toBe('hello world');
  });

  it('filters out empty content', () => {
    storeChatMetadata('group@g.us', '2024-01-01T00:00:00.000Z');

    store({
      id: 'msg-2',
      chat_jid: 'group@g.us',
      sender: '111@s.whatsapp.net',
      sender_name: 'Dave',
      content: '',
      timestamp: '2024-01-01T00:00:04.000Z',
    });

    const messages = getMessagesSince(
      'group@g.us',
      '2024-01-01T00:00:00.000Z',
      'Andy',
    );
    expect(messages).toHaveLength(0);
  });

  it('stores is_from_me flag', () => {
    storeChatMetadata('group@g.us', '2024-01-01T00:00:00.000Z');

    store({
      id: 'msg-3',
      chat_jid: 'group@g.us',
      sender: 'me@s.whatsapp.net',
      sender_name: 'Me',
      content: 'my message',
      timestamp: '2024-01-01T00:00:05.000Z',
      is_from_me: true,
    });

    // Message is stored (we can retrieve it — is_from_me doesn't affect retrieval)
    const messages = getMessagesSince(
      'group@g.us',
      '2024-01-01T00:00:00.000Z',
      'Andy',
    );
    expect(messages).toHaveLength(1);
  });

  it('upserts on duplicate id+chat_jid', () => {
    storeChatMetadata('group@g.us', '2024-01-01T00:00:00.000Z');

    store({
      id: 'msg-dup',
      chat_jid: 'group@g.us',
      sender: '123@s.whatsapp.net',
      sender_name: 'Alice',
      content: 'original',
      timestamp: '2024-01-01T00:00:01.000Z',
    });

    store({
      id: 'msg-dup',
      chat_jid: 'group@g.us',
      sender: '123@s.whatsapp.net',
      sender_name: 'Alice',
      content: 'updated',
      timestamp: '2024-01-01T00:00:01.000Z',
    });

    const messages = getMessagesSince(
      'group@g.us',
      '2024-01-01T00:00:00.000Z',
      'Andy',
    );
    expect(messages).toHaveLength(1);
    expect(messages[0].content).toBe('updated');
  });
});

// --- getMessagesSince ---

describe('getMessagesSince', () => {
  beforeEach(() => {
    storeChatMetadata('group@g.us', '2024-01-01T00:00:00.000Z');

    store({
      id: 'm1',
      chat_jid: 'group@g.us',
      sender: 'Alice@s.whatsapp.net',
      sender_name: 'Alice',
      content: 'first',
      timestamp: '2024-01-01T00:00:01.000Z',
    });
    store({
      id: 'm2',
      chat_jid: 'group@g.us',
      sender: 'Bob@s.whatsapp.net',
      sender_name: 'Bob',
      content: 'second',
      timestamp: '2024-01-01T00:00:02.000Z',
    });
    storeMessage({
      id: 'm3',
      chat_jid: 'group@g.us',
      sender: 'Bot@s.whatsapp.net',
      sender_name: 'Bot',
      content: 'bot reply',
      timestamp: '2024-01-01T00:00:03.000Z',
      is_bot_message: true,
    });
    store({
      id: 'm4',
      chat_jid: 'group@g.us',
      sender: 'Carol@s.whatsapp.net',
      sender_name: 'Carol',
      content: 'third',
      timestamp: '2024-01-01T00:00:04.000Z',
    });
  });

  it('returns messages after the given timestamp', () => {
    const msgs = getMessagesSince(
      'group@g.us',
      '2024-01-01T00:00:02.000Z',
      'Andy',
    );
    // Should exclude m1, m2 (before/at timestamp), m3 (bot message)
    expect(msgs).toHaveLength(1);
    expect(msgs[0].content).toBe('third');
  });

  it('excludes bot messages via is_bot_message flag', () => {
    const msgs = getMessagesSince(
      'group@g.us',
      '2024-01-01T00:00:00.000Z',
      'Andy',
    );
    const botMsgs = msgs.filter((m) => m.content === 'bot reply');
    expect(botMsgs).toHaveLength(0);
  });

  it('returns all non-bot messages when sinceTimestamp is empty', () => {
    const msgs = getMessagesSince('group@g.us', '', 'Andy');
    // 3 user messages (bot message excluded)
    expect(msgs).toHaveLength(3);
  });

  it('filters pre-migration bot messages via content prefix backstop', () => {
    // Simulate a message written before migration: has prefix but is_bot_message = 0
    store({
      id: 'm5',
      chat_jid: 'group@g.us',
      sender: 'Bot@s.whatsapp.net',
      sender_name: 'Bot',
      content: 'Andy: old bot reply',
      timestamp: '2024-01-01T00:00:05.000Z',
    });
    const msgs = getMessagesSince(
      'group@g.us',
      '2024-01-01T00:00:04.000Z',
      'Andy',
    );
    expect(msgs).toHaveLength(0);
  });
});

// --- getNewMessages ---

describe('getNewMessages', () => {
  beforeEach(() => {
    storeChatMetadata('group1@g.us', '2024-01-01T00:00:00.000Z');
    storeChatMetadata('group2@g.us', '2024-01-01T00:00:00.000Z');

    store({
      id: 'a1',
      chat_jid: 'group1@g.us',
      sender: 'user@s.whatsapp.net',
      sender_name: 'User',
      content: 'g1 msg1',
      timestamp: '2024-01-01T00:00:01.000Z',
    });
    store({
      id: 'a2',
      chat_jid: 'group2@g.us',
      sender: 'user@s.whatsapp.net',
      sender_name: 'User',
      content: 'g2 msg1',
      timestamp: '2024-01-01T00:00:02.000Z',
    });
    storeMessage({
      id: 'a3',
      chat_jid: 'group1@g.us',
      sender: 'user@s.whatsapp.net',
      sender_name: 'User',
      content: 'bot reply',
      timestamp: '2024-01-01T00:00:03.000Z',
      is_bot_message: true,
    });
    store({
      id: 'a4',
      chat_jid: 'group1@g.us',
      sender: 'user@s.whatsapp.net',
      sender_name: 'User',
      content: 'g1 msg2',
      timestamp: '2024-01-01T00:00:04.000Z',
    });
  });

  it('returns new messages across multiple groups', () => {
    const { messages, newTimestamp } = getNewMessages(
      ['group1@g.us', 'group2@g.us'],
      '2024-01-01T00:00:00.000Z',
      'Andy',
    );
    // Excludes bot message, returns 3 user messages
    expect(messages).toHaveLength(3);
    expect(newTimestamp).toBe('2024-01-01T00:00:04.000Z');
  });

  it('filters by timestamp', () => {
    const { messages } = getNewMessages(
      ['group1@g.us', 'group2@g.us'],
      '2024-01-01T00:00:02.000Z',
      'Andy',
    );
    // Only g1 msg2 (after ts, not bot)
    expect(messages).toHaveLength(1);
    expect(messages[0].content).toBe('g1 msg2');
  });

  it('returns empty for no registered groups', () => {
    const { messages, newTimestamp } = getNewMessages([], '', 'Andy');
    expect(messages).toHaveLength(0);
    expect(newTimestamp).toBe('');
  });
});

// --- storeChatMetadata ---

describe('storeChatMetadata', () => {
  it('stores chat with JID as default name', () => {
    storeChatMetadata('group@g.us', '2024-01-01T00:00:00.000Z');
    const chats = getAllChats();
    expect(chats).toHaveLength(1);
    expect(chats[0].jid).toBe('group@g.us');
    expect(chats[0].name).toBe('group@g.us');
  });

  it('stores chat with explicit name', () => {
    storeChatMetadata('group@g.us', '2024-01-01T00:00:00.000Z', 'My Group');
    const chats = getAllChats();
    expect(chats[0].name).toBe('My Group');
  });

  it('updates name on subsequent call with name', () => {
    storeChatMetadata('group@g.us', '2024-01-01T00:00:00.000Z');
    storeChatMetadata('group@g.us', '2024-01-01T00:00:01.000Z', 'Updated Name');
    const chats = getAllChats();
    expect(chats).toHaveLength(1);
    expect(chats[0].name).toBe('Updated Name');
  });

  it('preserves newer timestamp on conflict', () => {
    storeChatMetadata('group@g.us', '2024-01-01T00:00:05.000Z');
    storeChatMetadata('group@g.us', '2024-01-01T00:00:01.000Z');
    const chats = getAllChats();
    expect(chats[0].last_message_time).toBe('2024-01-01T00:00:05.000Z');
  });
});

// --- Task CRUD ---

describe('task CRUD', () => {
  it('creates and retrieves a task', () => {
    createTask({
      id: 'task-1',
      group_folder: 'main',
      chat_jid: 'group@g.us',
      prompt: 'do something',
      schedule_type: 'once',
      schedule_value: '2024-06-01T00:00:00.000Z',
      context_mode: 'isolated',
      next_run: '2024-06-01T00:00:00.000Z',
      status: 'active',
      created_at: '2024-01-01T00:00:00.000Z',
    });

    const task = getTaskById('task-1');
    expect(task).toBeDefined();
    expect(task!.prompt).toBe('do something');
    expect(task!.status).toBe('active');
  });

  it('updates task status', () => {
    createTask({
      id: 'task-2',
      group_folder: 'main',
      chat_jid: 'group@g.us',
      prompt: 'test',
      schedule_type: 'once',
      schedule_value: '2024-06-01T00:00:00.000Z',
      context_mode: 'isolated',
      next_run: null,
      status: 'active',
      created_at: '2024-01-01T00:00:00.000Z',
    });

    updateTask('task-2', { status: 'paused' });
    expect(getTaskById('task-2')!.status).toBe('paused');
  });

  it('deletes a task and its run logs', () => {
    createTask({
      id: 'task-3',
      group_folder: 'main',
      chat_jid: 'group@g.us',
      prompt: 'delete me',
      schedule_type: 'once',
      schedule_value: '2024-06-01T00:00:00.000Z',
      context_mode: 'isolated',
      next_run: null,
      status: 'active',
      created_at: '2024-01-01T00:00:00.000Z',
    });

    deleteTask('task-3');
    expect(getTaskById('task-3')).toBeUndefined();
  });
});

// --- LIMIT behavior ---

describe('message query LIMIT', () => {
  beforeEach(() => {
    storeChatMetadata('group@g.us', '2024-01-01T00:00:00.000Z');

    for (let i = 1; i <= 10; i++) {
      store({
        id: `lim-${i}`,
        chat_jid: 'group@g.us',
        sender: 'user@s.whatsapp.net',
        sender_name: 'User',
        content: `message ${i}`,
        timestamp: `2024-01-01T00:00:${String(i).padStart(2, '0')}.000Z`,
      });
    }
  });

  it('getNewMessages caps to limit and returns most recent in chronological order', () => {
    const { messages, newTimestamp } = getNewMessages(
      ['group@g.us'],
      '2024-01-01T00:00:00.000Z',
      'Andy',
      3,
    );
    expect(messages).toHaveLength(3);
    expect(messages[0].content).toBe('message 8');
    expect(messages[2].content).toBe('message 10');
    // Chronological order preserved
    expect(messages[1].timestamp > messages[0].timestamp).toBe(true);
    // newTimestamp reflects latest returned row
    expect(newTimestamp).toBe('2024-01-01T00:00:10.000Z');
  });

  it('getMessagesSince caps to limit and returns most recent in chronological order', () => {
    const messages = getMessagesSince(
      'group@g.us',
      '2024-01-01T00:00:00.000Z',
      'Andy',
      3,
    );
    expect(messages).toHaveLength(3);
    expect(messages[0].content).toBe('message 8');
    expect(messages[2].content).toBe('message 10');
    expect(messages[1].timestamp > messages[0].timestamp).toBe(true);
  });

  it('returns all messages when count is under the limit', () => {
    const { messages } = getNewMessages(
      ['group@g.us'],
      '2024-01-01T00:00:00.000Z',
      'Andy',
      50,
    );
    expect(messages).toHaveLength(10);
  });
});

// --- RegisteredGroup GroupType round-trip ---

describe('registered group type', () => {
  it('persists type=main through set/get round-trip', () => {
    setRegisteredGroup('main@s.whatsapp.net', {
      name: 'Main Chat',
      folder: 'whatsapp_main',
      trigger: '@Andy',
      added_at: '2024-01-01T00:00:00.000Z',
      type: 'main',
    });

    const groups = getAllRegisteredGroups();
    const group = groups['main@s.whatsapp.net'];
    expect(group).toBeDefined();
    expect(group.type).toBe('main');
    expect(group.folder).toBe('whatsapp_main');
  });

  it('defaults to chat type for non-main groups', () => {
    setRegisteredGroup('group@g.us', {
      name: 'Family Chat',
      folder: 'whatsapp_family-chat',
      trigger: '@Andy',
      added_at: '2024-01-01T00:00:00.000Z',
    });

    const groups = getAllRegisteredGroups();
    const group = groups['group@g.us'];
    expect(group).toBeDefined();
    expect(group.type).toBe('chat');
  });

  it('persists all GroupType values', () => {
    const types = ['override', 'main', 'chat', 'thread'] as const;
    for (const t of types) {
      const jid = `test-${t}@g.us`;
      const folder = `whatsapp_test-${t}`;
      setRegisteredGroup(jid, {
        name: `Test ${t}`,
        folder,
        trigger: '@Andy',
        added_at: '2024-01-01T00:00:00.000Z',
        type: t,
      });
      const groups = getAllRegisteredGroups();
      expect(groups[jid].type).toBe(t);
    }
  });

  it('persists thread_defaults through set/get round-trip', () => {
    setRegisteredGroup('dc:parent123', {
      name: 'Parent Channel',
      folder: 'discord_main',
      trigger: '@Andy',
      added_at: '2024-01-01T00:00:00.000Z',
      type: 'main',
      thread_defaults: {
        type: 'thread',
        requiresTrigger: false,
        containerConfig: { timeout: 120000 },
      },
    });

    const groups = getAllRegisteredGroups();
    const group = groups['dc:parent123'];
    expect(group).toBeDefined();
    expect(group.thread_defaults).toBeDefined();
    expect(group.thread_defaults!.type).toBe('thread');
    expect(group.thread_defaults!.requiresTrigger).toBe(false);
    expect(group.thread_defaults!.containerConfig?.timeout).toBe(120000);
  });

  it('returns undefined thread_defaults when not set', () => {
    setRegisteredGroup('dc:nocfg', {
      name: 'No Config',
      folder: 'discord_nocfg',
      trigger: '@Andy',
      added_at: '2024-01-01T00:00:00.000Z',
    });

    const groups = getAllRegisteredGroups();
    expect(groups['dc:nocfg'].thread_defaults).toBeUndefined();
  });

  it('persists parent_folder and channel_mode through set/get round-trip', () => {
    setRegisteredGroup('dc:urlwatch', {
      name: 'URL Watch Parent',
      folder: 'discord_urlwatch',
      parent_folder: 'discord_parent',
      trigger: '@Andy',
      added_at: '2024-01-01T00:00:00.000Z',
      channel_mode: 'url_watch',
      type: 'chat',
    });

    const groups = getAllRegisteredGroups();
    expect(groups['dc:urlwatch'].parent_folder).toBe('discord_parent');
    expect(groups['dc:urlwatch'].channel_mode).toBe('url_watch');
  });

  it('handles malformed thread_defaults JSON safely', () => {
    expect(_parseThreadDefaultsJson('{bad-json', 'dc:broken')).toBeUndefined();
  });

  it('sanitizes invalid thread_defaults.type to non-privileged fields only', () => {
    expect(
      _sanitizeThreadDefaults(
        { type: 'main', requiresTrigger: true },
        'dc:broken-type',
      ),
    ).toEqual({ requiresTrigger: true });
  });

  it('handles malformed container_config JSON safely', () => {
    expect(_parseContainerConfigJson('{bad-json', 'dc:broken')).toBeUndefined();
  });

  it('allows parent and thread groups to share the same folder', () => {
    setRegisteredGroup('dc:parent', {
      name: 'Parent',
      folder: 'discord_shared',
      trigger: '@Andy',
      added_at: '2024-01-01T00:00:00.000Z',
      type: 'main',
    });
    setRegisteredGroup('dc:thread1', {
      name: 'Thread',
      folder: 'discord_shared',
      trigger: '@Andy',
      added_at: '2024-01-01T00:01:00.000Z',
      type: 'thread',
    });

    const groups = getAllRegisteredGroups();
    expect(groups['dc:parent']).toBeDefined();
    expect(groups['dc:thread1']).toBeDefined();
    expect(groups['dc:parent'].folder).toBe('discord_shared');
    expect(groups['dc:thread1'].folder).toBe('discord_shared');
  });
});

// --- Session accessors (jid-keyed) ---

describe('session accessors', () => {
  it('sets and retrieves session by jid', () => {
    setSession('dc:123456789', 'sess-abc');
    expect(getSession('dc:123456789')).toBe('sess-abc');
  });

  it('returns undefined for unknown jid', () => {
    expect(getSession('dc:unknown')).toBeUndefined();
  });

  it('overwrites existing session', () => {
    setSession('dc:111', 'sess-old');
    setSession('dc:111', 'sess-new');
    expect(getSession('dc:111')).toBe('sess-new');
  });

  it('getAllSessions returns all sessions keyed by jid', () => {
    setSession('dc:aaa', 'sess-1');
    setSession('dc:bbb', 'sess-2');
    const sessions = getAllSessions();
    expect(sessions['dc:aaa']).toBe('sess-1');
    expect(sessions['dc:bbb']).toBe('sess-2');
  });

  it('parent and thread groups have independent sessions', () => {
    setSession('dc:parent', 'parent-sess');
    setSession('dc:thread', 'thread-sess');
    expect(getSession('dc:parent')).toBe('parent-sess');
    expect(getSession('dc:thread')).toBe('thread-sess');
  });
});

describe('_shouldMigrateSessionKey', () => {
  it('accepts protocol-prefixed keys', () => {
    expect(_shouldMigrateSessionKey('dc:123456')).toBe(true);
  });

  it('accepts WhatsApp JID-style keys', () => {
    expect(_shouldMigrateSessionKey('123456@g.us')).toBe(true);
    expect(_shouldMigrateSessionKey('123456@s.whatsapp.net')).toBe(true);
  });

  it('rejects legacy folder keys', () => {
    expect(_shouldMigrateSessionKey('discord_main')).toBe(false);
    expect(_shouldMigrateSessionKey('my-group_folder')).toBe(false);
  });

  it('rejects non-JID garbled keys', () => {
    expect(_shouldMigrateSessionKey('!!!invalid!!!')).toBe(false);
    expect(_shouldMigrateSessionKey('user@invalid-domain')).toBe(false);
  });
});

describe('spawned thread accessors', () => {
  it('hasSpawnedThread returns false for unknown source_message_id', () => {
    expect(hasSpawnedThread('missing-id')).toBe(false);
  });

  it('hasSpawnedThread returns true after recordSpawnedThread', () => {
    const inserted = recordSpawnedThread(
      'msg-1',
      'dc:thread1',
      'url',
      'https://example.com',
    );
    expect(inserted).toBe(true);
    expect(hasSpawnedThread('msg-1')).toBe(true);
  });

  it('recordSpawnedThread ignores duplicate source_message_id without error', () => {
    const first = recordSpawnedThread(
      'msg-dup',
      'dc:thread1',
      'url',
      'https://example.com/1',
    );
    const second = recordSpawnedThread(
      'msg-dup',
      'dc:thread2',
      'url',
      'https://example.com/2',
    );

    expect(first).toBe(true);
    expect(second).toBe(false);
    expect(hasSpawnedThread('msg-dup')).toBe(true);
  });

  it('allows re-reserving a pending row after the reservation is released', () => {
    const reserved = reserveSpawnedThread(
      'msg-pending-expired',
      'url',
      'https://example.com/pending-expired',
    );
    expect(reserved).toBe(true);

    const reservedWhilePending = reserveSpawnedThread(
      'msg-pending-expired',
      'url',
      'https://example.com/pending-expired',
    );
    expect(reservedWhilePending).toBe(false);

    releaseSpawnedThreadReservation('msg-pending-expired');

    const reservedAgain = reserveSpawnedThread(
      'msg-pending-expired',
      'url',
      'https://example.com/pending-expired',
    );
    expect(reservedAgain).toBe(true);
  });

  it('reserve/finalize/release flow keeps dedupe atomic for pending rows', () => {
    const reserved = reserveSpawnedThread(
      'msg-pending',
      'url',
      'https://example',
    );
    const reservedAgain = reserveSpawnedThread(
      'msg-pending',
      'url',
      'https://example',
    );
    expect(reserved).toBe(true);
    expect(reservedAgain).toBe(false);

    finalizeSpawnedThread('msg-pending', 'dc:thread-final');
    expect(hasSpawnedThread('msg-pending')).toBe(true);

    releaseSpawnedThreadReservation('msg-pending');
    expect(hasSpawnedThread('msg-pending')).toBe(true);
  });
});

describe('cleanupSpawnedThreads', () => {
  it('deletes only rows older than retention window', () => {
    const now = new Date('2026-01-31T00:00:00.000Z');
    const old = new Date(
      now.getTime() - 31 * 24 * 60 * 60 * 1000,
    ).toISOString();
    const fresh = new Date(
      now.getTime() - 10 * 24 * 60 * 60 * 1000,
    ).toISOString();

    recordSpawnedThread('old-msg', 'dc:old', 'url', 'https://old.example', old);
    recordSpawnedThread(
      'fresh-msg',
      'dc:fresh',
      'url',
      'https://fresh.example',
      fresh,
    );

    const deleted = cleanupSpawnedThreads(now, 30);
    expect(deleted).toBe(1);
    expect(hasSpawnedThread('old-msg')).toBe(false);
    expect(hasSpawnedThread('fresh-msg')).toBe(true);
  });
});
