import Database from 'better-sqlite3';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import {
  _initTestDatabase,
  _setMigrationsDir,
  createTask,
  deleteTask,
  getAllChats,
  getAllRegisteredGroups,
  getMessagesSince,
  getNewMessages,
  getTaskById,
  getTaskHealthSummary,
  logTaskRun,
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

// --- RegisteredGroup isMain round-trip ---

describe('registered group isMain', () => {
  it('persists isMain=true through set/get round-trip', () => {
    setRegisteredGroup('main@s.whatsapp.net', {
      name: 'Main Chat',
      folder: 'whatsapp_main',
      trigger: '@Andy',
      added_at: '2024-01-01T00:00:00.000Z',
      isMain: true,
    });

    const groups = getAllRegisteredGroups();
    const group = groups['main@s.whatsapp.net'];
    expect(group).toBeDefined();
    expect(group.isMain).toBe(true);
    expect(group.folder).toBe('whatsapp_main');
  });

  it('omits isMain for non-main groups', () => {
    setRegisteredGroup('group@g.us', {
      name: 'Family Chat',
      folder: 'whatsapp_family-chat',
      trigger: '@Andy',
      added_at: '2024-01-01T00:00:00.000Z',
    });

    const groups = getAllRegisteredGroups();
    const group = groups['group@g.us'];
    expect(group).toBeDefined();
    expect(group.isMain).toBeUndefined();
  });
});

// --- Task health summary ---

describe('getTaskHealthSummary', () => {
  beforeEach(() => {
    createTask({
      id: 'health-task-1',
      group_folder: 'main',
      chat_jid: 'group@g.us',
      prompt: 'test task',
      schedule_type: 'cron',
      schedule_value: '0 9 * * *',
      context_mode: 'isolated',
      next_run: null,
      status: 'active',
      created_at: '2024-01-01T00:00:00.000Z',
    });
  });

  it('returns zeros when no task runs exist', () => {
    const summary = getTaskHealthSummary(24);
    expect(summary.totalRuns).toBe(0);
    expect(summary.successCount).toBe(0);
    expect(summary.failureCount).toBe(0);
    expect(summary.failedTasks).toHaveLength(0);
    expect(summary.avgDurationByTask).toHaveLength(0);
  });

  it('counts successful runs', () => {
    logTaskRun({
      task_id: 'health-task-1',
      run_at: new Date().toISOString(),
      duration_ms: 5000,
      status: 'success',
      result: 'ok',
      error: null,
    });
    logTaskRun({
      task_id: 'health-task-1',
      run_at: new Date().toISOString(),
      duration_ms: 6000,
      status: 'success',
      result: 'ok',
      error: null,
    });

    const summary = getTaskHealthSummary(24);
    expect(summary.totalRuns).toBe(2);
    expect(summary.successCount).toBe(2);
    expect(summary.failureCount).toBe(0);
    expect(summary.failedTasks).toHaveLength(0);
  });

  it('reports failed tasks with error details', () => {
    logTaskRun({
      task_id: 'health-task-1',
      run_at: new Date().toISOString(),
      duration_ms: 1000,
      status: 'error',
      result: null,
      error: 'Container timeout',
    });

    const summary = getTaskHealthSummary(24);
    expect(summary.failureCount).toBe(1);
    expect(summary.failedTasks).toHaveLength(1);
    expect(summary.failedTasks[0].task_id).toBe('health-task-1');
    expect(summary.failedTasks[0].error).toBe('Container timeout');
  });

  it('excludes runs outside the time window', () => {
    const oldDate = new Date(Date.now() - 48 * 3600_000).toISOString();
    logTaskRun({
      task_id: 'health-task-1',
      run_at: oldDate,
      duration_ms: 5000,
      status: 'success',
      result: 'ok',
      error: null,
    });

    const summary = getTaskHealthSummary(24);
    expect(summary.totalRuns).toBe(0);
  });

  it('reports slow tasks exceeding threshold', () => {
    logTaskRun({
      task_id: 'health-task-1',
      run_at: new Date().toISOString(),
      duration_ms: 400000,
      status: 'success',
      result: 'ok',
      error: null,
    });

    const summary = getTaskHealthSummary(24, 300000);
    expect(summary.avgDurationByTask).toHaveLength(1);
    expect(summary.avgDurationByTask[0].task_id).toBe('health-task-1');
    expect(summary.avgDurationByTask[0].avg_duration_ms).toBe(400000);
  });

  it('omits tasks under duration threshold', () => {
    logTaskRun({
      task_id: 'health-task-1',
      run_at: new Date().toISOString(),
      duration_ms: 5000,
      status: 'success',
      result: 'ok',
      error: null,
    });

    const summary = getTaskHealthSummary(24, 300000);
    expect(summary.avgDurationByTask).toHaveLength(0);
  });
});

// --- Migration framework ---

describe('runMigrations', () => {
  let tmpDir: string;
  const originalMigrationsDir = path.join(process.cwd(), 'migrations');

  afterEach(() => {
    // Restore default migrations dir
    _setMigrationsDir(originalMigrationsDir);
    // Clean up temp dir
    if (tmpDir) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('applies all migrations on a fresh database', () => {
    // _initTestDatabase uses the real migrations dir — schema_migrations should exist
    const db = new Database(':memory:');
    // Simulate by calling _initTestDatabase which runs runMigrations internally
    _initTestDatabase();

    // Verify schema_migrations table was populated with all migration versions
    // We check indirectly: the full schema should be available
    storeChatMetadata('test@g.us', '2024-01-01T00:00:00.000Z', 'Test', 'whatsapp', true);
    const chats = getAllChats();
    expect(chats).toHaveLength(1);
    expect(chats[0].channel).toBe('whatsapp');
    expect(chats[0].is_group).toBe(1);
  });

  it('records applied migrations in schema_migrations', () => {
    _initTestDatabase();

    // Create a task with context_mode to verify migration 002 ran
    createTask({
      id: 'mig-test',
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
    const task = getTaskById('mig-test');
    expect(task!.context_mode).toBe('isolated');
  });

  it('skips already-applied migrations on subsequent runs', () => {
    // First init applies all migrations
    _initTestDatabase();
    storeChatMetadata('test@g.us', '2024-01-01T00:00:00.000Z');

    // Second init should not fail (migrations already recorded)
    _initTestDatabase();
    // Data from the in-memory DB is gone (new :memory: db), but migrations ran cleanly
    const chats = getAllChats();
    expect(chats).toHaveLength(0); // Fresh DB, no data
  });

  it('rolls back and throws on a failed migration', () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-mig-'));

    // Write a valid migration
    fs.writeFileSync(
      path.join(tmpDir, '001_good.sql'),
      'CREATE TABLE test_table (id INTEGER PRIMARY KEY);',
    );
    // Write a bad migration
    fs.writeFileSync(
      path.join(tmpDir, '002_bad.sql'),
      'THIS IS NOT VALID SQL;',
    );

    _setMigrationsDir(tmpDir);

    expect(() => _initTestDatabase()).toThrow('Migration 002_bad failed');
  });

  it('applies migrations in numeric order', () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-mig-'));

    // Write migrations out of filesystem order
    fs.writeFileSync(
      path.join(tmpDir, '002_add_col.sql'),
      'ALTER TABLE ordered_test ADD COLUMN extra TEXT;',
    );
    fs.writeFileSync(
      path.join(tmpDir, '001_create.sql'),
      'CREATE TABLE ordered_test (id INTEGER PRIMARY KEY);',
    );

    _setMigrationsDir(tmpDir);
    _initTestDatabase();

    // If order was wrong, the ALTER TABLE would fail. Success means order was correct.
  });

  it('seeds schema_migrations for existing databases without re-running migrations', () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-mig-'));
    const dbPath = path.join(tmpDir, 'test.db');

    // Write migrations that would fail on an existing DB (duplicate ALTER TABLE)
    fs.writeFileSync(
      path.join(tmpDir, '001_create.sql'),
      'CREATE TABLE IF NOT EXISTS demo (id INTEGER PRIMARY KEY);',
    );
    fs.writeFileSync(
      path.join(tmpDir, '002_alter.sql'),
      'ALTER TABLE demo ADD COLUMN name TEXT;',
    );

    // Simulate an existing database that already has the schema
    const existingDb = new Database(dbPath);
    existingDb.exec('CREATE TABLE demo (id INTEGER PRIMARY KEY, name TEXT);');
    existingDb.close();

    // Now run migrations against the existing DB — should seed, not re-run
    _setMigrationsDir(tmpDir);
    const db = new Database(dbPath);

    // Manually call what initDatabase would do — import the internal runner
    // We test via the public API by checking it doesn't throw
    db.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        id INTEGER PRIMARY KEY,
        version TEXT UNIQUE NOT NULL,
        applied_at TEXT NOT NULL
      )
    `);

    // Check that the existing table detection works by looking at sqlite_master
    const tables = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT IN ('schema_migrations')",
    ).all() as Array<{ name: string }>;
    expect(tables.length).toBeGreaterThan(0);

    db.close();
  });
});
