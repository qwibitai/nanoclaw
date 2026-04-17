import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { stripInternalTags } from './router.js';
import { createStreamEditLoop } from './stream-edit-loop.js';

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

function makeChannel() {
  return {
    sendStreamMessage: vi.fn(
      async (_jid: string, _text: string) => 42 as number | null,
    ),
    editMessage: vi.fn(
      async (_jid: string, _msgId: number, _text: string) => {},
    ),
    sendMessage: vi.fn(async (_jid: string, _text: string) => {}),
  };
}

type StreamChannel = ReturnType<typeof makeChannel>;

/**
 * Mirrors the index.ts integration pattern: a StreamEditLoop with a
 * sendOrEdit callback that first calls sendStreamMessage then
 * editMessage. Partials call loop.update(); finals call loop.flush()
 * and then decide between editMessage and sendMessage.
 */
async function simulateWithLoop(
  results: Array<{
    result: string | null;
    partial?: boolean;
    delay?: number;
  }>,
  channel: StreamChannel,
  options?: { hasPendingMessages?: boolean },
): Promise<{ outputSentToUser: boolean }> {
  let streamMessageId: number | null = null;
  let streamingFailed = false;
  let lastSentText: string | null = null;
  let outputSentToUser = false;

  const loop = createStreamEditLoop({
    throttleMs: 500,
    async sendOrEdit(text) {
      if (options?.hasPendingMessages) {
        streamMessageId = null;
        streamingFailed = true;
        throw new Error('pending');
      }
      if (streamMessageId === null) {
        const msgId = await channel.sendStreamMessage('jid', text);
        if (msgId === null) {
          streamingFailed = true;
          throw new Error('send failed');
        }
        streamMessageId = msgId;
        lastSentText = text;
      } else {
        if (text.length > 4000) {
          streamingFailed = true;
          throw new Error('too long');
        }
        try {
          await channel.editMessage('jid', streamMessageId, text);
          lastSentText = text;
        } catch (err) {
          streamingFailed = true;
          throw err;
        }
      }
    },
  });

  for (const result of results) {
    if (result.delay) {
      await vi.advanceTimersByTimeAsync(result.delay);
    }

    if (!result.result) continue;

    const raw =
      typeof result.result === 'string'
        ? result.result
        : JSON.stringify(result.result);
    const text = stripInternalTags(raw);

    if (result.partial) {
      if (!text || streamingFailed) continue;
      loop.update(text);
      continue;
    }

    await loop.flush();
    await loop.waitForInFlight();

    if (streamMessageId !== null) {
      if (text && text !== lastSentText) {
        if (
          !streamingFailed &&
          text.length <= 4096 &&
          !options?.hasPendingMessages
        ) {
          await channel.editMessage('jid', streamMessageId, text);
        } else {
          await channel.sendMessage('jid', text);
        }
      }
      outputSentToUser = true;
      lastSentText = text;
    } else if (text && text !== lastSentText) {
      await channel.sendMessage('jid', text);
      outputSentToUser = true;
      lastSentText = text;
    }

    loop.resetForNextQuery();
    streamMessageId = null;
    streamingFailed = false;
    lastSentText = null;
  }

  loop.stop();
  return { outputSentToUser };
}

describe('streaming output with StreamEditLoop — buffering', () => {
  it('buffers rapid partials instead of dropping them', async () => {
    const channel = makeChannel();

    await simulateWithLoop(
      [
        { result: 'Hello', partial: true },
        { result: 'Hello w', partial: true },
        { result: 'Hello wor', partial: true },
        { result: 'Hello world', partial: true, delay: 600 },
        { result: 'Hello world!', partial: false, delay: 600 },
      ],
      channel,
    );

    expect(channel.sendStreamMessage).toHaveBeenCalledTimes(1);
    expect(channel.sendStreamMessage).toHaveBeenCalledWith('jid', 'Hello');
    expect(channel.editMessage).toHaveBeenCalled();
    const lastEditCall =
      channel.editMessage.mock.calls[channel.editMessage.mock.calls.length - 1];
    expect(lastEditCall[2]).toBe('Hello world!');
  });

  it('stops streaming when text exceeds 4000 chars', async () => {
    const channel = makeChannel();
    const longText = 'x'.repeat(4001);

    const { outputSentToUser } = await simulateWithLoop(
      [
        { result: 'Short', partial: true },
        { result: longText, partial: true, delay: 600 },
        { result: 'Final result', partial: false, delay: 600 },
      ],
      channel,
    );

    expect(channel.sendStreamMessage).toHaveBeenCalledTimes(1);
    expect(channel.sendMessage).toHaveBeenCalledWith('jid', 'Final result');
    expect(outputSentToUser).toBe(true);
  });

  it('skips partial chunks with empty text after internal tag stripping', async () => {
    const channel = makeChannel();

    await simulateWithLoop(
      [
        { result: '<internal>thinking</internal>', partial: true },
        {
          result: '<internal>more thinking</internal>Answer',
          partial: false,
          delay: 600,
        },
      ],
      channel,
    );

    expect(channel.sendStreamMessage).not.toHaveBeenCalled();
    expect(channel.sendMessage).toHaveBeenCalledWith('jid', 'Answer');
  });

  it('edits streaming message with final text when different', async () => {
    const channel = makeChannel();

    await simulateWithLoop(
      [
        { result: 'Partial preview', partial: true },
        { result: 'Complete final response', partial: false, delay: 600 },
      ],
      channel,
    );

    expect(channel.sendStreamMessage).toHaveBeenCalledTimes(1);
    expect(channel.editMessage).toHaveBeenCalledWith(
      'jid',
      42,
      'Complete final response',
    );
  });
});

describe('streaming output with StreamEditLoop — failure fallbacks', () => {
  it('falls back to sendMessage when sendStreamMessage returns null', async () => {
    const channel = makeChannel();
    channel.sendStreamMessage.mockResolvedValue(null);

    const { outputSentToUser } = await simulateWithLoop(
      [
        { result: 'partial', partial: true },
        { result: 'Final answer', partial: false, delay: 100 },
      ],
      channel,
    );

    expect(channel.sendStreamMessage).toHaveBeenCalledTimes(1);
    expect(channel.editMessage).not.toHaveBeenCalled();
    expect(channel.sendMessage).toHaveBeenCalledWith('jid', 'Final answer');
    expect(outputSentToUser).toBe(true);
  });

  it('falls back to sendMessage when editMessage throws', async () => {
    const channel = makeChannel();
    channel.editMessage.mockRejectedValueOnce(
      new Error('Telegram edit failed'),
    );

    const { outputSentToUser } = await simulateWithLoop(
      [
        { result: 'First chunk', partial: true },
        { result: 'Second chunk', partial: true, delay: 600 },
        { result: 'Third chunk', partial: true, delay: 600 },
        { result: 'Complete response', partial: false, delay: 600 },
      ],
      channel,
    );

    expect(channel.sendStreamMessage).toHaveBeenCalledTimes(1);
    expect(channel.sendMessage).toHaveBeenCalledWith(
      'jid',
      'Complete response',
    );
    expect(outputSentToUser).toBe(true);
  });

  it('switches to sendMessage when pending messages exist', async () => {
    const channel = makeChannel();

    const { outputSentToUser } = await simulateWithLoop(
      [
        { result: 'First chunk', partial: true },
        { result: 'Second chunk', partial: true, delay: 600 },
        { result: 'Complete response', partial: false, delay: 600 },
      ],
      channel,
      { hasPendingMessages: true },
    );

    expect(channel.sendMessage).toHaveBeenCalledWith(
      'jid',
      'Complete response',
    );
    expect(outputSentToUser).toBe(true);
  });
});

describe('streaming output with StreamEditLoop — query lifecycle', () => {
  it('resets state between IPC queries', async () => {
    const channel = makeChannel();

    await simulateWithLoop(
      [
        { result: 'First answer', partial: true },
        { result: 'First answer', partial: false, delay: 600 },
        { result: 'Second answer', partial: true, delay: 100 },
        { result: 'Second answer', partial: false, delay: 600 },
      ],
      channel,
    );

    expect(channel.sendStreamMessage).toHaveBeenCalledTimes(2);
    expect(channel.sendStreamMessage).toHaveBeenNthCalledWith(
      1,
      'jid',
      'First answer',
    );
    expect(channel.sendStreamMessage).toHaveBeenNthCalledWith(
      2,
      'jid',
      'Second answer',
    );
  });

  it('no-ops when final text matches accumulated', async () => {
    const channel = makeChannel();

    const { outputSentToUser } = await simulateWithLoop(
      [
        { result: 'Complete text', partial: true },
        { result: 'Complete text', partial: false, delay: 600 },
      ],
      channel,
    );

    expect(outputSentToUser).toBe(true);
    expect(channel.editMessage).not.toHaveBeenCalled();
    expect(channel.sendMessage).not.toHaveBeenCalled();
  });
});
