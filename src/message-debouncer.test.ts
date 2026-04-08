import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import { MessageDebouncer } from './message-debouncer.js';
import type { NewMessage } from './types.js';

describe('MessageDebouncer', () => {
  let flushCalls: Array<{ chatJid: string; msg: NewMessage }> = [];
  let debouncer: MessageDebouncer;

  beforeEach(() => {
    flushCalls = [];
    const callback = (chatJid: string, msg: NewMessage) => {
      flushCalls.push({ chatJid, msg });
    };
    debouncer = new MessageDebouncer(callback, 3000);
    vi.useFakeTimers();
  });

  afterEach(() => {
    debouncer.flushAll();
    vi.useRealTimers();
  });

  function makeMsg(
    overrides: Partial<NewMessage> & {
      id: string;
      chat_jid: string;
      sender: string;
      content: string;
      timestamp: string;
    },
  ): NewMessage {
    return {
      sender_name: 'TestUser',
      is_from_me: false,
      is_bot_message: false,
      reply_to_message_id: undefined,
      reply_to_message_content: undefined,
      reply_to_sender_name: undefined,
      ...overrides,
    };
  }

  it('flushes a single message after the debounce window', () => {
    debouncer.push(
      'chat1',
      makeMsg({
        id: 'm1',
        chat_jid: 'chat1',
        sender: 'user1',
        content: 'Hello',
        timestamp: '2024-01-01T00:00:01.000Z',
      }),
    );

    expect(flushCalls).toHaveLength(0);

    vi.advanceTimersByTime(3000);

    expect(flushCalls).toHaveLength(1);
    expect(flushCalls[0].chatJid).toBe('chat1');
    expect(flushCalls[0].msg.content).toBe('Hello');
    expect(flushCalls[0].msg.id).toBe('m1');
  });

  it('merges fragments from the same sender in the same chat', () => {
    debouncer.push(
      'chat1',
      makeMsg({
        id: 'm1',
        chat_jid: 'chat1',
        sender: 'user1',
        content: 'Part one',
        timestamp: '2024-01-01T00:00:01.000Z',
      }),
    );

    vi.advanceTimersByTime(500);

    debouncer.push(
      'chat1',
      makeMsg({
        id: 'm2',
        chat_jid: 'chat1',
        sender: 'user1',
        content: 'Part two',
        timestamp: '2024-01-01T00:00:01.500Z',
      }),
    );

    // Not flushed yet — timer was reset
    expect(flushCalls).toHaveLength(0);

    vi.advanceTimersByTime(3000);

    expect(flushCalls).toHaveLength(1);
    expect(flushCalls[0].msg.content).toBe('Part one\nPart two');
    expect(flushCalls[0].msg.timestamp).toBe('2024-01-01T00:00:01.500Z');
    expect(flushCalls[0].msg.id).toBe('m1');
  });

  it('does not merge messages from different senders', () => {
    debouncer.push(
      'chat1',
      makeMsg({
        id: 'm1',
        chat_jid: 'chat1',
        sender: 'user1',
        content: 'From user1',
        timestamp: '2024-01-01T00:00:01.000Z',
      }),
    );

    debouncer.push(
      'chat1',
      makeMsg({
        id: 'm2',
        chat_jid: 'chat1',
        sender: 'user2',
        content: 'From user2',
        timestamp: '2024-01-01T00:00:01.500Z',
      }),
    );

    vi.advanceTimersByTime(3000);

    expect(flushCalls).toHaveLength(2);
    expect(flushCalls[0].msg.content).toBe('From user1');
    expect(flushCalls[1].msg.content).toBe('From user2');
  });

  it('does not merge messages from different chats', () => {
    debouncer.push(
      'chat1',
      makeMsg({
        id: 'm1',
        chat_jid: 'chat1',
        sender: 'user1',
        content: 'In chat1',
        timestamp: '2024-01-01T00:00:01.000Z',
      }),
    );

    debouncer.push(
      'chat2',
      makeMsg({
        id: 'm2',
        chat_jid: 'chat2',
        sender: 'user1',
        content: 'In chat2',
        timestamp: '2024-01-01T00:00:01.500Z',
      }),
    );

    vi.advanceTimersByTime(3000);

    expect(flushCalls).toHaveLength(2);
    expect(flushCalls[0].chatJid).toBe('chat1');
    expect(flushCalls[1].chatJid).toBe('chat2');
  });

  it('flushes bot messages immediately without debounce', () => {
    debouncer.push(
      'chat1',
      makeMsg({
        id: 'bot1',
        chat_jid: 'chat1',
        sender: 'bot',
        content: 'Bot reply',
        timestamp: '2024-01-01T00:00:01.000Z',
        is_bot_message: true,
      }),
    );

    expect(flushCalls).toHaveLength(1);
    expect(flushCalls[0].msg.content).toBe('Bot reply');
  });

  it('flushes messages from self immediately without debounce', () => {
    debouncer.push(
      'chat1',
      makeMsg({
        id: 'me1',
        chat_jid: 'chat1',
        sender: 'me',
        content: 'My message',
        timestamp: '2024-01-01T00:00:01.000Z',
        is_from_me: true,
      }),
    );

    expect(flushCalls).toHaveLength(1);
    expect(flushCalls[0].msg.content).toBe('My message');
  });

  it('merges three fragments arriving in quick succession', () => {
    debouncer.push(
      'chat1',
      makeMsg({
        id: 'f1',
        chat_jid: 'chat1',
        sender: 'user1',
        content: 'First',
        timestamp: '2024-01-01T00:00:00.000Z',
      }),
    );

    vi.advanceTimersByTime(500);

    debouncer.push(
      'chat1',
      makeMsg({
        id: 'f2',
        chat_jid: 'chat1',
        sender: 'user1',
        content: 'Second',
        timestamp: '2024-01-01T00:00:00.500Z',
      }),
    );

    vi.advanceTimersByTime(500);

    debouncer.push(
      'chat1',
      makeMsg({
        id: 'f3',
        chat_jid: 'chat1',
        sender: 'user1',
        content: 'Third',
        timestamp: '2024-01-01T00:00:01.000Z',
      }),
    );

    vi.advanceTimersByTime(3000);

    expect(flushCalls).toHaveLength(1);
    expect(flushCalls[0].msg.content).toBe('First\nSecond\nThird');
  });

  it('separates messages that arrive outside the debounce window', () => {
    debouncer.push(
      'chat1',
      makeMsg({
        id: 'm1',
        chat_jid: 'chat1',
        sender: 'user1',
        content: 'First message',
        timestamp: '2024-01-01T00:00:01.000Z',
      }),
    );

    vi.advanceTimersByTime(3000);

    // First message flushed
    expect(flushCalls).toHaveLength(1);

    // Second message arrives later — separate conversation turn
    debouncer.push(
      'chat1',
      makeMsg({
        id: 'm2',
        chat_jid: 'chat1',
        sender: 'user1',
        content: 'Second message',
        timestamp: '2024-01-01T00:00:10.000Z',
      }),
    );

    vi.advanceTimersByTime(3000);

    expect(flushCalls).toHaveLength(2);
    expect(flushCalls[0].msg.content).toBe('First message');
    expect(flushCalls[1].msg.content).toBe('Second message');
  });

  it('flushAll sends all pending messages immediately', () => {
    debouncer.push(
      'chat1',
      makeMsg({
        id: 'm1',
        chat_jid: 'chat1',
        sender: 'user1',
        content: 'Pending',
        timestamp: '2024-01-01T00:00:01.000Z',
      }),
    );

    expect(flushCalls).toHaveLength(0);
    debouncer.flushAll();
    expect(flushCalls).toHaveLength(1);
    expect(flushCalls[0].msg.content).toBe('Pending');
  });

  it('tracks pending count', () => {
    expect(debouncer.pendingCount).toBe(0);

    debouncer.push(
      'chat1',
      makeMsg({
        id: 'm1',
        chat_jid: 'chat1',
        sender: 'user1',
        content: 'A',
        timestamp: '2024-01-01T00:00:01.000Z',
      }),
    );
    expect(debouncer.pendingCount).toBe(1);

    debouncer.push(
      'chat1',
      makeMsg({
        id: 'm2',
        chat_jid: 'chat1',
        sender: 'user1',
        content: 'B',
        timestamp: '2024-01-01T00:00:01.500Z',
      }),
    );
    // Same merge key, still 1
    expect(debouncer.pendingCount).toBe(1);

    debouncer.push(
      'chat2',
      makeMsg({
        id: 'm3',
        chat_jid: 'chat2',
        sender: 'user1',
        content: 'C',
        timestamp: '2024-01-01T00:00:02.000Z',
      }),
    );
    expect(debouncer.pendingCount).toBe(2);

    vi.advanceTimersByTime(3000);
    expect(debouncer.pendingCount).toBe(0);
  });
});
