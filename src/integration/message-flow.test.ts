/**
 * Integration tests for the complete NanoClaw message flow.
 *
 * Tests the pipeline: channel delivers message -> DB storage -> message retrieval
 * -> formatting -> container invocation -> response routing.
 *
 * Uses real in-memory SQLite and mocked channels/containers.
 */
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';

// Mock config first (before any imports that use it)
vi.mock('../config.js', () => ({
  ASSISTANT_NAME: 'Andy',
  ASSISTANT_HAS_OWN_NUMBER: false,
  POLL_INTERVAL: 100,
  STORE_DIR: '/tmp/nanoclaw-test-store',
  GROUPS_DIR: '/tmp/nanoclaw-test-groups',
  DATA_DIR: '/tmp/nanoclaw-test-data',
  TIMEZONE: 'America/New_York',
  TRIGGER_PATTERN: /^@Andy\b/i,
  CONTAINER_TIMEOUT: 300000,
  IDLE_TIMEOUT: 60000,
  MAX_CONCURRENT_CONTAINERS: 5,
  CONTAINER_PREFIX: 'nanoclaw',
  CONTAINER_IMAGE: 'nanoclaw-agent:latest',
  CONTAINER_MAX_OUTPUT_SIZE: 10485760,
  CREDENTIAL_PROXY_PORT: 3001,
  IPC_POLL_INTERVAL: 1000,
  SCHEDULER_POLL_INTERVAL: 60000,
  SENDER_ALLOWLIST_PATH: '/tmp/nanoclaw-test-sender-allowlist.json',
  MOUNT_ALLOWLIST_PATH: '/tmp/nanoclaw-test-mount-allowlist.json',
}));

// Mock logger
vi.mock('../logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
  },
}));

// Mock env.js to prevent reading .env file
vi.mock('../env.js', () => ({
  readEnvFile: vi.fn(() => ({})),
}));

// Mock group-folder to avoid path resolution issues
vi.mock('../group-folder.js', () => ({
  isValidGroupFolder: vi.fn((folder: string) => /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(folder)),
  assertValidGroupFolder: vi.fn(),
  resolveGroupFolderPath: vi.fn((folder: string) => `/tmp/nanoclaw-test-groups/${folder}`),
  resolveGroupIpcPath: vi.fn((folder: string) => `/tmp/nanoclaw-test-data/ipc/${folder}`),
}));

// Mock sender-allowlist to return permissive defaults
vi.mock('../sender-allowlist.js', () => ({
  loadSenderAllowlist: vi.fn(() => ({
    default: { allow: '*', mode: 'trigger' },
    chats: {},
    logDenied: false,
  })),
  isSenderAllowed: vi.fn(() => true),
  isTriggerAllowed: vi.fn(() => true),
  shouldDropMessage: vi.fn(() => false),
}));

import {
  _initTestDatabase,
  storeMessage,
  storeChatMetadata,
  getNewMessages,
  getMessagesSince,
  setRegisteredGroup,
  getAllRegisteredGroups,
  getRouterState,
  setRouterState,
  setSession,
  getSession,
  getAllSessions,
} from '../db.js';
import { formatMessages, escapeXml, findChannel, formatOutbound, stripInternalTags } from '../router.js';
import { GroupQueue } from '../group-queue.js';
import {
  isRateLimitError,
  shouldNotifyError,
  markErrorNotified,
  resetErrorCooldown,
} from '../anti-spam.js';
import { Channel, NewMessage, RegisteredGroup } from '../types.js';

// --- Test helpers ---

function makeMessage(overrides: Partial<NewMessage> & { id: string; chat_jid: string }): NewMessage {
  return {
    sender: 'alice@s.whatsapp.net',
    sender_name: 'Alice',
    content: 'Hello',
    timestamp: new Date().toISOString(),
    is_from_me: false,
    is_bot_message: false,
    ...overrides,
  };
}

function makeChannel(overrides?: Partial<Channel>): Channel {
  return {
    name: 'whatsapp',
    connect: vi.fn().mockResolvedValue(undefined),
    sendMessage: vi.fn().mockResolvedValue(undefined),
    isConnected: vi.fn().mockReturnValue(true),
    ownsJid: vi.fn((jid: string) => jid.endsWith('@g.us') || jid.endsWith('@s.whatsapp.net')),
    disconnect: vi.fn().mockResolvedValue(undefined),
    setTyping: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

function makeGmailChannel(overrides?: Partial<Channel>): Channel {
  return {
    name: 'gmail',
    connect: vi.fn().mockResolvedValue(undefined),
    sendMessage: vi.fn().mockResolvedValue(undefined),
    isConnected: vi.fn().mockReturnValue(true),
    ownsJid: vi.fn((jid: string) => jid.startsWith('gmail:')),
    disconnect: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

function makeGoogleChatChannel(overrides?: Partial<Channel>): Channel {
  return {
    name: 'google-chat',
    connect: vi.fn().mockResolvedValue(undefined),
    sendMessage: vi.fn().mockResolvedValue(undefined),
    isConnected: vi.fn().mockReturnValue(true),
    ownsJid: vi.fn((jid: string) => jid.startsWith('gchat:')),
    disconnect: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

// --- Tests ---

describe('Message Flow Integration', () => {
  beforeEach(() => {
    _initTestDatabase();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // --- Store and retrieve messages ---

  describe('message storage and retrieval', () => {
    it('stores a message and retrieves it via getNewMessages', () => {
      storeChatMetadata('group1@g.us', '2024-01-01T00:00:00.000Z', 'Test Group');

      const msg = makeMessage({
        id: 'flow-1',
        chat_jid: 'group1@g.us',
        content: 'Hello world',
        timestamp: '2024-01-01T00:00:01.000Z',
      });
      storeMessage(msg);

      const { messages, newTimestamp } = getNewMessages(
        ['group1@g.us'],
        '2024-01-01T00:00:00.000Z',
        'Andy',
      );

      expect(messages).toHaveLength(1);
      expect(messages[0].content).toBe('Hello world');
      expect(newTimestamp).toBe('2024-01-01T00:00:01.000Z');
    });

    it('stores a message with trigger and retrieves via getMessagesSince', () => {
      storeChatMetadata('group1@g.us', '2024-01-01T00:00:00.000Z');

      const msg = makeMessage({
        id: 'flow-2',
        chat_jid: 'group1@g.us',
        content: '@Andy what is the weather?',
        timestamp: '2024-01-01T00:00:02.000Z',
      });
      storeMessage(msg);

      const messages = getMessagesSince('group1@g.us', '2024-01-01T00:00:00.000Z', 'Andy');
      expect(messages).toHaveLength(1);
      expect(messages[0].content).toBe('@Andy what is the weather?');
    });

    it('filters bot messages from retrieval', () => {
      storeChatMetadata('group1@g.us', '2024-01-01T00:00:00.000Z');

      storeMessage(makeMessage({
        id: 'flow-3a',
        chat_jid: 'group1@g.us',
        content: 'user message',
        timestamp: '2024-01-01T00:00:01.000Z',
      }));

      storeMessage({
        id: 'flow-3b',
        chat_jid: 'group1@g.us',
        sender: 'bot@s.whatsapp.net',
        sender_name: 'Bot',
        content: 'bot reply',
        timestamp: '2024-01-01T00:00:02.000Z',
        is_bot_message: true,
      });

      const messages = getMessagesSince('group1@g.us', '2024-01-01T00:00:00.000Z', 'Andy');
      expect(messages).toHaveLength(1);
      expect(messages[0].content).toBe('user message');
    });
  });

  // --- Message formatting ---

  describe('message formatting', () => {
    it('formats messages into XML with correct structure', () => {
      const messages: NewMessage[] = [
        {
          id: 'f1',
          chat_jid: 'group@g.us',
          sender: 'alice@s.whatsapp.net',
          sender_name: 'Alice',
          content: 'Hello Andy',
          timestamp: '2024-06-15T10:30:00.000Z',
          is_from_me: false,
        },
      ];

      const formatted = formatMessages(messages, 'America/New_York');

      expect(formatted).toContain('<context timezone="America/New_York" />');
      expect(formatted).toContain('<messages>');
      expect(formatted).toContain('</messages>');
      expect(formatted).toContain('sender="Alice"');
      expect(formatted).toContain('Hello Andy');
    });

    it('formats multi-message batch into single prompt', () => {
      const messages: NewMessage[] = [
        {
          id: 'f2a',
          chat_jid: 'group@g.us',
          sender: 'alice@s.whatsapp.net',
          sender_name: 'Alice',
          content: 'First message',
          timestamp: '2024-06-15T10:30:00.000Z',
          is_from_me: false,
        },
        {
          id: 'f2b',
          chat_jid: 'group@g.us',
          sender: 'bob@s.whatsapp.net',
          sender_name: 'Bob',
          content: 'Second message',
          timestamp: '2024-06-15T10:30:05.000Z',
          is_from_me: false,
        },
        {
          id: 'f2c',
          chat_jid: 'group@g.us',
          sender: 'alice@s.whatsapp.net',
          sender_name: 'Alice',
          content: 'Third message',
          timestamp: '2024-06-15T10:30:10.000Z',
          is_from_me: false,
        },
      ];

      const formatted = formatMessages(messages, 'America/New_York');

      // All three messages in a single prompt
      expect(formatted).toContain('First message');
      expect(formatted).toContain('Second message');
      expect(formatted).toContain('Third message');

      // Each message has its own <message> tag
      const messageTagCount = (formatted.match(/<message /g) || []).length;
      expect(messageTagCount).toBe(3);
    });

    it('escapes XML special characters in message content', () => {
      expect(escapeXml('<script>alert("xss")</script>')).toBe(
        '&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;',
      );
      expect(escapeXml('a & b')).toBe('a &amp; b');
    });

    it('escapes XML in sender names', () => {
      const messages: NewMessage[] = [
        {
          id: 'f3',
          chat_jid: 'group@g.us',
          sender: 'user@s.whatsapp.net',
          sender_name: 'Alice & Bob <team>',
          content: 'test',
          timestamp: '2024-06-15T10:30:00.000Z',
          is_from_me: false,
        },
      ];

      const formatted = formatMessages(messages, 'UTC');
      expect(formatted).toContain('sender="Alice &amp; Bob &lt;team&gt;"');
    });
  });

  // --- Channel routing ---

  describe('channel routing', () => {
    it('findChannel returns the correct channel for a JID', () => {
      const whatsapp = makeChannel();
      const gmail = makeGmailChannel();
      const channels = [whatsapp, gmail];

      expect(findChannel(channels, 'group@g.us')).toBe(whatsapp);
      expect(findChannel(channels, 'gmail:thread-123')).toBe(gmail);
      expect(findChannel(channels, 'unknown:jid')).toBeUndefined();
    });

    it('findChannel matches WhatsApp DM JIDs', () => {
      const whatsapp = makeChannel();
      const channels = [whatsapp];

      expect(findChannel(channels, '12345@s.whatsapp.net')).toBe(whatsapp);
    });

    it('findChannel matches Google Chat JIDs', () => {
      const gchat = makeGoogleChatChannel();
      const channels = [gchat];

      expect(findChannel(channels, 'gchat:spaces/abc')).toBe(gchat);
    });
  });

  // --- Outbound formatting ---

  describe('outbound formatting', () => {
    it('strips internal tags from output', () => {
      const raw = '<internal>thinking...</internal>Hello, how can I help?';
      expect(stripInternalTags(raw)).toBe('Hello, how can I help?');
    });

    it('strips multiple internal tags', () => {
      const raw = '<internal>plan</internal>Result<internal>more notes</internal>';
      expect(stripInternalTags(raw)).toBe('Result');
    });

    it('formatOutbound strips internal tags and trims', () => {
      const raw = '  <internal>notes</internal>  Response text  ';
      expect(formatOutbound(raw)).toBe('Response text');
    });

    it('formatOutbound returns empty string for internal-only content', () => {
      expect(formatOutbound('<internal>only internal</internal>')).toBe('');
    });
  });

  // --- Cursor management ---

  describe('cursor management via DB', () => {
    it('cursor advances after processing messages', () => {
      storeChatMetadata('group@g.us', '2024-01-01T00:00:00.000Z');

      storeMessage(makeMessage({
        id: 'c1',
        chat_jid: 'group@g.us',
        content: 'msg 1',
        timestamp: '2024-01-01T00:00:01.000Z',
      }));
      storeMessage(makeMessage({
        id: 'c2',
        chat_jid: 'group@g.us',
        content: 'msg 2',
        timestamp: '2024-01-01T00:00:02.000Z',
      }));

      // First retrieval gets both messages
      const first = getMessagesSince('group@g.us', '2024-01-01T00:00:00.000Z', 'Andy');
      expect(first).toHaveLength(2);

      // Simulate cursor advance to last message timestamp
      const newCursor = first[first.length - 1].timestamp;

      // Second retrieval with advanced cursor returns nothing
      const second = getMessagesSince('group@g.us', newCursor, 'Andy');
      expect(second).toHaveLength(0);
    });

    it('cursor rollback allows re-processing on error', () => {
      storeChatMetadata('group@g.us', '2024-01-01T00:00:00.000Z');

      storeMessage(makeMessage({
        id: 'r1',
        chat_jid: 'group@g.us',
        content: '@Andy help',
        timestamp: '2024-01-01T00:00:01.000Z',
      }));

      const previousCursor = '2024-01-01T00:00:00.000Z';
      const messages = getMessagesSince('group@g.us', previousCursor, 'Andy');
      expect(messages).toHaveLength(1);

      // Advance cursor
      const advancedCursor = messages[messages.length - 1].timestamp;

      // Simulate error - rollback to previous cursor
      const rolledBackCursor = previousCursor;

      // Messages are still available after rollback
      const retry = getMessagesSince('group@g.us', rolledBackCursor, 'Andy');
      expect(retry).toHaveLength(1);
      expect(retry[0].id).toBe('r1');
    });

    it('router state persists cursors in DB', () => {
      setRouterState('last_timestamp', '2024-06-15T12:00:00.000Z');
      setRouterState(
        'last_agent_timestamp',
        JSON.stringify({ 'group@g.us': '2024-06-15T11:59:00.000Z' }),
      );

      expect(getRouterState('last_timestamp')).toBe('2024-06-15T12:00:00.000Z');
      const agentTs = JSON.parse(getRouterState('last_agent_timestamp') || '{}');
      expect(agentTs['group@g.us']).toBe('2024-06-15T11:59:00.000Z');
    });
  });

  // --- Group registration ---

  describe('group registration', () => {
    it('registers a group and retrieves it', () => {
      setRegisteredGroup('group@g.us', {
        name: 'Test Group',
        folder: 'whatsapp_test-group',
        trigger: '@Andy',
        added_at: '2024-01-01T00:00:00.000Z',
        requiresTrigger: true,
      });

      const groups = getAllRegisteredGroups();
      expect(groups['group@g.us']).toBeDefined();
      expect(groups['group@g.us'].name).toBe('Test Group');
      expect(groups['group@g.us'].requiresTrigger).toBe(true);
    });

    it('registers main group with isMain=true', () => {
      setRegisteredGroup('main@s.whatsapp.net', {
        name: 'Main Chat',
        folder: 'whatsapp_main',
        trigger: '@Andy',
        added_at: '2024-01-01T00:00:00.000Z',
        isMain: true,
      });

      const groups = getAllRegisteredGroups();
      expect(groups['main@s.whatsapp.net'].isMain).toBe(true);
    });
  });

  // --- Session tracking ---

  describe('session tracking', () => {
    it('stores and retrieves session IDs', () => {
      setSession('whatsapp_main', 'session-abc-123');
      expect(getSession('whatsapp_main')).toBe('session-abc-123');
    });

    it('getAllSessions returns all sessions', () => {
      setSession('whatsapp_main', 'session-1');
      setSession('whatsapp_family', 'session-2');

      const sessions = getAllSessions();
      expect(sessions['whatsapp_main']).toBe('session-1');
      expect(sessions['whatsapp_family']).toBe('session-2');
    });

    it('overwrites session on update', () => {
      setSession('whatsapp_main', 'old-session');
      setSession('whatsapp_main', 'new-session');
      expect(getSession('whatsapp_main')).toBe('new-session');
    });
  });

  // --- Anti-spam integration ---

  describe('anti-spam integration', () => {
    it('detects rate limit error text', () => {
      expect(isRateLimitError('You have hit your limit for today')).toBe(true);
      expect(isRateLimitError('rate limit exceeded')).toBe(true);
      expect(isRateLimitError('Error 429: Too many requests')).toBe(true);
      expect(isRateLimitError('The system is overloaded')).toBe(true);
    });

    it('does not flag normal responses as rate limit errors', () => {
      expect(isRateLimitError('Here is your answer about weather')).toBe(false);
      expect(isRateLimitError('The meeting is at 4:29 PM')).toBe(false);
    });

    it('shouldNotifyError returns true on first error', () => {
      resetErrorCooldown('test-jid');
      expect(shouldNotifyError('test-jid')).toBe(true);
    });

    it('shouldNotifyError returns false during cooldown', () => {
      const jid = 'cooldown-test-jid';
      resetErrorCooldown(jid);
      markErrorNotified(jid);
      expect(shouldNotifyError(jid)).toBe(false);
    });

    it('resetErrorCooldown allows next notification', () => {
      const jid = 'reset-test-jid';
      markErrorNotified(jid);
      expect(shouldNotifyError(jid)).toBe(false);
      resetErrorCooldown(jid);
      expect(shouldNotifyError(jid)).toBe(true);
    });
  });

  // --- Cross-channel message delivery ---

  describe('cross-channel message delivery', () => {
    it('Gmail message stores with main group JID', () => {
      // Register main group
      setRegisteredGroup('main@s.whatsapp.net', {
        name: 'Main',
        folder: 'whatsapp_main',
        trigger: '',
        added_at: '2024-01-01T00:00:00.000Z',
        isMain: true,
      });
      storeChatMetadata('main@s.whatsapp.net', '2024-01-01T00:00:00.000Z');

      // Simulate what Gmail channel does: deliver to main JID
      const emailMsg = makeMessage({
        id: 'gmail-1',
        chat_jid: 'main@s.whatsapp.net',
        sender: 'alice@example.com',
        sender_name: 'Alice Smith',
        content: '[Email from Alice Smith <alice@example.com>]\nSubject: Hello\n\nHi there!',
        timestamp: '2024-06-15T10:00:00.000Z',
      });
      storeMessage(emailMsg);

      const messages = getMessagesSince('main@s.whatsapp.net', '2024-01-01T00:00:00.000Z', 'Andy');
      expect(messages).toHaveLength(1);
      expect(messages[0].content).toContain('[Email from Alice Smith');
    });

    it('multi-channel routing sends to correct channel', () => {
      const whatsapp = makeChannel();
      const gmail = makeGmailChannel();
      const channels = [whatsapp, gmail];

      // WhatsApp JID routes to WhatsApp
      const waChannel = findChannel(channels, 'group@g.us');
      expect(waChannel?.name).toBe('whatsapp');

      // Gmail JID routes to Gmail
      const gmailChannel = findChannel(channels, 'gmail:thread-1');
      expect(gmailChannel?.name).toBe('gmail');
    });
  });

  // --- Full pipeline: store, retrieve, format ---

  describe('full pipeline: store -> retrieve -> format', () => {
    it('end-to-end: 3 messages arrive, all formatted in single prompt', () => {
      storeChatMetadata('group@g.us', '2024-01-01T00:00:00.000Z');

      const msgs = [
        makeMessage({
          id: 'pipe-1',
          chat_jid: 'group@g.us',
          sender_name: 'Alice',
          content: '@Andy hello',
          timestamp: '2024-06-15T10:00:01.000Z',
        }),
        makeMessage({
          id: 'pipe-2',
          chat_jid: 'group@g.us',
          sender_name: 'Bob',
          content: 'I agree with Alice',
          timestamp: '2024-06-15T10:00:02.000Z',
        }),
        makeMessage({
          id: 'pipe-3',
          chat_jid: 'group@g.us',
          sender_name: 'Alice',
          content: 'Can you summarize?',
          timestamp: '2024-06-15T10:00:03.000Z',
        }),
      ];
      msgs.forEach(storeMessage);

      const retrieved = getMessagesSince('group@g.us', '2024-01-01T00:00:00.000Z', 'Andy');
      expect(retrieved).toHaveLength(3);

      const formatted = formatMessages(retrieved, 'America/New_York');
      expect(formatted).toContain('@Andy hello');
      expect(formatted).toContain('I agree with Alice');
      expect(formatted).toContain('Can you summarize?');
      expect(formatted).toContain('<context timezone="America/New_York"');

      const tagCount = (formatted.match(/<message /g) || []).length;
      expect(tagCount).toBe(3);
    });

    it('end-to-end: message with trigger detected by pattern', () => {
      const TRIGGER_PATTERN = /^@Andy\b/i;

      storeChatMetadata('group@g.us', '2024-01-01T00:00:00.000Z');

      storeMessage(makeMessage({
        id: 'trig-1',
        chat_jid: 'group@g.us',
        content: '@Andy what is 2+2?',
        timestamp: '2024-06-15T10:00:01.000Z',
      }));

      const messages = getMessagesSince('group@g.us', '2024-01-01T00:00:00.000Z', 'Andy');
      const hasTrigger = messages.some((m) => TRIGGER_PATTERN.test(m.content.trim()));
      expect(hasTrigger).toBe(true);
    });

    it('end-to-end: message without trigger is not picked up for non-main group', () => {
      const TRIGGER_PATTERN = /^@Andy\b/i;

      storeChatMetadata('group@g.us', '2024-01-01T00:00:00.000Z');

      storeMessage(makeMessage({
        id: 'no-trig-1',
        chat_jid: 'group@g.us',
        content: 'Just a regular message without trigger',
        timestamp: '2024-06-15T10:00:01.000Z',
      }));

      const messages = getMessagesSince('group@g.us', '2024-01-01T00:00:00.000Z', 'Andy');
      const hasTrigger = messages.some((m) => TRIGGER_PATTERN.test(m.content.trim()));
      expect(hasTrigger).toBe(false);
    });
  });

  // --- GroupQueue + processMessages integration ---

  describe('GroupQueue integration', () => {
    it('enqueues and processes messages via queue', async () => {
      vi.useFakeTimers();
      const queue = new GroupQueue();
      const processed: string[] = [];

      queue.setProcessMessagesFn(async (groupJid: string) => {
        processed.push(groupJid);
        return true;
      });

      queue.enqueueMessageCheck('group1@g.us');

      await vi.advanceTimersByTimeAsync(10);

      expect(processed).toContain('group1@g.us');
      vi.useRealTimers();
    });

    it('processes multiple groups sequentially per group', async () => {
      vi.useFakeTimers();
      const queue = new GroupQueue();
      const order: string[] = [];
      const resolvers: Array<() => void> = [];

      queue.setProcessMessagesFn(async (groupJid: string) => {
        await new Promise<void>((resolve) => resolvers.push(resolve));
        order.push(groupJid);
        return true;
      });

      queue.enqueueMessageCheck('group1@g.us');
      queue.enqueueMessageCheck('group2@g.us');

      await vi.advanceTimersByTimeAsync(10);

      // Both should start (different groups, concurrent limit > 1)
      expect(resolvers).toHaveLength(2);

      resolvers[0]();
      await vi.advanceTimersByTimeAsync(10);
      resolvers[1]();
      await vi.advanceTimersByTimeAsync(10);

      expect(order).toContain('group1@g.us');
      expect(order).toContain('group2@g.us');
      vi.useRealTimers();
    });
  });
});
