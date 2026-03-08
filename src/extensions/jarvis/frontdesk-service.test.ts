import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  _initTestDatabase,
  createAndyRequestIfAbsent,
  getAndyRequestByMessageId,
  listActiveAndyRequests,
  updateAndyRequestState,
} from '../../db.js';
import {
  buildAndyProgressStatusReply,
  getAndyRequestsForMessages,
  handleAndyFrontdeskMessages,
} from './frontdesk-service.js';
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

  it('does not ack internal review triggers or create new intake requests', async () => {
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

    const reviewTrigger: NewMessage = {
      id: 'msg-review-trigger-1',
      chat_jid: 'andy-developer@g.us',
      sender: 'nanoclaw-review@nanoclaw',
      sender_name: 'nanoclaw-review',
      content: `<review_request>
{
  "request_id": "req-review-1",
  "run_id": "run-review-1",
  "repo": "openclaw-gurusharan/nanoclaw",
  "branch": "jarvis-review-1",
  "worker_group_folder": "jarvis-worker-1"
}
</review_request>`,
      timestamp: '2026-03-07T10:10:00.000Z',
    };

    const handled = await handleAndyFrontdeskMessages({
      chatJid: reviewTrigger.chat_jid,
      group: ANDY_GROUP,
      messages: [reviewTrigger],
      channel,
      runtime: {
        markCursorInFlight: () => {},
        clearInFlightCursor: () => {},
        markBatchProcessed: () => {},
        commitInFlightCursor: () => {},
      },
    });

    expect(handled).toBe(false);
    expect(sent).toHaveLength(0);
    expect(getAndyRequestByMessageId(reviewTrigger.id)).toBeUndefined();
    expect(listActiveAndyRequests(reviewTrigger.chat_jid)).toHaveLength(0);
  });

  it('maps review triggers back to the existing tracked request', () => {
    createAndyRequestIfAbsent({
      request_id: 'req-review-2',
      chat_jid: 'andy-developer@g.us',
      source_group_folder: 'andy-developer',
      user_message_id: 'msg-user-review-2',
      user_prompt: 'ship the change',
      intent: 'work_intake',
      state: 'worker_review_requested',
    });

    const refs = getAndyRequestsForMessages([
      {
        id: 'msg-review-trigger-2',
        chat_jid: 'andy-developer@g.us',
        sender: 'nanoclaw-review@nanoclaw',
        sender_name: 'nanoclaw-review',
        content: `<review_request>
{
  "request_id": "req-review-2",
  "run_id": "run-review-2",
  "repo": "openclaw-gurusharan/nanoclaw",
  "branch": "jarvis-review-2",
  "worker_group_folder": "jarvis-worker-2"
}
</review_request>`,
        timestamp: '2026-03-07T10:11:00.000Z',
      },
    ]);

    expect(refs).toEqual([
      {
        requestId: 'req-review-2',
        messageId: 'msg-review-trigger-2',
        kind: 'review',
      },
    ]);
  });

  it('humanizes explicit review ownership states in status replies', () => {
    createAndyRequestIfAbsent({
      request_id: 'req-review-3',
      chat_jid: 'andy-developer@g.us',
      source_group_folder: 'andy-developer',
      user_message_id: 'msg-user-review-3',
      user_prompt: 'check the worker result',
      intent: 'work_intake',
      state: 'worker_review_requested',
    });
    updateAndyRequestState(
      'req-review-3',
      'andy_patch_in_progress',
      'Applying a small follow-up fix on the same branch',
    );

    const reply = buildAndyProgressStatusReply(
      'andy-developer@g.us',
      'req-review-3',
    );

    expect(reply).toContain('Andy is applying a bounded review patch');
    expect(reply).toContain('`andy_patch_in_progress`');
  });

  it('treats stale review backlog as non-active status work', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-07T10:00:00.000Z'));

    try {
      createAndyRequestIfAbsent({
        request_id: 'req-review-stale-1',
        chat_jid: 'andy-developer@g.us',
        source_group_folder: 'andy-developer',
        user_message_id: 'msg-user-review-stale-1',
        user_prompt: 'check the worker result',
        intent: 'work_intake',
        state: 'worker_review_requested',
      });

      vi.setSystemTime(new Date('2026-03-07T13:30:01.000Z'));

      const reply = buildAndyProgressStatusReply('andy-developer@g.us');

      expect(reply).toContain('No worker run is active right now');
      expect(reply).toContain('stale review request');
      expect(reply).toContain('older than 180m');
    } finally {
      vi.useRealTimers();
    }
  });

  it('marks stale request-id status replies as non-active work', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-07T10:00:00.000Z'));

    try {
      createAndyRequestIfAbsent({
        request_id: 'req-review-stale-2',
        chat_jid: 'andy-developer@g.us',
        source_group_folder: 'andy-developer',
        user_message_id: 'msg-user-review-stale-2',
        user_prompt: 'check the worker result',
        intent: 'work_intake',
        state: 'worker_review_requested',
      });

      vi.setSystemTime(new Date('2026-03-07T13:30:01.000Z'));

      const reply = buildAndyProgressStatusReply(
        'andy-developer@g.us',
        'req-review-stale-2',
      );

      expect(reply).toContain('worker_review_requested');
      expect(reply).toContain('not counted as active work');
    } finally {
      vi.useRealTimers();
    }
  });
});
