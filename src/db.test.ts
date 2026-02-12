import { describe, it, expect, beforeEach, vi } from 'vitest';

import {
  _initTestDatabase,
  _getTestDatabase,
  cleanupStaleTables,
  createTask,
  deleteTask,
  getAllChats,
  getMessagesSince,
  getNewMessages,
  getRegisteredGroup,
  getAllRegisteredGroups,
  getTaskById,
  getUserLanguage,
  setRegisteredGroup,
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
      'BotName',
    );
    expect(messages).toHaveLength(1);
    expect(messages[0].id).toBe('msg-1');
    expect(messages[0].sender).toBe('123@s.whatsapp.net');
    expect(messages[0].sender_name).toBe('Alice');
    expect(messages[0].content).toBe('hello world');
  });

  it('stores empty content', () => {
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
      'BotName',
    );
    expect(messages).toHaveLength(1);
    expect(messages[0].content).toBe('');
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
      'BotName',
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
      'BotName',
    );
    expect(messages).toHaveLength(1);
    expect(messages[0].content).toBe('updated');
  });
});

// --- getMessagesSince ---

describe('getMessagesSince', () => {
  beforeEach(() => {
    storeChatMetadata('group@g.us', '2024-01-01T00:00:00.000Z');

    const msgs = [
      {
        id: 'm1',
        content: 'first',
        ts: '2024-01-01T00:00:01.000Z',
        sender: 'Alice',
      },
      {
        id: 'm2',
        content: 'second',
        ts: '2024-01-01T00:00:02.000Z',
        sender: 'Bob',
      },
      {
        id: 'm3',
        content: 'Andy: bot reply',
        ts: '2024-01-01T00:00:03.000Z',
        sender: 'Bot',
      },
      {
        id: 'm4',
        content: 'third',
        ts: '2024-01-01T00:00:04.000Z',
        sender: 'Carol',
      },
    ];
    for (const m of msgs) {
      store({
        id: m.id,
        chat_jid: 'group@g.us',
        sender: `${m.sender}@s.whatsapp.net`,
        sender_name: m.sender,
        content: m.content,
        timestamp: m.ts,
      });
    }
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

  it('excludes messages from the assistant (content prefix)', () => {
    const msgs = getMessagesSince(
      'group@g.us',
      '2024-01-01T00:00:00.000Z',
      'Andy',
    );
    const botMsgs = msgs.filter((m) => m.content.startsWith('Andy:'));
    expect(botMsgs).toHaveLength(0);
  });

  it('returns all messages when sinceTimestamp is empty', () => {
    const msgs = getMessagesSince('group@g.us', '', 'Andy');
    // 3 user messages (bot message excluded)
    expect(msgs).toHaveLength(3);
  });
});

// --- getNewMessages ---

describe('getNewMessages', () => {
  beforeEach(() => {
    storeChatMetadata('group1@g.us', '2024-01-01T00:00:00.000Z');
    storeChatMetadata('group2@g.us', '2024-01-01T00:00:00.000Z');

    const msgs = [
      {
        id: 'a1',
        chat: 'group1@g.us',
        content: 'g1 msg1',
        ts: '2024-01-01T00:00:01.000Z',
      },
      {
        id: 'a2',
        chat: 'group2@g.us',
        content: 'g2 msg1',
        ts: '2024-01-01T00:00:02.000Z',
      },
      {
        id: 'a3',
        chat: 'group1@g.us',
        content: 'Andy: reply',
        ts: '2024-01-01T00:00:03.000Z',
      },
      {
        id: 'a4',
        chat: 'group1@g.us',
        content: 'g1 msg2',
        ts: '2024-01-01T00:00:04.000Z',
      },
    ];
    for (const m of msgs) {
      store({
        id: m.id,
        chat_jid: m.chat,
        sender: 'user@s.whatsapp.net',
        sender_name: 'User',
        content: m.content,
        timestamp: m.ts,
      });
    }
  });

  it('returns new messages across multiple groups', () => {
    const { messages, newTimestamp } = getNewMessages(
      ['group1@g.us', 'group2@g.us'],
      '2024-01-01T00:00:00.000Z',
      'Andy',
    );
    // Excludes 'Andy: reply', returns 3 messages
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

// --- getUserLanguage ---

describe('getUserLanguage', () => {
  it('returns undefined for unknown phone', () => {
    const database = _getTestDatabase();
    database.exec(`
      CREATE TABLE IF NOT EXISTS users (
        phone TEXT PRIMARY KEY, name TEXT, language TEXT DEFAULT 'mr',
        first_seen TEXT NOT NULL, last_seen TEXT NOT NULL,
        total_complaints INTEGER DEFAULT 0, is_blocked INTEGER DEFAULT 0
      );
    `);
    expect(getUserLanguage(database, '919999999999')).toBeUndefined();
  });

  it('returns stored language', () => {
    const database = _getTestDatabase();
    database.exec(`
      CREATE TABLE IF NOT EXISTS users (
        phone TEXT PRIMARY KEY, name TEXT, language TEXT DEFAULT 'mr',
        first_seen TEXT NOT NULL, last_seen TEXT NOT NULL,
        total_complaints INTEGER DEFAULT 0, is_blocked INTEGER DEFAULT 0
      );
    `);
    database
      .prepare(
        `INSERT INTO users (phone, language, first_seen, last_seen) VALUES (?, ?, ?, ?)`,
      )
      .run('919876543210', 'hi', '2024-01-01', '2024-01-01');
    expect(getUserLanguage(database, '919876543210')).toBe('hi');
  });
});

// --- JSON parse safety (registered groups) ---

describe('JSON parse safety for container_config', () => {
  it('returns undefined containerConfig for malformed JSON', () => {
    const database = _getTestDatabase();
    // Insert a group with bad JSON directly
    database
      .prepare(
        `INSERT INTO registered_groups (jid, name, folder, trigger_pattern, added_at, container_config, requires_trigger)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        'bad@g.us',
        'Bad Group',
        'bad',
        '^!',
        '2024-01-01',
        '{broken json',
        1,
      );

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const group = getRegisteredGroup('bad@g.us');
    expect(group).toBeDefined();
    expect(group!.containerConfig).toBeUndefined();
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it('returns undefined containerConfig in getAllRegisteredGroups for malformed JSON', () => {
    const database = _getTestDatabase();
    database
      .prepare(
        `INSERT INTO registered_groups (jid, name, folder, trigger_pattern, added_at, container_config, requires_trigger)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        'bad2@g.us',
        'Bad Group 2',
        'bad2',
        '^!',
        '2024-01-01',
        'not-json',
        1,
      );

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const groups = getAllRegisteredGroups();
    expect(groups['bad2@g.us']).toBeDefined();
    expect(groups['bad2@g.us'].containerConfig).toBeUndefined();
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });
});

// --- cleanupStaleTables ---

describe('cleanupStaleTables', () => {
  /** Create all tables that cleanupStaleTables touches. */
  function createCleanupTables(database: ReturnType<typeof _getTestDatabase>) {
    database.exec(`
      CREATE TABLE IF NOT EXISTS rate_limits (
        phone TEXT NOT NULL, date TEXT NOT NULL,
        message_count INTEGER DEFAULT 0,
        last_message_at TEXT, recent_timestamps TEXT,
        PRIMARY KEY (phone, date)
      );
      CREATE TABLE IF NOT EXISTS users (
        phone TEXT PRIMARY KEY, name TEXT, language TEXT DEFAULT 'mr',
        first_seen TEXT NOT NULL, last_seen TEXT NOT NULL,
        total_complaints INTEGER DEFAULT 0, is_blocked INTEGER DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS conversations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        phone TEXT NOT NULL, role TEXT NOT NULL,
        content TEXT NOT NULL, complaint_id TEXT,
        created_at TEXT NOT NULL, FOREIGN KEY (phone) REFERENCES users(phone)
      );
    `);
  }

  it('deletes messages older than retentionDays', () => {
    const database = _getTestDatabase();
    createCleanupTables(database);

    storeChatMetadata('group@g.us', '2024-01-01T00:00:00.000Z');

    // Insert old message (60 days ago)
    const oldTs = new Date(Date.now() - 60 * 86_400_000).toISOString();
    storeMessage({
      id: 'old-msg',
      chat_jid: 'group@g.us',
      sender: 'user@s.whatsapp.net',
      sender_name: 'User',
      content: 'old message',
      timestamp: oldTs,
      is_from_me: false,
    });

    // Insert recent message
    const recentTs = new Date().toISOString();
    storeMessage({
      id: 'new-msg',
      chat_jid: 'group@g.us',
      sender: 'user@s.whatsapp.net',
      sender_name: 'User',
      content: 'new message',
      timestamp: recentTs,
      is_from_me: false,
    });

    cleanupStaleTables(database, 30);

    const rows = database
      .prepare('SELECT id FROM messages')
      .all() as Array<{ id: string }>;
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe('new-msg');
  });

  it('deletes rate_limits older than 7 days', () => {
    const database = _getTestDatabase();
    createCleanupTables(database);

    const oldDate = new Date(Date.now() - 10 * 86_400_000)
      .toISOString()
      .slice(0, 10);
    const recentDate = new Date().toISOString().slice(0, 10);

    database
      .prepare(
        `INSERT INTO rate_limits (phone, date, message_count, recent_timestamps) VALUES (?, ?, 5, '[]')`,
      )
      .run('919876543210', oldDate);
    database
      .prepare(
        `INSERT INTO rate_limits (phone, date, message_count, recent_timestamps) VALUES (?, ?, 2, '[]')`,
      )
      .run('919876543210', recentDate);

    cleanupStaleTables(database, 30);

    const rows = database
      .prepare('SELECT date FROM rate_limits')
      .all() as Array<{ date: string }>;
    expect(rows).toHaveLength(1);
    expect(rows[0].date).toBe(recentDate);
  });

  it('deletes conversations older than 90 days', () => {
    const database = _getTestDatabase();
    createCleanupTables(database);

    database
      .prepare(
        `INSERT INTO users (phone, first_seen, last_seen) VALUES (?, ?, ?)`,
      )
      .run('919876543210', '2024-01-01', '2024-01-01');

    const oldTs = new Date(Date.now() - 100 * 86_400_000).toISOString();
    const recentTs = new Date().toISOString();

    database
      .prepare(
        `INSERT INTO conversations (phone, role, content, created_at) VALUES (?, ?, ?, ?)`,
      )
      .run('919876543210', 'user', 'old convo', oldTs);
    database
      .prepare(
        `INSERT INTO conversations (phone, role, content, created_at) VALUES (?, ?, ?, ?)`,
      )
      .run('919876543210', 'user', 'recent convo', recentTs);

    cleanupStaleTables(database, 30);

    const rows = database
      .prepare('SELECT content FROM conversations')
      .all() as Array<{ content: string }>;
    expect(rows).toHaveLength(1);
    expect(rows[0].content).toBe('recent convo');
  });
});
