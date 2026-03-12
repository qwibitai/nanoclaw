import { describe, it, expect, beforeEach } from 'vitest';

import {
  _initTestDatabase,
  createTask,
  deleteTask,
  getAllChats,
  getAllRegisteredGroups,
  getMessagesSince,
  getNewMessages,
  getRecentMessages,
  getRecentMessagesByThread,
  getTaskById,
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

// --- getRecentMessages ---

describe('getRecentMessages', () => {
  it('returns recent messages including bot messages', () => {
    storeChatMetadata('gchat:pm-agent', '2024-01-01T00:00:00.000Z');

    storeMessage({
      id: 'msg-user-1',
      chat_jid: 'gchat:pm-agent',
      sender: 'craig@gorillahub.co.uk',
      sender_name: 'Craig',
      content: 'Hello Holly',
      timestamp: '2024-01-01T00:00:01.000Z',
      is_from_me: false,
      is_bot_message: false,
    });

    storeMessage({
      id: 'msg-bot-1',
      chat_jid: 'gchat:pm-agent',
      sender: 'Holly',
      sender_name: 'Holly',
      content: 'Hello Craig! How can I help?',
      timestamp: '2024-01-01T00:00:02.000Z',
      is_from_me: true,
      is_bot_message: true,
    });

    const messages = getRecentMessages('gchat:pm-agent', 20);
    expect(messages).toHaveLength(2);
    expect(messages[0].content).toBe('Hello Holly');
    expect(messages[1].content).toBe('Hello Craig! How can I help?');
  });

  it('returns messages in chronological order', () => {
    storeChatMetadata('gchat:pm-agent', '2024-01-01T00:00:00.000Z');

    // Store out of order
    storeMessage({
      id: 'msg-3',
      chat_jid: 'gchat:pm-agent',
      sender: 'Craig',
      sender_name: 'Craig',
      content: 'Third',
      timestamp: '2024-01-01T00:00:03.000Z',
      is_from_me: false,
    });

    storeMessage({
      id: 'msg-1',
      chat_jid: 'gchat:pm-agent',
      sender: 'Craig',
      sender_name: 'Craig',
      content: 'First',
      timestamp: '2024-01-01T00:00:01.000Z',
      is_from_me: false,
    });

    storeMessage({
      id: 'msg-2',
      chat_jid: 'gchat:pm-agent',
      sender: 'Holly',
      sender_name: 'Holly',
      content: 'Second',
      timestamp: '2024-01-01T00:00:02.000Z',
      is_from_me: true,
      is_bot_message: true,
    });

    const messages = getRecentMessages('gchat:pm-agent', 20);
    expect(messages).toHaveLength(3);
    expect(messages[0].content).toBe('First');
    expect(messages[1].content).toBe('Second');
    expect(messages[2].content).toBe('Third');
  });

  it('respects the limit parameter', () => {
    storeChatMetadata('gchat:pm-agent', '2024-01-01T00:00:00.000Z');

    for (let i = 1; i <= 5; i++) {
      storeMessage({
        id: `msg-${i}`,
        chat_jid: 'gchat:pm-agent',
        sender: 'Craig',
        sender_name: 'Craig',
        content: `Message ${i}`,
        timestamp: `2024-01-01T00:00:0${i}.000Z`,
        is_from_me: false,
      });
    }

    const messages = getRecentMessages('gchat:pm-agent', 3);
    expect(messages).toHaveLength(3);
    // Should return the MOST RECENT 3, in chronological order
    expect(messages[0].content).toBe('Message 3');
    expect(messages[1].content).toBe('Message 4');
    expect(messages[2].content).toBe('Message 5');
  });

  it('excludes empty content messages', () => {
    storeChatMetadata('gchat:pm-agent', '2024-01-01T00:00:00.000Z');

    storeMessage({
      id: 'msg-empty',
      chat_jid: 'gchat:pm-agent',
      sender: 'Craig',
      sender_name: 'Craig',
      content: '',
      timestamp: '2024-01-01T00:00:01.000Z',
      is_from_me: false,
    });

    storeMessage({
      id: 'msg-real',
      chat_jid: 'gchat:pm-agent',
      sender: 'Craig',
      sender_name: 'Craig',
      content: 'Real message',
      timestamp: '2024-01-01T00:00:02.000Z',
      is_from_me: false,
    });

    const messages = getRecentMessages('gchat:pm-agent', 20);
    expect(messages).toHaveLength(1);
    expect(messages[0].content).toBe('Real message');
  });

  it('only returns messages for the specified chat_jid', () => {
    storeChatMetadata('gchat:pm-agent', '2024-01-01T00:00:00.000Z');
    storeChatMetadata('other@g.us', '2024-01-01T00:00:00.000Z');

    storeMessage({
      id: 'msg-gchat',
      chat_jid: 'gchat:pm-agent',
      sender: 'Craig',
      sender_name: 'Craig',
      content: 'Google Chat message',
      timestamp: '2024-01-01T00:00:01.000Z',
      is_from_me: false,
    });

    storeMessage({
      id: 'msg-wa',
      chat_jid: 'other@g.us',
      sender: 'Craig',
      sender_name: 'Craig',
      content: 'WhatsApp message',
      timestamp: '2024-01-01T00:00:01.000Z',
      is_from_me: false,
    });

    const messages = getRecentMessages('gchat:pm-agent', 20);
    expect(messages).toHaveLength(1);
    expect(messages[0].content).toBe('Google Chat message');
  });

  it('returns empty array when no messages exist', () => {
    const messages = getRecentMessages('gchat:nonexistent', 20);
    expect(messages).toHaveLength(0);
  });
});

// --- getRecentMessagesByThread ---

describe('getRecentMessagesByThread', () => {
  const CHAT_JID = 'gchat:pm-agent';
  const THREAD_A = 'spaces/xxx/threads/thread-a';
  const THREAD_B = 'spaces/xxx/threads/thread-b';

  beforeEach(() => {
    storeChatMetadata(CHAT_JID, '2024-01-01T00:00:00.000Z');

    // Thread A: M365 migration discussion
    storeMessage({
      id: 'ta-1',
      chat_jid: CHAT_JID,
      sender: 'craig@gorillahub.co.uk',
      sender_name: 'Craig',
      content: 'Lets talk about M365 migration',
      timestamp: '2024-01-01T00:00:01.000Z',
      is_from_me: false,
      thread_id: THREAD_A,
    });

    storeMessage({
      id: 'ta-2',
      chat_jid: CHAT_JID,
      sender: 'Holly',
      sender_name: 'Holly',
      content: 'Sure, here is the migration plan...',
      timestamp: '2024-01-01T00:00:02.000Z',
      is_from_me: true,
      is_bot_message: true,
      thread_id: THREAD_A,
    });

    // Thread B: Task management discussion
    storeMessage({
      id: 'tb-1',
      chat_jid: CHAT_JID,
      sender: 'craig@gorillahub.co.uk',
      sender_name: 'Craig',
      content: 'Lets discuss task management',
      timestamp: '2024-01-01T00:00:03.000Z',
      is_from_me: false,
      thread_id: THREAD_B,
    });

    storeMessage({
      id: 'tb-2',
      chat_jid: CHAT_JID,
      sender: 'Holly',
      sender_name: 'Holly',
      content: 'Here is the autonomous execution plan...',
      timestamp: '2024-01-01T00:00:04.000Z',
      is_from_me: true,
      is_bot_message: true,
      thread_id: THREAD_B,
    });

    // Thread A: more messages
    storeMessage({
      id: 'ta-3',
      chat_jid: CHAT_JID,
      sender: 'craig@gorillahub.co.uk',
      sender_name: 'Craig',
      content: 'What about the mailboxes?',
      timestamp: '2024-01-01T00:00:05.000Z',
      is_from_me: false,
      thread_id: THREAD_A,
    });
  });

  it('returns only messages from the specified thread', () => {
    const threadAMsgs = getRecentMessagesByThread(CHAT_JID, THREAD_A, 20);
    expect(threadAMsgs).toHaveLength(3);
    expect(threadAMsgs[0].content).toBe('Lets talk about M365 migration');
    expect(threadAMsgs[1].content).toBe('Sure, here is the migration plan...');
    expect(threadAMsgs[2].content).toBe('What about the mailboxes?');
  });

  it('isolates thread B from thread A messages', () => {
    const threadBMsgs = getRecentMessagesByThread(CHAT_JID, THREAD_B, 20);
    expect(threadBMsgs).toHaveLength(2);
    expect(threadBMsgs[0].content).toBe('Lets discuss task management');
    expect(threadBMsgs[1].content).toBe(
      'Here is the autonomous execution plan...',
    );
  });

  it('falls back to getRecentMessages when threadId is null', () => {
    const allMsgs = getRecentMessagesByThread(CHAT_JID, null, 20);
    // Should return ALL messages across all threads (5 total)
    expect(allMsgs).toHaveLength(5);
  });

  it('falls back to getRecentMessages when threadId is undefined', () => {
    const allMsgs = getRecentMessagesByThread(CHAT_JID, undefined, 20);
    expect(allMsgs).toHaveLength(5);
  });

  it('respects the limit parameter', () => {
    const msgs = getRecentMessagesByThread(CHAT_JID, THREAD_A, 2);
    expect(msgs).toHaveLength(2);
    // Should return the 2 most recent in chronological order
    expect(msgs[0].content).toBe('Sure, here is the migration plan...');
    expect(msgs[1].content).toBe('What about the mailboxes?');
  });

  it('returns empty array for unknown thread', () => {
    const msgs = getRecentMessagesByThread(
      CHAT_JID,
      'spaces/xxx/threads/nonexistent',
      20,
    );
    expect(msgs).toHaveLength(0);
  });

  it('excludes empty content messages', () => {
    storeMessage({
      id: 'ta-empty',
      chat_jid: CHAT_JID,
      sender: 'Craig',
      sender_name: 'Craig',
      content: '',
      timestamp: '2024-01-01T00:00:06.000Z',
      is_from_me: false,
      thread_id: THREAD_A,
    });

    const msgs = getRecentMessagesByThread(CHAT_JID, THREAD_A, 20);
    // Still 3 — empty message excluded
    expect(msgs).toHaveLength(3);
  });

  it('includes bot messages in thread history', () => {
    const msgs = getRecentMessagesByThread(CHAT_JID, THREAD_A, 20);
    const botMsgs = msgs.filter(
      (m) => m.content === 'Sure, here is the migration plan...',
    );
    expect(botMsgs).toHaveLength(1);
  });
});

// --- storeMessage with thread_id ---

describe('storeMessage with thread_id', () => {
  it('stores and retrieves thread_id', () => {
    storeChatMetadata('gchat:pm-agent', '2024-01-01T00:00:00.000Z');

    storeMessage({
      id: 'msg-thread',
      chat_jid: 'gchat:pm-agent',
      sender: 'Craig',
      sender_name: 'Craig',
      content: 'threaded message',
      timestamp: '2024-01-01T00:00:01.000Z',
      is_from_me: false,
      thread_id: 'spaces/xxx/threads/abc',
    });

    const msgs = getRecentMessagesByThread(
      'gchat:pm-agent',
      'spaces/xxx/threads/abc',
      20,
    );
    expect(msgs).toHaveLength(1);
    expect(msgs[0].thread_id).toBe('spaces/xxx/threads/abc');
  });

  it('stores null thread_id when not provided', () => {
    storeChatMetadata('gchat:pm-agent', '2024-01-01T00:00:00.000Z');

    storeMessage({
      id: 'msg-no-thread',
      chat_jid: 'gchat:pm-agent',
      sender: 'Craig',
      sender_name: 'Craig',
      content: 'unthreaded message',
      timestamp: '2024-01-01T00:00:01.000Z',
      is_from_me: false,
    });

    // Should appear in the fallback (all messages) query
    const msgs = getRecentMessages('gchat:pm-agent', 20);
    expect(msgs).toHaveLength(1);

    // Should NOT appear in a thread-specific query
    const threadMsgs = getRecentMessagesByThread(
      'gchat:pm-agent',
      'spaces/xxx/threads/specific',
      20,
    );
    expect(threadMsgs).toHaveLength(0);
  });
});

// --- createTask with thread_id ---

describe('createTask with thread_id', () => {
  it('stores thread_id on a task', () => {
    createTask({
      id: 'gchat-msg-123',
      group_folder: 'google-chat_pm-agent',
      chat_jid: 'gchat:pm-agent',
      prompt: 'test prompt',
      schedule_type: 'once',
      schedule_value: '2024-06-01T00:00:00.000Z',
      context_mode: 'isolated',
      next_run: '2024-06-01T00:00:00.000Z',
      status: 'active',
      created_at: '2024-01-01T00:00:00.000Z',
      thread_id: 'spaces/xxx/threads/task-thread',
    });

    const task = getTaskById('gchat-msg-123');
    expect(task).toBeDefined();
    expect(task!.thread_id).toBe('spaces/xxx/threads/task-thread');
  });

  it('stores null thread_id when not provided', () => {
    createTask({
      id: 'task-no-thread',
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

    const task = getTaskById('task-no-thread');
    expect(task).toBeDefined();
    expect(task!.thread_id).toBeNull();
  });
});
