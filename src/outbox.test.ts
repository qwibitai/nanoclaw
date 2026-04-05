import { describe, it, expect, beforeEach } from 'vitest';

import {
  _initTestDatabase,
  enqueueOutbox,
  getOutboxMessages,
  deleteOutboxMessage,
  incrementOutboxAttempts,
} from './db.js';

beforeEach(() => {
  _initTestDatabase();
});

describe('outbox', () => {
  it('enqueues and retrieves messages', () => {
    enqueueOutbox('chat1@g.us', 'Hello world');
    enqueueOutbox('chat2@g.us', 'Second message');

    const messages = getOutboxMessages();
    expect(messages).toHaveLength(2);
    expect(messages[0].chatJid).toBe('chat1@g.us');
    expect(messages[0].text).toBe('Hello world');
    expect(messages[0].attempts).toBe(0);
    expect(messages[1].chatJid).toBe('chat2@g.us');
  });

  it('returns empty array when no messages', () => {
    expect(getOutboxMessages()).toHaveLength(0);
  });

  it('deletes a message by id', () => {
    enqueueOutbox('chat1@g.us', 'To be deleted');
    enqueueOutbox('chat1@g.us', 'To keep');

    const before = getOutboxMessages();
    expect(before).toHaveLength(2);

    deleteOutboxMessage(before[0].id);

    const after = getOutboxMessages();
    expect(after).toHaveLength(1);
    expect(after[0].text).toBe('To keep');
  });

  it('increments attempt counter', () => {
    enqueueOutbox('chat1@g.us', 'Retry me');
    const [msg] = getOutboxMessages();
    expect(msg.attempts).toBe(0);

    incrementOutboxAttempts(msg.id);
    incrementOutboxAttempts(msg.id);

    const [updated] = getOutboxMessages();
    expect(updated.attempts).toBe(2);
  });

  it('preserves order by id (FIFO)', () => {
    enqueueOutbox('chat1@g.us', 'First');
    enqueueOutbox('chat1@g.us', 'Second');
    enqueueOutbox('chat1@g.us', 'Third');

    const messages = getOutboxMessages();
    expect(messages.map((m) => m.text)).toEqual(['First', 'Second', 'Third']);
  });
});
