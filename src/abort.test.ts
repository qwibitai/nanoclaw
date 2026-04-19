import { describe, it, expect, vi, beforeEach } from 'vitest';

import { isStopIntent, handleAbort } from './abort.js';
import type { RegisteredGroup, Channel } from './types.js';
import type { GroupQueue } from './group-queue.js';

vi.mock('./config.js', () => ({
  ASSISTANT_NAME: 'sagri-ai',
  getTriggerPattern: (trigger?: string) => {
    const t = (trigger || '@sagri-ai').trim();
    return new RegExp(`^${t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
  },
}));

vi.mock('./container-runtime.js', () => ({
  stopContainer: vi.fn(),
}));

vi.mock('./logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const publicGroup: RegisteredGroup = {
  name: 'Engineering',
  folder: 'engineering',
  trigger: '@sagri-ai',
  added_at: '2024-01-01T00:00:00.000Z',
  requiresTrigger: true,
};

const dmGroup: RegisteredGroup = {
  name: 'Alice DM',
  folder: 'alice-dm',
  trigger: '@sagri-ai',
  added_at: '2024-01-01T00:00:00.000Z',
  requiresTrigger: false,
};

// --- isStopIntent ---

describe('isStopIntent — public channel (requiresTrigger: true)', () => {
  it('returns true when trigger and stop keyword are present', () => {
    expect(isStopIntent('@sagri-ai stop', publicGroup)).toBe(true);
    expect(isStopIntent('@sagri-ai cancel', publicGroup)).toBe(true);
    expect(isStopIntent('@sagri-ai abort', publicGroup)).toBe(true);
  });

  it('is case-insensitive for keywords', () => {
    expect(isStopIntent('@sagri-ai STOP', publicGroup)).toBe(true);
    expect(isStopIntent('@sagri-ai Cancel', publicGroup)).toBe(true);
    expect(isStopIntent('@sagri-ai ABORT', publicGroup)).toBe(true);
  });

  it('returns false when trigger is missing', () => {
    expect(isStopIntent('stop', publicGroup)).toBe(false);
    expect(isStopIntent('please cancel', publicGroup)).toBe(false);
    expect(isStopIntent('abort', publicGroup)).toBe(false);
  });

  it('returns false when message has trigger but no stop keyword', () => {
    expect(isStopIntent('@sagri-ai what is the weather?', publicGroup)).toBe(
      false,
    );
  });

  it('returns false for empty message', () => {
    expect(isStopIntent('', publicGroup)).toBe(false);
  });

  it('requires whole-word match (stopwords inside other words do not trigger)', () => {
    expect(isStopIntent('@sagri-ai cancelation', publicGroup)).toBe(false);
    expect(isStopIntent('@sagri-ai stopping', publicGroup)).toBe(false);
  });
});

describe('isStopIntent — DM (requiresTrigger: false)', () => {
  it('returns true on keyword alone', () => {
    expect(isStopIntent('stop', dmGroup)).toBe(true);
    expect(isStopIntent('cancel', dmGroup)).toBe(true);
    expect(isStopIntent('abort', dmGroup)).toBe(true);
  });

  it('returns true even without trigger prefix', () => {
    expect(isStopIntent('please stop', dmGroup)).toBe(true);
    expect(isStopIntent('cancel this', dmGroup)).toBe(true);
  });

  it('is case-insensitive', () => {
    expect(isStopIntent('STOP', dmGroup)).toBe(true);
  });

  it('returns false when no keyword', () => {
    expect(isStopIntent('how are you?', dmGroup)).toBe(false);
  });
});

// --- handleAbort ---

describe('handleAbort', () => {
  let fakeQueue: GroupQueue;
  let fakeChannel: Channel;
  let stopContainerMock: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    const containerRuntime = await import('./container-runtime.js');
    stopContainerMock = vi.mocked(containerRuntime.stopContainer);
    stopContainerMock.mockClear();

    fakeChannel = {
      name: 'fake',
      connect: vi.fn(),
      disconnect: vi.fn(),
      isConnected: () => true,
      ownsJid: () => true,
      sendMessage: vi.fn(async () => {}),
    };

    fakeQueue = {
      getActiveContainerName: vi.fn(),
    } as unknown as GroupQueue;
  });

  it('stops the active container and sends confirmation', async () => {
    vi.mocked(fakeQueue.getActiveContainerName).mockReturnValue(
      'nanoclaw-engineering-1234567890',
    );

    await handleAbort('slack:C123', fakeQueue, fakeChannel);

    expect(stopContainerMock).toHaveBeenCalledWith(
      'nanoclaw-engineering-1234567890',
    );
    expect(fakeChannel.sendMessage).toHaveBeenCalledWith(
      'slack:C123',
      'Task aborted.',
    );
  });

  it('replies gracefully when no active container', async () => {
    vi.mocked(fakeQueue.getActiveContainerName).mockReturnValue(null);

    await handleAbort('slack:C123', fakeQueue, fakeChannel);

    expect(stopContainerMock).not.toHaveBeenCalled();
    expect(fakeChannel.sendMessage).toHaveBeenCalledWith(
      'slack:C123',
      'No task is currently running.',
    );
  });
});
