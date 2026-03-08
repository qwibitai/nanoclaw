import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  _initTestDatabase,
  createAndyRequestIfAbsent,
  getMessagesSince,
  updateAndyRequestState,
} from '../../db.js';
import { claimRuntimeOwnership } from '../../runtime-ownership.js';
import { MAIN_GROUP_FOLDER } from '../../config.js';
import {
  buildControlPlaneStatusSnapshot,
  getLaneStatus,
  handleMainLaneControlMessages,
  type LaneControlQueue,
} from './lane-control-service.js';
import {
  type Channel,
  type NewMessage,
  type RegisteredGroup,
} from '../../types.js';

const MAIN_GROUP: RegisteredGroup = {
  name: 'Main',
  folder: MAIN_GROUP_FOLDER,
  trigger: 'always',
  added_at: '2024-01-01T00:00:00.000Z',
  isMain: true,
  requiresTrigger: false,
};

const ANDY_GROUP: RegisteredGroup = {
  name: 'Andy Developer',
  folder: 'andy-developer',
  trigger: '@Andy',
  added_at: '2024-01-01T00:00:00.000Z',
};

const WORKER_GROUP: RegisteredGroup = {
  name: 'Jarvis Worker 1',
  folder: 'jarvis-worker-1',
  trigger: '@Andy',
  added_at: '2024-01-01T00:00:00.000Z',
};

function createRuntimeCallbacks() {
  return {
    markCursorInFlight: vi.fn(),
    clearInFlightCursor: vi.fn(),
    markBatchProcessed: vi.fn(),
    commitInFlightCursor: vi.fn(),
  };
}

function createQueueStub(
  overrides: Partial<LaneControlQueue> = {},
): LaneControlQueue {
  return {
    getStatus: vi.fn(() => ({
      active: false,
      idleWaiting: false,
      isTaskContainer: false,
      runningTaskId: null,
      pendingMessages: false,
      pendingTaskCount: 0,
      containerName: null,
      groupFolder: 'andy-developer',
    })),
    sendMessage: vi.fn(() => true),
    closeStdin: vi.fn(),
    enqueueMessageCheck: vi.fn(),
    ...overrides,
  };
}

function createChannel(sent: string[]): Channel {
  return {
    name: 'test',
    connect: async () => {},
    sendMessage: async (_jid, text) => {
      sent.push(text);
    },
    isConnected: () => true,
    ownsJid: () => true,
    disconnect: async () => {},
  };
}

function createMessage(content: string): NewMessage {
  return {
    id: `msg-${Math.random().toString(36).slice(2, 8)}`,
    chat_jid: 'main@g.us',
    sender: 'user@s.whatsapp.net',
    sender_name: 'User',
    content,
    timestamp: '2026-03-07T10:00:00.000Z',
  };
}

describe('lane-control-service', () => {
  beforeEach(() => {
    _initTestDatabase();
    claimRuntimeOwnership({
      pid: 101,
      ownerMode: 'manual',
      startedAt: '2026-03-07T09:59:00.000Z',
      heartbeatAt: '2026-03-07T10:00:00.000Z',
      claimedBy: 'lane-control-test',
      isPidAlive: () => true,
    });
  });

  it('returns false for ordinary main-lane messages so normal main flow continues', async () => {
    const sent: string[] = [];
    const runtime = createRuntimeCallbacks();

    const handled = await handleMainLaneControlMessages({
      chatJid: 'main@g.us',
      group: MAIN_GROUP,
      messages: [createMessage('Please plan the work for this repo')],
      channel: createChannel(sent),
      queue: createQueueStub(),
      registeredGroups: {
        'main@g.us': MAIN_GROUP,
        'andy-developer@g.us': ANDY_GROUP,
      },
      runtime,
    });

    expect(handled).toBe(false);
    expect(sent).toHaveLength(0);
    expect(runtime.markBatchProcessed).not.toHaveBeenCalled();
  });

  it('lets natural andy-developer status prompts fall through to the model/tool path', async () => {
    const sent: string[] = [];
    const runtime = createRuntimeCallbacks();
    const queue = createQueueStub({
      getStatus: vi.fn(() => ({
        active: true,
        idleWaiting: false,
        isTaskContainer: false,
        runningTaskId: null,
        pendingMessages: false,
        pendingTaskCount: 0,
        containerName: 'andy-container',
        groupFolder: 'andy-developer',
      })),
    });

    const handled = await handleMainLaneControlMessages({
      chatJid: 'main@g.us',
      group: MAIN_GROUP,
      messages: [createMessage('what is Andy developer doing right now?')],
      channel: createChannel(sent),
      queue,
      registeredGroups: {
        'main@g.us': MAIN_GROUP,
        'andy-developer@g.us': ANDY_GROUP,
      },
      runtime,
    });

    expect(handled).toBe(false);
    expect(sent).toHaveLength(0);
    expect(queue.sendMessage).not.toHaveBeenCalled();
  });

  it('builds a control-plane snapshot with queue-aware andy-developer status', () => {
    const queue = createQueueStub({
      getStatus: vi.fn(() => ({
        active: true,
        idleWaiting: false,
        isTaskContainer: false,
        runningTaskId: null,
        pendingMessages: false,
        pendingTaskCount: 0,
        containerName: 'andy-container',
        groupFolder: 'andy-developer',
      })),
    });

    const snapshot = buildControlPlaneStatusSnapshot({
      registeredGroups: {
        'main@g.us': MAIN_GROUP,
        'andy-developer@g.us': ANDY_GROUP,
      },
      queue,
    });

    expect(snapshot.lanes['andy-developer']).toBeDefined();
    expect(snapshot.lanes['andy-developer']?.availability).toBe('busy');
    expect(snapshot.lanes['andy-developer']?.summary).toContain(
      'There are no worker runs yet',
    );
    expect(snapshot.lanes['andy-developer']?.active_requests).toHaveLength(0);
  });

  it('treats active Andy review ownership as busy work', () => {
    createAndyRequestIfAbsent({
      request_id: 'req-review-busy-1',
      chat_jid: 'andy-developer@g.us',
      source_group_folder: 'andy-developer',
      user_message_id: 'msg-review-busy-1',
      user_prompt: 'review the worker output',
      intent: 'work_intake',
      state: 'worker_review_requested',
    });
    updateAndyRequestState(
      'req-review-busy-1',
      'review_in_progress',
      'Reviewing completion artifacts',
    );

    const status = getLaneStatus({
      laneId: 'andy-developer',
      registeredGroups: {
        'main@g.us': MAIN_GROUP,
        'andy-developer@g.us': ANDY_GROUP,
      },
      queue: createQueueStub(),
    });

    expect(status.availability).toBe('busy');
    expect(status.summary).toContain('Andy review in progress');
  });

  it('does not treat stale review backlog as queued live work', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-07T10:00:00.000Z'));

    try {
      createAndyRequestIfAbsent({
        request_id: 'req-review-stale-queue-1',
        chat_jid: 'andy-developer@g.us',
        source_group_folder: 'andy-developer',
        user_message_id: 'msg-review-stale-queue-1',
        user_prompt: 'review the worker output',
        intent: 'work_intake',
        state: 'worker_review_requested',
      });

      vi.setSystemTime(new Date('2026-03-07T13:30:01.000Z'));

      const snapshot = buildControlPlaneStatusSnapshot({
        registeredGroups: {
          'main@g.us': MAIN_GROUP,
          'andy-developer@g.us': ANDY_GROUP,
        },
        queue: createQueueStub(),
      });

      expect(snapshot.lanes['andy-developer']?.availability).toBe('idle');
      expect(snapshot.lanes['andy-developer']?.active_requests).toHaveLength(0);
      expect(snapshot.lanes['andy-developer']?.summary).toContain(
        'stale review request',
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('answers request status by request id from persisted state', async () => {
    createAndyRequestIfAbsent({
      request_id: 'req-main-status-1',
      chat_jid: 'andy-developer@g.us',
      source_group_folder: 'andy-developer',
      user_message_id: 'msg-main-status-1',
      user_prompt: 'take care of authorization',
      intent: 'work_intake',
      state: 'queued_for_coordinator',
    });
    updateAndyRequestState(
      'req-main-status-1',
      'coordinator_active',
      'Coordinator is processing your request',
    );

    const sent: string[] = [];
    const runtime = createRuntimeCallbacks();

    const handled = await handleMainLaneControlMessages({
      chatJid: 'main@g.us',
      group: MAIN_GROUP,
      messages: [createMessage('status req-main-status-1')],
      channel: createChannel(sent),
      queue: createQueueStub(),
      registeredGroups: {
        'main@g.us': MAIN_GROUP,
        'andy-developer@g.us': ANDY_GROUP,
      },
      runtime,
    });

    expect(handled).toBe(true);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain('`req-main-status-1`');
    expect(sent[0]).toContain('`coordinator_active`');
  });

  it('answers main-lane shorthand status command for andy-developer', async () => {
    const sent: string[] = [];
    const runtime = createRuntimeCallbacks();

    const handled = await handleMainLaneControlMessages({
      chatJid: 'main@g.us',
      group: MAIN_GROUP,
      messages: [createMessage('status')],
      channel: createChannel(sent),
      queue: createQueueStub(),
      registeredGroups: {
        'main@g.us': MAIN_GROUP,
        'andy-developer@g.us': ANDY_GROUP,
      },
      runtime,
    });

    expect(handled).toBe(true);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain('`andy-developer` is idle');
  });

  it('accepts shorthand steer command for andy-developer', async () => {
    const sent: string[] = [];
    const runtime = createRuntimeCallbacks();
    const queue = createQueueStub({
      getStatus: vi.fn(() => ({
        active: true,
        idleWaiting: false,
        isTaskContainer: false,
        runningTaskId: null,
        pendingMessages: false,
        pendingTaskCount: 0,
        containerName: 'andy-container',
        groupFolder: 'andy-developer',
      })),
      sendMessage: vi.fn(() => true),
    });

    const handled = await handleMainLaneControlMessages({
      chatJid: 'main@g.us',
      group: MAIN_GROUP,
      messages: [createMessage('steer: focus on authorization first')],
      channel: createChannel(sent),
      queue,
      registeredGroups: {
        'main@g.us': MAIN_GROUP,
        'andy-developer@g.us': ANDY_GROUP,
      },
      runtime,
    });

    expect(handled).toBe(true);
    expect(queue.sendMessage).toHaveBeenCalledWith(
      'andy-developer@g.us',
      'Main lane steer: focus on authorization first',
    );
    expect(sent[0]).toContain('Sent a steer');
  });

  it('steers the active andy-developer session only through the explicit steer command', async () => {
    const sent: string[] = [];
    const runtime = createRuntimeCallbacks();
    const queue = createQueueStub({
      getStatus: vi.fn(() => ({
        active: true,
        idleWaiting: false,
        isTaskContainer: false,
        runningTaskId: null,
        pendingMessages: false,
        pendingTaskCount: 0,
        containerName: 'andy-container',
        groupFolder: 'andy-developer',
      })),
      sendMessage: vi.fn(() => true),
    });

    const handled = await handleMainLaneControlMessages({
      chatJid: 'main@g.us',
      group: MAIN_GROUP,
      messages: [
        createMessage('steer andy-developer: focus on authorization first'),
      ],
      channel: createChannel(sent),
      queue,
      registeredGroups: {
        'main@g.us': MAIN_GROUP,
        'andy-developer@g.us': ANDY_GROUP,
      },
      runtime,
    });

    expect(handled).toBe(true);
    expect(queue.sendMessage).toHaveBeenCalledWith(
      'andy-developer@g.us',
      'Main lane steer: focus on authorization first',
    );
    expect(sent[0]).toContain('Sent a steer');
  });

  it('accepts shorthand interrupt command for andy-developer', async () => {
    const sent: string[] = [];
    const runtime = createRuntimeCallbacks();
    const queue = createQueueStub({
      getStatus: vi.fn(() => ({
        active: true,
        idleWaiting: false,
        isTaskContainer: false,
        runningTaskId: null,
        pendingMessages: false,
        pendingTaskCount: 0,
        containerName: 'andy-container',
        groupFolder: 'andy-developer',
      })),
    });

    const handled = await handleMainLaneControlMessages({
      chatJid: 'main@g.us',
      group: MAIN_GROUP,
      messages: [createMessage('interrupt: stop and re-evaluate the approach')],
      channel: createChannel(sent),
      queue,
      registeredGroups: {
        'main@g.us': MAIN_GROUP,
        'andy-developer@g.us': ANDY_GROUP,
      },
      runtime,
    });

    expect(handled).toBe(true);
    expect(queue.closeStdin).toHaveBeenCalledWith('andy-developer@g.us');
    expect(queue.enqueueMessageCheck).toHaveBeenCalledWith(
      'andy-developer@g.us',
    );
    const messages = getMessagesSince(
      'andy-developer@g.us',
      '1970-01-01T00:00:00.000Z',
      'Andy',
    );
    expect(messages).toHaveLength(1);
    expect(messages[0].content).toContain(
      '@Andy Main lane steer: stop and re-evaluate the approach',
    );
    expect(sent[0]).toContain('Soft-interrupted');
  });

  it('soft-interrupts andy-developer and queues the steer as the next turn', async () => {
    const sent: string[] = [];
    const runtime = createRuntimeCallbacks();
    const queue = createQueueStub({
      getStatus: vi.fn(() => ({
        active: true,
        idleWaiting: false,
        isTaskContainer: false,
        runningTaskId: null,
        pendingMessages: false,
        pendingTaskCount: 0,
        containerName: 'andy-container',
        groupFolder: 'andy-developer',
      })),
    });

    const handled = await handleMainLaneControlMessages({
      chatJid: 'main@g.us',
      group: MAIN_GROUP,
      messages: [
        createMessage(
          'interrupt andy-developer: stop and re-evaluate the approach',
        ),
      ],
      channel: createChannel(sent),
      queue,
      registeredGroups: {
        'main@g.us': MAIN_GROUP,
        'andy-developer@g.us': ANDY_GROUP,
      },
      runtime,
    });

    expect(handled).toBe(true);
    expect(queue.closeStdin).toHaveBeenCalledWith('andy-developer@g.us');
    expect(queue.enqueueMessageCheck).toHaveBeenCalledWith(
      'andy-developer@g.us',
    );
    const messages = getMessagesSince(
      'andy-developer@g.us',
      '1970-01-01T00:00:00.000Z',
      'Andy',
    );
    expect(messages).toHaveLength(1);
    expect(messages[0].content).toContain(
      '@Andy Main lane steer: stop and re-evaluate the approach',
    );
    expect(sent[0]).toContain('Soft-interrupted');
  });

  it('rejects direct worker steering from main', async () => {
    const sent: string[] = [];
    const runtime = createRuntimeCallbacks();
    const queue = createQueueStub();

    const handled = await handleMainLaneControlMessages({
      chatJid: 'main@g.us',
      group: MAIN_GROUP,
      messages: [createMessage('steer jarvis-worker-1: implement it now')],
      channel: createChannel(sent),
      queue,
      registeredGroups: {
        'main@g.us': MAIN_GROUP,
        'andy-developer@g.us': ANDY_GROUP,
        'jarvis-worker-1@nanoclaw': WORKER_GROUP,
      },
      runtime,
    });

    expect(handled).toBe(true);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain('Main may only steer `andy-developer`');
    expect(queue.sendMessage).not.toHaveBeenCalled();
    expect(queue.closeStdin).not.toHaveBeenCalled();
  });
});
