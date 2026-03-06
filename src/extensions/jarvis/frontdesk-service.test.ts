import { beforeEach, describe, expect, it } from 'vitest';

import {
  _initTestDatabase,
  getAndyRequestByMessageId,
  listActiveAndyRequests,
} from '../../db.js';
import { handleAndyFrontdeskMessages } from './frontdesk-service.js';
import {
  type Channel,
  type NewMessage,
  type RegisteredGroup,
} from '../../types.js';

const ANDY_GROUP: RegisteredGroup = {
  name: 'Andy Developer',
  folder: 'andy-developer',
  trigger: '@Andy',
  added_at: '2024-01-01T00:00:00.000Z',
};

const STATUS_QUERY_MESSAGE: NewMessage = {
  id: 'msg-status-right-now',
  chat_jid: 'andy-developer@g.us',
  sender: 'user@s.whatsapp.net',
  sender_name: 'User',
  content: '@Andy what are you working on right now?',
  timestamp: '2026-03-06T10:00:00.000Z',
};

describe('frontdesk-service', () => {
  beforeEach(() => {
    _initTestDatabase();
  });

  it('treats "what are you working on right now" as status, not intake', async () => {
    const sent: string[] = [];
    const channel: Channel = {
      name: 'test',
      connect: async () => {},
      sendMessage: async (_jid, text) => {
        sent.push(text);
      },
      isConnected: () => true,
      ownsJid: () => true,
      disconnect: async () => {},
    };

    const handled = await handleAndyFrontdeskMessages({
      chatJid: STATUS_QUERY_MESSAGE.chat_jid,
      group: ANDY_GROUP,
      messages: [STATUS_QUERY_MESSAGE],
      channel,
      runtime: {
        markCursorInFlight: () => {},
        clearInFlightCursor: () => {},
        markBatchProcessed: () => {},
        commitInFlightCursor: () => {},
      },
    });

    expect(handled).toBe(true);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain('There are no worker runs yet');
    expect(getAndyRequestByMessageId(STATUS_QUERY_MESSAGE.id)).toBeUndefined();
    expect(listActiveAndyRequests(STATUS_QUERY_MESSAGE.chat_jid)).toHaveLength(
      0,
    );
  });
});
