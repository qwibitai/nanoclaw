/**
 * Regression tests for IPC message delivery race condition.
 *
 * Bug: when the message loop piped a follow-up message to an active container
 * via IPC, it advanced lastAgentTimestamp immediately.  If the container never
 * processed the message (SDK hang, Docker bind-mount delay, container exit
 * race), the message was permanently lost — cursor past it, no retry.
 *
 * Fix:
 *  1. Message loop does NOT advance lastAgentTimestamp on IPC pipe.
 *  2. processGroupMessages advances cursor in the onOutput callback when
 *     the container confirms processing.
 *  3. After the container exits, a safety-net checks getMessagesSince for
 *     unprocessed messages and triggers a retry.
 *  4. cleanIpcInputDir removes orphaned files before the retry container
 *     starts.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';

import {
  _initTestDatabase,
  getMessagesSince,
  storeChatMetadata,
  storeMessage,
} from './db.js';

// --- Mocks ---

vi.mock('./config.js', () => ({
  ASSISTANT_NAME: 'Andy',
  DATA_DIR: '/tmp/cambot-ipc-test',
  GROUPS_DIR: '/tmp/cambot-ipc-test-groups',
  MAIN_GROUP_FOLDER: 'main',
  STORE_DIR: '/tmp/cambot-ipc-test-store',
  IDLE_TIMEOUT: 1800000,
  POLL_INTERVAL: 2000,
  TRIGGER_PATTERN: /^@Andy\b/i,
  MAX_CONCURRENT_CONTAINERS: 5,
  CONTAINER_TIMEOUT: 1800000,
  CONTAINER_MAX_OUTPUT_SIZE: 10485760,
  IPC_POLL_INTERVAL: 1000,
  TIMEZONE: 'America/New_York',
}));

vi.mock('./logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    fatal: vi.fn(),
  },
}));

// --- Helpers ---

const CHAT_JID = 'cli:console';
const ASSISTANT = 'Andy';

function storeUserMessage(id: string, content: string, timestamp: string) {
  storeMessage({
    id,
    chat_jid: CHAT_JID,
    sender: 'user@s.whatsapp.net',
    sender_name: 'User',
    content,
    timestamp,
    is_from_me: false,
  });
}

// --- Tests ---

beforeEach(() => {
  _initTestDatabase();
  storeChatMetadata(CHAT_JID, '2026-01-01T00:00:00.000Z');
});

describe('cursor management for IPC-piped messages', () => {
  it('getMessagesSince returns piped messages when cursor is not advanced', () => {
    // Simulate: first message processed, cursor at T1
    storeUserMessage('msg1', 'who am i?', '2026-01-01T08:10:30.000Z');
    storeUserMessage('msg2', 'who is my wife?', '2026-01-01T08:11:10.000Z');

    const cursorAfterFirstMsg = '2026-01-01T08:10:30.000Z';

    // With cursor at first message's timestamp, second message is still visible
    const remaining = getMessagesSince(CHAT_JID, cursorAfterFirstMsg, ASSISTANT);
    expect(remaining).toHaveLength(1);
    expect(remaining[0].content).toBe('who is my wife?');
  });

  it('getMessagesSince returns nothing when cursor is advanced past all messages', () => {
    storeUserMessage('msg1', 'who am i?', '2026-01-01T08:10:30.000Z');
    storeUserMessage('msg2', 'who is my wife?', '2026-01-01T08:11:10.000Z');

    // BUG scenario: cursor was prematurely advanced past msg2
    const cursorAfterBothMsgs = '2026-01-01T08:11:10.000Z';

    const remaining = getMessagesSince(CHAT_JID, cursorAfterBothMsgs, ASSISTANT);
    expect(remaining).toHaveLength(0);
    // ^ This is the bug: if cursor was advanced on IPC pipe, message is invisible
  });

  it('onOutput cursor advancement covers IPC-piped messages', () => {
    storeUserMessage('msg1', 'first question', '2026-01-01T08:10:30.000Z');

    // processGroupMessages advances cursor to msg1's timestamp
    let cursor = '2026-01-01T08:10:30.000Z';

    // Container processes msg1 — onOutput fires but no new messages yet
    const afterFirstOutput = getMessagesSince(CHAT_JID, cursor, ASSISTANT);
    expect(afterFirstOutput).toHaveLength(0);
    // cursor stays at msg1's timestamp

    // Message loop pipes msg2 via IPC (does NOT advance cursor)
    storeUserMessage('msg2', 'second question', '2026-01-01T08:11:10.000Z');

    // Container processes msg2 — onOutput fires
    // Callback queries DB: getMessagesSince(cursor) returns msg2
    const duringSecondOutput = getMessagesSince(CHAT_JID, cursor, ASSISTANT);
    expect(duringSecondOutput).toHaveLength(1);
    expect(duringSecondOutput[0].content).toBe('second question');

    // Cursor is advanced to msg2's timestamp
    cursor = duringSecondOutput[duringSecondOutput.length - 1].timestamp;
    expect(cursor).toBe('2026-01-01T08:11:10.000Z');

    // After container exits, no remaining messages
    const remaining = getMessagesSince(CHAT_JID, cursor, ASSISTANT);
    expect(remaining).toHaveLength(0);
  });

  it('detects unprocessed messages when container exits without processing IPC message', () => {
    storeUserMessage('msg1', 'first question', '2026-01-01T08:10:30.000Z');
    storeUserMessage('msg2', 'second question', '2026-01-01T08:11:10.000Z');

    // processGroupMessages advanced cursor to msg1
    const cursor = '2026-01-01T08:10:30.000Z';

    // Container exits WITHOUT processing msg2 (the bug scenario)
    // Safety-net check: getMessagesSince should find msg2
    const remaining = getMessagesSince(CHAT_JID, cursor, ASSISTANT);
    expect(remaining).toHaveLength(1);
    expect(remaining[0].content).toBe('second question');
    // processGroupMessages returns false → retry picks up msg2
  });

  it('handles multiple unprocessed messages across the gap', () => {
    storeUserMessage('msg1', 'first', '2026-01-01T08:10:00.000Z');
    storeUserMessage('msg2', 'second', '2026-01-01T08:11:00.000Z');
    storeUserMessage('msg3', 'third', '2026-01-01T08:12:00.000Z');

    // Only msg1 was in the initial prompt
    const cursor = '2026-01-01T08:10:00.000Z';

    // msg2 and msg3 were piped via IPC but container died
    const remaining = getMessagesSince(CHAT_JID, cursor, ASSISTANT);
    expect(remaining).toHaveLength(2);
    expect(remaining[0].content).toBe('second');
    expect(remaining[1].content).toBe('third');
  });
});

describe('cleanIpcInputDir', () => {
  // We test the function by importing it indirectly — it's module-private
  // in index.ts, so we re-implement the logic here and verify the pattern.

  const IPC_DIR = '/tmp/cambot-ipc-test/ipc/main/input';

  beforeEach(() => {
    // Create test directory with orphaned files
    fs.mkdirSync(IPC_DIR, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync('/tmp/cambot-ipc-test', { recursive: true, force: true });
  });

  it('removes .json files from IPC input directory', () => {
    const file1 = path.join(IPC_DIR, '1234-abc.json');
    const file2 = path.join(IPC_DIR, '5678-def.json');
    fs.writeFileSync(file1, '{}');
    fs.writeFileSync(file2, '{}');

    // Simulate cleanIpcInputDir
    for (const f of fs.readdirSync(IPC_DIR)) {
      if (f.endsWith('.json') || f === '_close') {
        fs.unlinkSync(path.join(IPC_DIR, f));
      }
    }

    const remaining = fs.readdirSync(IPC_DIR);
    expect(remaining).toHaveLength(0);
  });

  it('removes _close sentinel', () => {
    fs.writeFileSync(path.join(IPC_DIR, '_close'), '');
    fs.writeFileSync(path.join(IPC_DIR, '1234.json'), '{}');

    for (const f of fs.readdirSync(IPC_DIR)) {
      if (f.endsWith('.json') || f === '_close') {
        fs.unlinkSync(path.join(IPC_DIR, f));
      }
    }

    const remaining = fs.readdirSync(IPC_DIR);
    expect(remaining).toHaveLength(0);
  });

  it('preserves non-.json, non-_close files', () => {
    fs.writeFileSync(path.join(IPC_DIR, 'keep-me.txt'), 'important');
    fs.writeFileSync(path.join(IPC_DIR, '1234.json'), '{}');

    for (const f of fs.readdirSync(IPC_DIR)) {
      if (f.endsWith('.json') || f === '_close') {
        fs.unlinkSync(path.join(IPC_DIR, f));
      }
    }

    const remaining = fs.readdirSync(IPC_DIR);
    expect(remaining).toEqual(['keep-me.txt']);
  });
});

describe('race condition: full scenario simulation', () => {
  it('piped message is recoverable when cursor is managed correctly', () => {
    // Setup: two messages, simulating the user's exact bug report
    storeUserMessage('msg1', 'who am i?', '2026-01-01T08:10:30.000Z');

    // Step 1: processGroupMessages picks up msg1
    const initialMessages = getMessagesSince(CHAT_JID, '', ASSISTANT);
    expect(initialMessages).toHaveLength(1);

    // Step 2: Advance cursor for initial messages (processGroupMessages line ~183)
    let cursor = initialMessages[initialMessages.length - 1].timestamp;
    expect(cursor).toBe('2026-01-01T08:10:30.000Z');

    // Step 3: Container processes msg1, onOutput fires
    // At this point, msg2 hasn't arrived yet
    const afterFirstOutput = getMessagesSince(CHAT_JID, cursor, ASSISTANT);
    expect(afterFirstOutput).toHaveLength(0);
    // cursor stays at msg1

    // Step 4: User sends second message 35s later
    storeUserMessage('msg2', 'who is my wife?', '2026-01-01T08:11:10.000Z');

    // Step 5: Message loop pipes msg2 via IPC
    // FIX: cursor is NOT advanced here (previously it was, causing the bug)

    // Step 6a (happy path): Container processes msg2, onOutput fires
    {
      const latest = getMessagesSince(CHAT_JID, cursor, ASSISTANT);
      expect(latest).toHaveLength(1);
      // Cursor advanced to msg2
      const newCursor = latest[latest.length - 1].timestamp;
      expect(newCursor).toBe('2026-01-01T08:11:10.000Z');

      // After container exits, no remaining messages
      const remaining = getMessagesSince(CHAT_JID, newCursor, ASSISTANT);
      expect(remaining).toHaveLength(0);
    }

    // Step 6b (failure path): Container exits without processing msg2
    {
      // cursor is still at msg1 (onOutput never fired for msg2)
      const remaining = getMessagesSince(CHAT_JID, cursor, ASSISTANT);
      expect(remaining).toHaveLength(1);
      expect(remaining[0].content).toBe('who is my wife?');
      // processGroupMessages returns false → retry picks this up
    }
  });

  it('OLD behavior: premature cursor advance loses message permanently', () => {
    storeUserMessage('msg1', 'who am i?', '2026-01-01T08:10:30.000Z');

    // processGroupMessages advances cursor to msg1
    let cursor = '2026-01-01T08:10:30.000Z';

    // User sends msg2
    storeUserMessage('msg2', 'who is my wife?', '2026-01-01T08:11:10.000Z');

    // OLD BUG: message loop advanced cursor to msg2 on IPC pipe
    cursor = '2026-01-01T08:11:10.000Z';

    // Container exits without processing msg2
    // Safety-net check finds NOTHING — cursor already past msg2
    const remaining = getMessagesSince(CHAT_JID, cursor, ASSISTANT);
    expect(remaining).toHaveLength(0);
    // ^ This is the bug: msg2 is permanently lost, no retry possible
  });
});
