import { describe, expect, it, vi } from 'vitest';

import { stripInternalTags } from './router.js';

interface TypingChannel {
  sendStreamMessage: (jid: string, text: string) => number | null;
  editMessage: (jid: string, messageId: number, text: string) => void;
  sendMessage: (jid: string, text: string) => void;
  setTyping: (jid: string, typing: boolean) => void;
}

/**
 * Replicates the typing keepalive logic from processGroupMessages.
 * Tracks typingActive state across multiple queries.
 */
function simulateMultiQueryWithTyping(
  results: Array<{ result: string | null; partial?: boolean; time?: number }>,
  channel: TypingChannel,
): { typingActiveAtEnd: boolean } {
  const EDIT_THROTTLE_MS = 1000;
  let lastSentText: string | null = null;
  let streamMessageId: number | null = null;
  let lastEditTime = 0;
  let streamingFailed = false;
  let typingActive = true;

  channel.setTyping('jid', true);

  for (const result of results) {
    if (!result.result) continue;

    const raw =
      typeof result.result === 'string'
        ? result.result
        : JSON.stringify(result.result);
    const text = stripInternalTags(raw);
    const now = result.time ?? lastEditTime + EDIT_THROTTLE_MS + 1;

    if (result.partial) {
      if (!typingActive) {
        typingActive = true;
        channel.setTyping('jid', true);
      }
      if (!text || streamingFailed) continue;

      if (streamMessageId === null) {
        const resolvedId = channel.sendStreamMessage('jid', text);
        if (resolvedId === null) {
          streamingFailed = true;
          continue;
        }
        streamMessageId = resolvedId;
        lastEditTime = now;
        lastSentText = text;
      } else {
        if (now - lastEditTime < EDIT_THROTTLE_MS) continue;
        if (text === lastSentText) continue;
        channel.editMessage('jid', streamMessageId, text);
        lastEditTime = now;
        lastSentText = text;
      }
      continue;
    }

    typingActive = false;

    if (streamMessageId !== null) {
      if (text && text !== lastSentText) {
        channel.editMessage('jid', streamMessageId, text);
      }
      lastSentText = text;
    } else if (text && text !== lastSentText) {
      channel.sendMessage('jid', text);
      lastSentText = text;
    }

    streamMessageId = null;
    lastEditTime = 0;
    streamingFailed = false;
    lastSentText = null;
  }

  return { typingActiveAtEnd: typingActive };
}

function makeTypingChannel(): TypingChannel {
  return {
    sendStreamMessage: vi.fn(() => 42),
    editMessage: vi.fn(),
    sendMessage: vi.fn(),
    setTyping: vi.fn(),
  };
}

describe('typing keepalive across queries (#26)', () => {
  it('re-enables typing when second query partial arrives after first query final', () => {
    const channel = makeTypingChannel();

    simulateMultiQueryWithTyping(
      [
        { result: 'Q1 partial', partial: true, time: 0 },
        { result: 'Q1 final', partial: false, time: 2000 },
        { result: 'Q2 partial', partial: true, time: 5000 },
        { result: 'Q2 final', partial: false, time: 7000 },
      ],
      channel,
    );

    const setTypingCalls = (channel.setTyping as ReturnType<typeof vi.fn>).mock
      .calls;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const typingTrueCalls = setTypingCalls.filter((c: any) => c[1] === true);
    expect(typingTrueCalls.length).toBe(2);
  });

  it('typingActive is false between queries (idle)', () => {
    const channel = makeTypingChannel();

    const { typingActiveAtEnd } = simulateMultiQueryWithTyping(
      [
        { result: 'Partial', partial: true, time: 0 },
        { result: 'Final', partial: false, time: 2000 },
      ],
      channel,
    );

    expect(typingActiveAtEnd).toBe(false);
  });

  it('typingActive stays true during streaming partials', () => {
    const channel = makeTypingChannel();

    const { typingActiveAtEnd } = simulateMultiQueryWithTyping(
      [
        { result: 'Partial 1', partial: true, time: 0 },
        { result: 'Partial 2', partial: true, time: 2000 },
      ],
      channel,
    );

    expect(typingActiveAtEnd).toBe(true);
  });
});
