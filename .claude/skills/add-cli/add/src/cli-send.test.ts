import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('./config.js', () => ({
  ASSISTANT_NAME: 'Andy',
  MAIN_GROUP_FOLDER: 'main',
  STORE_DIR: '/tmp/test-store',
  DATA_DIR: '/tmp/test-data',
  GROUPS_DIR: '/tmp/test-groups',
}));

vi.mock('./logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

import {
  _initTestDatabase,
  getMessagesSince,
  setRegisteredGroup,
} from './db.js';
import { sendMessage } from './cli-send.js';

beforeEach(() => {
  _initTestDatabase();
  setRegisteredGroup('main-jid@g.us', {
    name: 'Main Group',
    folder: 'main',
    trigger: '@Andy',
    added_at: '2024-01-01T00:00:00.000Z',
  });
});

// --- Group resolution ---

describe('group resolution', () => {
  it('targets main group by default', () => {
    const result = sendMessage({ message: 'hello' });
    expect(result.jid).toBe('main-jid@g.us');
    expect(result.group).toBe('main');
  });

  it('targets specific group by folder name', () => {
    setRegisteredGroup('slack:C999', {
      name: 'Work',
      folder: 'work',
      trigger: '@Andy',
      added_at: '2024-01-01T00:00:00.000Z',
    });

    const result = sendMessage({ message: 'hello', group: 'work' });
    expect(result.jid).toBe('slack:C999');
    expect(result.group).toBe('work');
  });

  it('throws when group folder not found', () => {
    expect(() => sendMessage({ message: 'hello', group: 'nonexistent' })).toThrow(
      /No registered group with folder "nonexistent"/,
    );
  });

  it('lists available groups in error message', () => {
    setRegisteredGroup('slack:C999', {
      name: 'Work',
      folder: 'work',
      trigger: '@Andy',
      added_at: '2024-01-01T00:00:00.000Z',
    });

    expect(() => sendMessage({ message: 'hello', group: 'nope' })).toThrow(
      /Available:.*main.*work/,
    );
  });
});

// --- Message insertion ---

describe('message insertion', () => {
  it('inserts message retrievable from DB', () => {
    const result = sendMessage({ message: 'test content' });
    const msgs = getMessagesSince('main-jid@g.us', '', 'Andy');
    expect(msgs).toHaveLength(1);
    expect(msgs[0].content).toBe('test content');
    expect(msgs[0].id).toBe(result.messageId);
  });

  it('generates ID with cli prefix', () => {
    const result = sendMessage({ message: 'test' });
    expect(result.messageId).toMatch(/^cli-cli-\d+-[0-9a-f]{8}$/);
  });

  it('generates ID with custom sender prefix', () => {
    const result = sendMessage({ message: 'test', sender: 'sddk' });
    expect(result.messageId).toMatch(/^cli-sddk-\d+-[0-9a-f]{8}$/);
  });

  it('sets sender field with cli: prefix', () => {
    sendMessage({ message: 'test' });
    const msgs = getMessagesSince('main-jid@g.us', '', 'Andy');
    expect(msgs[0].sender).toBe('cli:cli');
  });

  it('is not filtered as bot message', () => {
    sendMessage({ message: 'test' });
    // getMessagesSince filters out bot messages — if it shows up, it's not a bot message
    const msgs = getMessagesSince('main-jid@g.us', '', 'Andy');
    expect(msgs).toHaveLength(1);
  });

  it('preserves multi-line content', () => {
    const multiline = 'line 1\nline 2\nline 3';
    sendMessage({ message: multiline });
    const msgs = getMessagesSince('main-jid@g.us', '', 'Andy');
    expect(msgs[0].content).toBe(multiline);
  });
});

// --- Input validation ---

describe('input validation', () => {
  it('throws on empty message', () => {
    expect(() => sendMessage({ message: '' })).toThrow('Empty message');
  });

  it('throws on whitespace-only message', () => {
    expect(() => sendMessage({ message: '   ' })).toThrow('Empty message');
  });
});

// --- Sender handling ---

describe('sender handling', () => {
  it('defaults sender name to cli', () => {
    const result = sendMessage({ message: 'test' });
    expect(result.sender).toBe('cli');
  });

  it('uses custom sender name', () => {
    const result = sendMessage({ message: 'test', sender: 'monitor' });
    expect(result.sender).toBe('monitor');
    const msgs = getMessagesSince('main-jid@g.us', '', 'Andy');
    expect(msgs[0].sender).toBe('cli:monitor');
    expect(msgs[0].sender_name).toBe('monitor');
  });
});

// --- Return value ---

describe('return value', () => {
  it('returns all expected fields', () => {
    const result = sendMessage({ message: 'test' });
    expect(result).toHaveProperty('jid', 'main-jid@g.us');
    expect(result).toHaveProperty('messageId');
    expect(result).toHaveProperty('sender', 'cli');
    expect(result).toHaveProperty('group', 'main');
  });
});
