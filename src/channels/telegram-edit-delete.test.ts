import fs from 'fs';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./registry.js', async () => {
  const m = await import('./telegram-test-mocks.js');
  return m.registryMockFactory();
});
vi.mock('../env.js', async () => {
  const m = await import('./telegram-test-mocks.js');
  return m.envMockFactory();
});
vi.mock('../config.js', async () => {
  const m = await import('./telegram-test-mocks.js');
  return m.configMockFactory();
});
vi.mock('../live-location.js', async () => {
  const m = await import('./telegram-test-mocks.js');
  return m.liveLocationMockFactory();
});
vi.mock('../db.js', async () => {
  const m = await import('./telegram-test-mocks.js');
  return m.dbMockFactory();
});
vi.mock('../logger.js', async () => {
  const m = await import('./telegram-test-mocks.js');
  return m.loggerMockFactory();
});
vi.mock('../group-folder.js', async () => {
  const m = await import('./telegram-test-mocks.js');
  return m.groupFolderMockFactory();
});
vi.mock('grammy', async () => {
  const m = await import('./telegram-test-mocks.js');
  return m.grammyMockFactory();
});
import { TelegramChannel } from './telegram.js';
import { createTestOpts, currentBot } from './telegram-test-harness.js';

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(fs, 'mkdirSync').mockReturnValue(undefined);
  vi.spyOn(fs, 'writeFileSync').mockReturnValue(undefined);
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({
      ok: true,
      arrayBuffer: vi.fn().mockResolvedValue(new ArrayBuffer(8)),
    }),
  );
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('editMessage', () => {
  let channel: TelegramChannel;

  beforeEach(async () => {
    channel = new TelegramChannel('test-token', createTestOpts());
    await channel.connect();
  });

  it('edits message with Markdown parse_mode', async () => {
    await channel.editMessage!('tg:100200300', 1, 'hello');

    expect(currentBot().api.editMessageText).toHaveBeenCalledWith(
      '100200300',
      1,
      'hello',
      { parse_mode: 'Markdown' },
    );
  });

  it('silently ignores "message is not modified" error', async () => {
    currentBot().api.editMessageText.mockRejectedValue(
      new Error('Bad Request: message is not modified'),
    );

    // Should not throw
    await channel.editMessage!('tg:100200300', 1, 'same text');
  });

  it('retries on 429 with exponential backoff', async () => {
    vi.useFakeTimers();
    const editMock = currentBot().api.editMessageText;
    editMock
      .mockRejectedValueOnce(new Error('429: Too Many Requests'))
      .mockRejectedValueOnce(new Error('429: Too Many Requests'))
      .mockResolvedValueOnce(undefined);

    const promise = channel.editMessage!('tg:100200300', 1, 'text');

    // First retry after 1000ms
    await vi.advanceTimersByTimeAsync(1000);
    // Second retry after 2000ms
    await vi.advanceTimersByTimeAsync(2000);

    await promise;

    expect(editMock).toHaveBeenCalledTimes(3);
    vi.useRealTimers();
  });

  it('falls back to plain text on non-429 error', async () => {
    const editMock = currentBot().api.editMessageText;
    editMock
      .mockRejectedValueOnce(new Error('Bad Request: cannot parse Markdown'))
      .mockResolvedValueOnce(undefined); // plain text succeeds

    await channel.editMessage!('tg:100200300', 1, 'text');

    // Second call should be without parse_mode
    expect(editMock).toHaveBeenCalledTimes(2);
    expect(editMock.mock.calls[1]).toEqual(['100200300', 1, 'text']);
  });

  it('throws after exhausting all retries', async () => {
    vi.useFakeTimers();
    const editMock = currentBot().api.editMessageText;
    // All Markdown attempts get 429, plain text fallback also fails
    editMock.mockRejectedValue(new Error('429: Too Many Requests'));

    const promise = channel.editMessage!('tg:100200300', 1, 'text').catch(
      (e: Error) => e,
    );

    // First retry after 1000ms
    await vi.advanceTimersByTimeAsync(1000);
    // Second retry after 2000ms
    await vi.advanceTimersByTimeAsync(2000);
    // Let microtasks flush
    await vi.advanceTimersByTimeAsync(0);

    const result = await promise;
    expect(result).toBeInstanceOf(Error);
    expect((result as Error).message).toContain('429');
    vi.useRealTimers();
  });
});

// --- deleteMessage ---

describe('deleteMessage', () => {
  let channel: TelegramChannel;

  beforeEach(async () => {
    channel = new TelegramChannel('test-token', createTestOpts());
    await channel.connect();
  });

  it('calls bot.api.deleteMessage with numeric chat ID and message ID', async () => {
    await channel.deleteMessage!('tg:100200300', 42);

    expect(currentBot().api.deleteMessage).toHaveBeenCalledWith(
      '100200300',
      42,
    );
  });

  it('strips tg: prefix from JID', async () => {
    await channel.deleteMessage!('tg:-1001234567', 7);

    expect(currentBot().api.deleteMessage).toHaveBeenCalledWith(
      '-1001234567',
      7,
    );
  });

  it('does nothing when bot is not initialized', async () => {
    const uninitChannel = new TelegramChannel('test-token', createTestOpts());
    // do NOT call connect()
    await uninitChannel.deleteMessage!('tg:100200300', 1);

    // api.deleteMessage should not be called on an unconnected channel
    expect(currentBot().api.deleteMessage).not.toHaveBeenCalled();
  });
});

// --- Live location ---
