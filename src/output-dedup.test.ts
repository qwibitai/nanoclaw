import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { stripInternalTags } from './router.js';
import { createStreamEditLoop } from './stream-edit-loop.js';

/**
 * Tests for duplicate output suppression and streaming logic in the
 * host-side onOutput callback.
 *
 * processGroupMessages is a non-exported function with heavy dependencies,
 * so we test the dedup/streaming pattern in isolation — the same logic
 * used in src/index.ts.
 */

describe('host-side output dedup', () => {
  /**
   * Replicates the exact dedup logic from processGroupMessages onOutput callback.
   * When the agent emits multiple result chunks with the same text,
   * only the first should trigger sendMessage.
   */
  function simulateOnOutput(
    results: Array<{ result: string | null; partial?: boolean }>,
    sendMessage: (text: string) => Promise<void>,
  ) {
    let lastSentText: string | null = null;

    for (const result of results) {
      if (result.result) {
        const raw =
          typeof result.result === 'string'
            ? result.result
            : JSON.stringify(result.result);
        const text = stripInternalTags(raw);
        if (result.partial) continue; // partials handled in streaming tests
        if (text && text !== lastSentText) {
          sendMessage(text);
          lastSentText = text;
        }
      }
    }
  }

  it('suppresses duplicate result text', () => {
    const sendMessage = vi.fn(async () => {});

    simulateOnOutput(
      [
        { result: 'Hello world' },
        { result: 'Hello world' }, // duplicate
      ],
      sendMessage,
    );

    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenCalledWith('Hello world');
  });

  it('allows distinct result texts through', () => {
    const sendMessage = vi.fn(async () => {});

    simulateOnOutput(
      [{ result: 'First response' }, { result: 'Second response' }],
      sendMessage,
    );

    expect(sendMessage).toHaveBeenCalledTimes(2);
    expect(sendMessage).toHaveBeenCalledWith('First response');
    expect(sendMessage).toHaveBeenCalledWith('Second response');
  });

  it('skips partial chunks', () => {
    const sendMessage = vi.fn(async () => {});

    simulateOnOutput(
      [{ result: 'streaming...', partial: true }, { result: 'Final answer' }],
      sendMessage,
    );

    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenCalledWith('Final answer');
  });

  it('skips null results', () => {
    const sendMessage = vi.fn(async () => {});

    simulateOnOutput(
      [
        { result: 'Response text' },
        { result: null }, // session-update marker
      ],
      sendMessage,
    );

    expect(sendMessage).toHaveBeenCalledTimes(1);
  });

  it('strips internal tags before dedup comparison', () => {
    const sendMessage = vi.fn(async () => {});

    simulateOnOutput(
      [
        { result: '<internal>thinking</internal>Hello' },
        { result: 'Hello' }, // same visible text after stripping
      ],
      sendMessage,
    );

    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenCalledWith('Hello');
  });

  it('treats text differing only in internal tags as duplicates', () => {
    const sendMessage = vi.fn(async () => {});

    simulateOnOutput(
      [
        { result: '<internal>reason A</internal>Answer' },
        { result: '<internal>reason B</internal>Answer' }, // different internal, same visible
      ],
      sendMessage,
    );

    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenCalledWith('Answer');
  });
});

describe('streaming output', () => {
  const EDIT_THROTTLE_MS = 1000;

  interface StreamChannel {
    sendStreamMessage: (jid: string, text: string) => number | null;
    editMessage: (jid: string, messageId: number, text: string) => void;
    sendMessage: (jid: string, text: string) => void;
  }

  /**
   * Replicates the streaming logic from processGroupMessages onOutput callback.
   * Processes results sequentially, forwarding partials to sendStreamMessage/editMessage
   * and finals to editMessage (if streaming) or sendMessage (fallback).
   */
  function simulateStreamingOutput(
    results: Array<{ result: string | null; partial?: boolean; time?: number }>,
    channel: StreamChannel,
    options?: { hasPendingMessages?: boolean },
  ): { outputSentToUser: boolean } {
    let lastSentText: string | null = null;
    let streamMessageId: number | null = null;
    let lastEditTime = 0;
    let streamingFailed = false;
    let outputSentToUser = false;

    for (const result of results) {
      if (!result.result) continue;

      const raw =
        typeof result.result === 'string'
          ? result.result
          : JSON.stringify(result.result);
      const text = stripInternalTags(raw);
      const now = result.time ?? lastEditTime + EDIT_THROTTLE_MS + 1;

      if (result.partial) {
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
          if (options?.hasPendingMessages) {
            streamMessageId = null;
            streamingFailed = true;
            continue;
          }
          if (text.length > 4000) {
            streamingFailed = true;
            continue;
          }
          try {
            channel.editMessage('jid', streamMessageId, text);
            lastEditTime = now;
            lastSentText = text;
            // eslint-disable-next-line no-catch-all/no-catch-all
          } catch {
            streamingFailed = true;
            continue;
          }
        }
        continue;
      }

      // Final result
      if (streamMessageId !== null) {
        if (text && text !== lastSentText) {
          if (
            !streamingFailed &&
            text.length <= 4096 &&
            !options?.hasPendingMessages
          ) {
            channel.editMessage('jid', streamMessageId, text);
          } else {
            channel.sendMessage('jid', text);
          }
        }
        outputSentToUser = true;
        lastSentText = text;
      } else if (text && text !== lastSentText) {
        channel.sendMessage('jid', text);
        outputSentToUser = true;
        lastSentText = text;
      }
      // Reset streaming state for next IPC query
      streamMessageId = null;
      lastEditTime = 0;
      streamingFailed = false;
      lastSentText = null;
    }

    return { outputSentToUser };
  }

  function makeChannel(overrides?: Partial<StreamChannel>): StreamChannel {
    return {
      sendStreamMessage: vi.fn(() => 42),
      editMessage: vi.fn(() => {}),
      sendMessage: vi.fn(() => {}),
      ...overrides,
    };
  }

  it('uses partial text directly (agent-runner accumulates)', () => {
    const channel = makeChannel();

    // Agent-runner sends pre-accumulated text in each partial
    simulateStreamingOutput(
      [
        { result: 'Looking into it...', partial: true, time: 0 },
        {
          result: 'Looking into it...\n\nHere is the answer.',
          partial: true,
          time: 2000,
        },
        {
          result: 'Looking into it...\n\nHere is the answer.',
          partial: false,
          time: 4000,
        },
      ],
      channel,
    );

    expect(channel.sendStreamMessage).toHaveBeenCalledTimes(1);
    expect(channel.sendStreamMessage).toHaveBeenCalledWith(
      'jid',
      'Looking into it...',
    );
    expect(channel.editMessage).toHaveBeenCalledTimes(1);
    expect(channel.editMessage).toHaveBeenCalledWith(
      'jid',
      42,
      'Looking into it...\n\nHere is the answer.',
    );
    expect(channel.sendMessage).not.toHaveBeenCalled();
  });

  it('throttles edits within EDIT_THROTTLE_MS', () => {
    const channel = makeChannel();

    // Agent-runner sends growing text; host throttles edits
    simulateStreamingOutput(
      [
        { result: 'Hello', partial: true, time: 0 },
        { result: 'Hello w', partial: true, time: 300 }, // throttled
        { result: 'Hello wor', partial: true, time: 700 }, // throttled
        { result: 'Hello world', partial: true, time: 1500 }, // sent
        { result: 'Hello world!', partial: false, time: 3000 },
      ],
      channel,
    );

    expect(channel.sendStreamMessage).toHaveBeenCalledTimes(1);
    expect(channel.editMessage).toHaveBeenCalledTimes(2);
    expect(channel.editMessage).toHaveBeenCalledWith('jid', 42, 'Hello world');
    expect(channel.editMessage).toHaveBeenCalledWith('jid', 42, 'Hello world!');
  });

  it('falls back to sendMessage when sendStreamMessage returns null', () => {
    const channel = makeChannel({
      sendStreamMessage: vi.fn(() => null),
    });

    const { outputSentToUser } = simulateStreamingOutput(
      [
        { result: 'partial', partial: true },
        { result: 'Final answer', partial: false },
      ],
      channel,
    );

    expect(channel.sendStreamMessage).toHaveBeenCalledTimes(1);
    expect(channel.editMessage).not.toHaveBeenCalled();
    expect(channel.sendMessage).toHaveBeenCalledWith('jid', 'Final answer');
    expect(outputSentToUser).toBe(true);
  });

  it('marks outputSentToUser when final text matches accumulated', () => {
    const channel = makeChannel();

    const { outputSentToUser } = simulateStreamingOutput(
      [
        { result: 'Complete text', partial: true, time: 0 },
        { result: 'Complete text', partial: false, time: 2000 },
      ],
      channel,
    );

    expect(outputSentToUser).toBe(true);
    // Accumulated text already displayed via sendStreamMessage — no extra edit
    expect(channel.editMessage).not.toHaveBeenCalled();
    expect(channel.sendMessage).not.toHaveBeenCalled();
  });

  it('stops streaming when text exceeds 4000 chars', () => {
    const channel = makeChannel();
    const longText = 'x'.repeat(4001);

    const { outputSentToUser } = simulateStreamingOutput(
      [
        { result: 'Short', partial: true, time: 0 },
        { result: longText, partial: true, time: 2000 }, // > 4000 triggers streamingFailed
        { result: 'Final result', partial: false, time: 4000 },
      ],
      channel,
    );

    expect(channel.sendStreamMessage).toHaveBeenCalledTimes(1);
    expect(channel.editMessage).not.toHaveBeenCalled();
    expect(channel.sendMessage).toHaveBeenCalledWith('jid', 'Final result');
    expect(outputSentToUser).toBe(true);
  });

  it('skips partial chunks with empty text after internal tag stripping', () => {
    const channel = makeChannel();

    simulateStreamingOutput(
      [
        { result: '<internal>thinking</internal>', partial: true },
        { result: '<internal>more thinking</internal>Answer', partial: false },
      ],
      channel,
    );

    expect(channel.sendStreamMessage).not.toHaveBeenCalled();
    expect(channel.sendMessage).toHaveBeenCalledWith('jid', 'Answer');
  });

  it('resets streaming state between IPC queries (consecutive finals)', () => {
    const channel = makeChannel();

    // Simulate two consecutive IPC queries through the same onOutput callback
    simulateStreamingOutput(
      [
        // First query
        { result: 'First answer', partial: true, time: 0 },
        { result: 'First answer', partial: false, time: 1000 },
        // Second query — must NOT reuse streamMessageId from first query
        { result: 'Second answer', partial: true, time: 5000 },
        { result: 'Second answer', partial: false, time: 6000 },
      ],
      channel,
    );

    // Each query should create its own streaming message
    expect(channel.sendStreamMessage).toHaveBeenCalledTimes(2);
    expect(channel.editMessage).not.toHaveBeenCalled();
    expect(channel.sendMessage).not.toHaveBeenCalled();
  });

  it('creates new streaming message for each IPC query', () => {
    const channel = makeChannel();

    simulateStreamingOutput(
      [
        // First query
        { result: 'First response', partial: true, time: 0 },
        { result: 'First response', partial: false, time: 1000 },
        // Second query — independent streaming message
        { result: 'Second response', partial: true, time: 5000 },
        { result: 'Second response', partial: false, time: 6000 },
      ],
      channel,
    );

    expect(channel.sendStreamMessage).toHaveBeenCalledTimes(2);
    expect(channel.sendStreamMessage).toHaveBeenNthCalledWith(
      1,
      'jid',
      'First response',
    );
    expect(channel.sendStreamMessage).toHaveBeenNthCalledWith(
      2,
      'jid',
      'Second response',
    );
    expect(channel.editMessage).not.toHaveBeenCalled();
  });

  it('edits streaming message with final text when different', () => {
    const channel = makeChannel();

    simulateStreamingOutput(
      [
        { result: 'Partial preview', partial: true, time: 0 },
        { result: 'Complete final response', partial: false, time: 2000 },
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

  it('falls back to sendMessage when editMessage fails during partial', () => {
    let editCallCount = 0;
    const channel = makeChannel({
      editMessage: vi.fn(() => {
        editCallCount++;
        if (editCallCount === 1) throw new Error('Telegram edit failed');
      }),
    });

    const { outputSentToUser } = simulateStreamingOutput(
      [
        { result: 'First chunk', partial: true, time: 0 },
        { result: 'Second chunk', partial: true, time: 2000 }, // edit fails
        { result: 'Third chunk', partial: true, time: 4000 }, // skipped (streamingFailed)
        { result: 'Complete response', partial: false, time: 6000 },
      ],
      channel,
    );

    expect(channel.sendStreamMessage).toHaveBeenCalledTimes(1);
    // First edit attempt fails → streamingFailed
    expect(channel.editMessage).toHaveBeenCalledTimes(1);
    // Final uses sendMessage because streamingFailed
    expect(channel.sendMessage).toHaveBeenCalledWith(
      'jid',
      'Complete response',
    );
    expect(outputSentToUser).toBe(true);
  });

  it('switches to sendMessage when pending messages arrive during partial streaming', () => {
    const channel = makeChannel();

    const { outputSentToUser } = simulateStreamingOutput(
      [
        { result: 'First chunk', partial: true, time: 0 },
        { result: 'Second chunk', partial: true, time: 2000 }, // hasPendingMessages → reset
        { result: 'Third chunk', partial: true, time: 4000 }, // skipped (streamingFailed)
        { result: 'Complete response', partial: false, time: 6000 },
      ],
      channel,
      { hasPendingMessages: true },
    );

    expect(channel.sendStreamMessage).toHaveBeenCalledTimes(1);
    // Second partial triggers pending check → streamingFailed, no edit
    expect(channel.editMessage).not.toHaveBeenCalled();
    // Final uses sendMessage because streamingFailed
    expect(channel.sendMessage).toHaveBeenCalledWith(
      'jid',
      'Complete response',
    );
    expect(outputSentToUser).toBe(true);
  });

  it('final result uses sendMessage when pending messages exist even if streaming succeeded', () => {
    const channel = makeChannel();

    // hasPendingMessages only affects the final delivery (streamingFailed stays false
    // because the first partial doesn't go through the pending check path)
    const { outputSentToUser } = simulateStreamingOutput(
      [
        { result: 'Streamed text', partial: true, time: 0 },
        { result: 'Final text', partial: false, time: 2000 },
      ],
      channel,
      { hasPendingMessages: true },
    );

    expect(channel.sendStreamMessage).toHaveBeenCalledTimes(1);
    // Final: streamingFailed=false but hasPendingMessages=true → sendMessage
    expect(channel.sendMessage).toHaveBeenCalledWith('jid', 'Final text');
    expect(channel.editMessage).not.toHaveBeenCalled();
    expect(outputSentToUser).toBe(true);
  });

  it('no-ops when final has no text and streaming was active', () => {
    const channel = makeChannel();

    const { outputSentToUser } = simulateStreamingOutput(
      [
        { result: 'Streamed text', partial: true, time: 0 },
        { result: '<internal>done</internal>', partial: false, time: 2000 },
      ],
      channel,
    );

    expect(channel.sendStreamMessage).toHaveBeenCalledTimes(1);
    // Final text is empty after stripping — but streaming was active so outputSentToUser
    expect(outputSentToUser).toBe(true);
    expect(channel.editMessage).not.toHaveBeenCalled();
    expect(channel.sendMessage).not.toHaveBeenCalled();
  });

  it('reduced throttle (1000ms) allows edits that 1500ms would have blocked', () => {
    const channel = makeChannel();

    // At 1200ms gap: would be blocked by old 1500ms throttle, allowed by new 1000ms
    simulateStreamingOutput(
      [
        { result: 'First chunk', partial: true, time: 0 },
        { result: 'Second chunk', partial: true, time: 1200 },
        { result: 'Final', partial: false, time: 3000 },
      ],
      channel,
    );

    expect(channel.sendStreamMessage).toHaveBeenCalledTimes(1);
    expect(channel.editMessage).toHaveBeenCalledTimes(2); // partial edit + final edit
  });
});

describe('typing keepalive across queries (#26)', () => {
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

    channel.setTyping('jid', true); // initial typing

    for (const result of results) {
      if (!result.result) continue;

      const raw =
        typeof result.result === 'string'
          ? result.result
          : JSON.stringify(result.result);
      const text = stripInternalTags(raw);
      const now = result.time ?? lastEditTime + EDIT_THROTTLE_MS + 1;

      if (result.partial) {
        // Re-enable typing if it was paused after a previous query's final result (#26)
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

      // Final result — pause typing
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

      // Reset streaming state for next IPC query
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

  it('re-enables typing when second query partial arrives after first query final', () => {
    const channel = makeTypingChannel();

    simulateMultiQueryWithTyping(
      [
        // Query 1
        { result: 'Q1 partial', partial: true, time: 0 },
        { result: 'Q1 final', partial: false, time: 2000 },
        // Query 2
        { result: 'Q2 partial', partial: true, time: 5000 },
        { result: 'Q2 final', partial: false, time: 7000 },
      ],
      channel,
    );

    const setTypingCalls = (channel.setTyping as ReturnType<typeof vi.fn>).mock
      .calls;
    // Initial typing(true), then typing re-enabled on Q2's first partial
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const typingTrueCalls = setTypingCalls.filter((c: any) => c[1] === true);
    expect(typingTrueCalls.length).toBe(2); // initial + Q2 resume
  });

  it('typingActive is false between queries (idle)', () => {
    const channel = makeTypingChannel();

    const { typingActiveAtEnd } = simulateMultiQueryWithTyping(
      [
        { result: 'Partial', partial: true, time: 0 },
        { result: 'Final', partial: false, time: 2000 },
        // No more queries — simulates idle
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
        // Still streaming — no final yet
      ],
      channel,
    );

    expect(typingActiveAtEnd).toBe(true);
  });
});

/**
 * Tests for agent-runner stream event processing pattern.
 *
 * The agent-runner accumulates text deltas from SDK stream events
 * and emits them as partial output. This tests the same logic
 * used in container/agent-runner/src/index.ts.
 */
describe('agent-runner streaming buffer', () => {
  type StreamEvent = {
    type: string;
    event: {
      type: string;
      delta?: { type?: string; text?: string };
    };
  };

  type AssistantMessage = {
    type: 'assistant';
    message?: { content?: Array<{ type: string; text?: string }> };
  };

  type SDKMessage = StreamEvent | AssistantMessage | { type: string };

  /**
   * Replicates the stream_event + assistant message processing logic
   * from the agent-runner's runQuery function.
   */
  function simulateAgentRunner(
    messages: SDKMessage[],
    writeOutput: (output: { result: string; partial: true }) => void,
  ) {
    let streamingTextBuffer = '';
    let completedTurnsText = '';

    for (const message of messages) {
      if (message.type === 'stream_event') {
        const event = (message as StreamEvent).event;
        if (
          event.type === 'content_block_delta' &&
          event.delta?.type === 'text_delta' &&
          event.delta.text
        ) {
          streamingTextBuffer += event.delta.text;
          const fullText = completedTurnsText
            ? completedTurnsText + '\n\n' + streamingTextBuffer
            : streamingTextBuffer;
          const visible = stripInternalTags(fullText);
          if (visible) {
            writeOutput({ result: visible, partial: true });
          }
        }
        if (event.type === 'message_start') {
          streamingTextBuffer = '';
        }
      }

      if (message.type === 'assistant') {
        if (streamingTextBuffer) {
          completedTurnsText = completedTurnsText
            ? completedTurnsText + '\n\n' + streamingTextBuffer
            : streamingTextBuffer;
        }
        streamingTextBuffer = '';
      }
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let writeOutputMock: any;
  const writeOutput = (output: { result: string; partial: boolean }) =>
    writeOutputMock(output);

  beforeEach(() => {
    writeOutputMock = vi.fn();
  });

  it('accumulates text deltas into partial output', () => {
    simulateAgentRunner(
      [
        {
          type: 'stream_event',
          event: {
            type: 'content_block_delta',
            delta: { type: 'text_delta', text: 'Hello' },
          },
        },
        {
          type: 'stream_event',
          event: {
            type: 'content_block_delta',
            delta: { type: 'text_delta', text: ' world' },
          },
        },
      ],
      writeOutput,
    );

    expect(writeOutputMock).toHaveBeenCalledTimes(2);
    expect(writeOutputMock).toHaveBeenNthCalledWith(1, {
      result: 'Hello',
      partial: true,
    });
    expect(writeOutputMock).toHaveBeenNthCalledWith(2, {
      result: 'Hello world',
      partial: true,
    });
  });

  it('resets streamingTextBuffer on message_start but keeps completedTurnsText', () => {
    simulateAgentRunner(
      [
        {
          type: 'stream_event',
          event: {
            type: 'content_block_delta',
            delta: { type: 'text_delta', text: 'First turn' },
          },
        },
        { type: 'assistant' },
        {
          type: 'stream_event',
          event: { type: 'message_start' },
        },
        {
          type: 'stream_event',
          event: {
            type: 'content_block_delta',
            delta: { type: 'text_delta', text: 'Second turn' },
          },
        },
      ],
      writeOutput,
    );

    expect(writeOutputMock).toHaveBeenCalledTimes(2);
    // Second emission should include accumulated text from all turns
    expect(writeOutputMock).toHaveBeenNthCalledWith(2, {
      result: 'First turn\n\nSecond turn',
      partial: true,
    });
  });

  it('accumulates text across turns (assistant → message_start → new text)', () => {
    // Realistic SDK event order: assistant (turn complete) → message_start (new turn)
    simulateAgentRunner(
      [
        {
          type: 'stream_event',
          event: {
            type: 'content_block_delta',
            delta: { type: 'text_delta', text: 'Turn 1 text' },
          },
        },
        { type: 'assistant' },
        {
          type: 'stream_event',
          event: { type: 'message_start' },
        },
        {
          type: 'stream_event',
          event: {
            type: 'content_block_delta',
            delta: { type: 'text_delta', text: 'Turn 2 text' },
          },
        },
      ],
      writeOutput,
    );

    expect(writeOutputMock).toHaveBeenCalledTimes(2);
    // Turn 2 should include Turn 1 text — accumulated across turns
    expect(writeOutputMock).toHaveBeenNthCalledWith(2, {
      result: 'Turn 1 text\n\nTurn 2 text',
      partial: true,
    });
  });

  it('strips complete internal tags from accumulated buffer', () => {
    simulateAgentRunner(
      [
        {
          type: 'stream_event',
          event: {
            type: 'content_block_delta',
            delta: {
              type: 'text_delta',
              text: '<internal>thinking</internal>',
            },
          },
        },
        {
          type: 'stream_event',
          event: {
            type: 'content_block_delta',
            delta: { type: 'text_delta', text: 'Answer' },
          },
        },
      ],
      writeOutput,
    );

    // First delta is all internal — stripped, no visible text, no output
    expect(writeOutputMock).toHaveBeenCalledTimes(1);
    expect(writeOutputMock).toHaveBeenCalledWith({
      result: 'Answer',
      partial: true,
    });
  });

  it('ignores non-text deltas', () => {
    simulateAgentRunner(
      [
        {
          type: 'stream_event',
          event: {
            type: 'content_block_delta',
            delta: { type: 'input_json_delta', text: '{"key": "value"}' },
          },
        },
      ],
      writeOutput,
    );

    expect(writeOutputMock).not.toHaveBeenCalled();
  });

  it('resets buffers after result so follow-up query starts clean', () => {
    // Extended simulator that handles result messages and returns buffer state
    type ResultMessage = { type: 'result'; result?: string; subtype?: string };
    type ExtMessage = SDKMessage | ResultMessage;

    function simulateAgentRunnerWithResult(
      messages: ExtMessage[],
      onOutput: (output: { result: string; partial: boolean }) => void,
    ) {
      let streamingTextBuffer = '';
      let completedTurnsText = '';
      let lastFinalText: string | null = null;

      for (const message of messages) {
        if (message.type === 'stream_event') {
          const event = (message as StreamEvent).event;
          if (
            event.type === 'content_block_delta' &&
            event.delta?.type === 'text_delta' &&
            event.delta.text
          ) {
            streamingTextBuffer += event.delta.text;
            const fullText = completedTurnsText
              ? completedTurnsText + '\n\n' + streamingTextBuffer
              : streamingTextBuffer;
            const visible = stripInternalTags(fullText);
            if (visible) {
              onOutput({ result: visible, partial: true });
            }
          }
          if (event.type === 'message_start') {
            streamingTextBuffer = '';
          }
        }

        if (message.type === 'assistant') {
          if (streamingTextBuffer) {
            completedTurnsText = completedTurnsText
              ? completedTurnsText + '\n\n' + streamingTextBuffer
              : streamingTextBuffer;
          }
          streamingTextBuffer = '';
        }

        if (message.type === 'result') {
          const sdkText = (message as ResultMessage).result ?? null;
          const textResult = completedTurnsText || sdkText;
          if (textResult && textResult !== lastFinalText) {
            lastFinalText = textResult;
            onOutput({ result: textResult, partial: false });
          }
          // Reset streaming buffers for next user turn
          completedTurnsText = '';
          streamingTextBuffer = '';
        }
      }
    }

    // First query: stream + result, then second query: stream
    simulateAgentRunnerWithResult(
      [
        // First query
        {
          type: 'stream_event',
          event: {
            type: 'content_block_delta',
            delta: { type: 'text_delta', text: 'First response' },
          },
        },
        { type: 'assistant' },
        { type: 'result', result: 'First response' },
        // Second query (follow-up message piped into same runQuery)
        {
          type: 'stream_event',
          event: {
            type: 'content_block_delta',
            delta: { type: 'text_delta', text: 'Second response' },
          },
        },
      ],
      writeOutput,
    );

    // The second query's partial should NOT include "First response"
    const lastCall =
      writeOutputMock.mock.calls[writeOutputMock.mock.calls.length - 1][0];
    expect(lastCall.result).toBe('Second response');
    expect(lastCall.partial).toBe(true);
  });

  it('resets buffers after duplicate result skip', () => {
    type ResultMessage = { type: 'result'; result?: string; subtype?: string };
    type ExtMessage = SDKMessage | ResultMessage;

    function simulateAgentRunnerWithResult(
      messages: ExtMessage[],
      onOutput: (output: { result: string; partial: boolean }) => void,
    ) {
      let streamingTextBuffer = '';
      let completedTurnsText = '';
      let lastFinalText: string | null = null;

      for (const message of messages) {
        if (message.type === 'stream_event') {
          const event = (message as StreamEvent).event;
          if (
            event.type === 'content_block_delta' &&
            event.delta?.type === 'text_delta' &&
            event.delta.text
          ) {
            streamingTextBuffer += event.delta.text;
            const fullText = completedTurnsText
              ? completedTurnsText + '\n\n' + streamingTextBuffer
              : streamingTextBuffer;
            const visible = stripInternalTags(fullText);
            if (visible) {
              onOutput({ result: visible, partial: true });
            }
          }
          if (event.type === 'message_start') {
            streamingTextBuffer = '';
          }
        }

        if (message.type === 'assistant') {
          if (streamingTextBuffer) {
            completedTurnsText = completedTurnsText
              ? completedTurnsText + '\n\n' + streamingTextBuffer
              : streamingTextBuffer;
          }
          streamingTextBuffer = '';
        }

        if (message.type === 'result') {
          const sdkText = (message as ResultMessage).result ?? null;
          const textResult = completedTurnsText || sdkText;
          if (textResult && textResult !== lastFinalText) {
            lastFinalText = textResult;
            onOutput({ result: textResult, partial: false });
          }
          // Reset streaming buffers even on duplicate skip
          completedTurnsText = '';
          streamingTextBuffer = '';
        }
      }
    }

    // First result, then duplicate result, then new query
    simulateAgentRunnerWithResult(
      [
        {
          type: 'stream_event',
          event: {
            type: 'content_block_delta',
            delta: { type: 'text_delta', text: 'Response A' },
          },
        },
        { type: 'assistant' },
        { type: 'result', result: 'Response A' },
        // Duplicate result (skipped)
        { type: 'result', result: 'Response A' },
        // New query
        {
          type: 'stream_event',
          event: {
            type: 'content_block_delta',
            delta: { type: 'text_delta', text: 'Response B' },
          },
        },
      ],
      writeOutput,
    );

    const lastCall =
      writeOutputMock.mock.calls[writeOutputMock.mock.calls.length - 1][0];
    expect(lastCall.result).toBe('Response B');
    expect(lastCall.partial).toBe(true);
  });

  it('does not split on double newline — preserves \\n\\n in partial', () => {
    simulateAgentRunner(
      [
        {
          type: 'stream_event',
          event: {
            type: 'content_block_delta',
            delta: { type: 'text_delta', text: 'Part 1\n\nPart 2' },
          },
        },
      ],
      writeOutput,
    );

    // Single partial containing both paragraphs — no split
    expect(writeOutputMock).toHaveBeenCalledTimes(1);
    expect(writeOutputMock).toHaveBeenCalledWith({
      result: 'Part 1\n\nPart 2',
      partial: true,
    });
  });

  it('accumulates multiple \\n\\n without splitting', () => {
    simulateAgentRunner(
      [
        {
          type: 'stream_event',
          event: {
            type: 'content_block_delta',
            delta: { type: 'text_delta', text: 'Part 1\n\nPart 2' },
          },
        },
        {
          type: 'stream_event',
          event: {
            type: 'content_block_delta',
            delta: { type: 'text_delta', text: '\n\nPart 3' },
          },
        },
      ],
      writeOutput,
    );

    expect(writeOutputMock).toHaveBeenCalledTimes(2);
    expect(writeOutputMock).toHaveBeenNthCalledWith(1, {
      result: 'Part 1\n\nPart 2',
      partial: true,
    });
    expect(writeOutputMock).toHaveBeenNthCalledWith(2, {
      result: 'Part 1\n\nPart 2\n\nPart 3',
      partial: true,
    });
  });

  it('multi-turn accumulates with \\n\\n separator', () => {
    simulateAgentRunner(
      [
        {
          type: 'stream_event',
          event: {
            type: 'content_block_delta',
            delta: { type: 'text_delta', text: 'Turn 1' },
          },
        },
        { type: 'assistant' },
        {
          type: 'stream_event',
          event: {
            type: 'content_block_delta',
            delta: { type: 'text_delta', text: 'Turn 2' },
          },
        },
      ],
      writeOutput,
    );

    expect(writeOutputMock).toHaveBeenCalledTimes(2);
    expect(writeOutputMock).toHaveBeenNthCalledWith(1, {
      result: 'Turn 1',
      partial: true,
    });
    expect(writeOutputMock).toHaveBeenNthCalledWith(2, {
      result: 'Turn 1\n\nTurn 2',
      partial: true,
    });
  });

  it('text with \\n\\n streams through to result without early exit (return bug regression)', () => {
    // Regression test: the old split logic had a `return` instead of `continue`
    // inside the for-await loop, which caused runQuery() to exit early and
    // return undefined when encountering \n\n in a text delta.
    type ResultMessage = {
      type: 'result';
      result?: string;
      usage?: { input_tokens: number; output_tokens: number };
      num_turns?: number;
    };
    type ExtMessage = SDKMessage | ResultMessage;

    interface ExtOutput {
      result: string | null;
      partial: boolean;
      usage?: { inputTokens: number; outputTokens: number; numTurns: number };
    }

    function simulateFullPipeline(
      messages: ExtMessage[],
      onOutput: (output: ExtOutput) => void,
    ): { completed: boolean } {
      let streamingTextBuffer = '';
      let completedTurnsText = '';
      let lastFinalText: string | null = null;
      let completed = false;

      for (const message of messages) {
        if (message.type === 'stream_event') {
          const event = (message as StreamEvent).event;
          if (
            event.type === 'content_block_delta' &&
            event.delta?.type === 'text_delta' &&
            event.delta.text
          ) {
            streamingTextBuffer += event.delta.text;
            const fullText = completedTurnsText
              ? completedTurnsText + '\n\n' + streamingTextBuffer
              : streamingTextBuffer;
            const visible = stripInternalTags(fullText);
            if (visible) {
              onOutput({ result: visible, partial: true });
            }
          }
          if (event.type === 'message_start') {
            streamingTextBuffer = '';
          }
        }

        if (message.type === 'assistant') {
          if (streamingTextBuffer) {
            completedTurnsText = completedTurnsText
              ? completedTurnsText + '\n\n' + streamingTextBuffer
              : streamingTextBuffer;
          }
          streamingTextBuffer = '';
        }

        if (message.type === 'result') {
          const rm = message as ResultMessage;
          const sdkText = rm.result ?? null;
          const textResult = completedTurnsText || sdkText;
          const usage = rm.usage
            ? {
                inputTokens: rm.usage.input_tokens,
                outputTokens: rm.usage.output_tokens,
                numTurns: rm.num_turns ?? 0,
              }
            : undefined;
          if (textResult && textResult !== lastFinalText) {
            lastFinalText = textResult;
            onOutput({ result: textResult, partial: false, usage });
          } else if (!textResult) {
            onOutput({ result: null, partial: false, usage });
          }
          completedTurnsText = '';
          streamingTextBuffer = '';
          completed = true;
        }
      }

      return { completed };
    }

    const outputs: ExtOutput[] = [];
    const { completed } = simulateFullPipeline(
      [
        {
          type: 'stream_event',
          event: {
            type: 'content_block_delta',
            delta: { type: 'text_delta', text: 'Part 1\n\nPart 2' },
          },
        },
        { type: 'assistant' },
        {
          type: 'result',
          result: 'Part 1\n\nPart 2',
          usage: { input_tokens: 100, output_tokens: 50 },
          num_turns: 1,
        },
      ],
      (o) => outputs.push(o),
    );

    // Must complete — old code returned undefined here
    expect(completed).toBe(true);
    // Partial with full text (no split)
    expect(outputs[0]).toEqual({
      result: 'Part 1\n\nPart 2',
      partial: true,
    });
    // Final result
    expect(outputs[1]).toEqual({
      result: 'Part 1\n\nPart 2',
      partial: false,
      usage: { inputTokens: 100, outputTokens: 50, numTurns: 1 },
    });
  });

  it('null result emits output with result: null', () => {
    type ResultMessage = { type: 'result'; result?: string };
    type ExtMessage = SDKMessage | ResultMessage;

    function simulateWithResult(
      messages: ExtMessage[],
      onOutput: (output: { result: string | null; partial: boolean }) => void,
    ) {
      let streamingTextBuffer = '';
      let completedTurnsText = '';
      let lastFinalText: string | null = null;

      for (const message of messages) {
        if (message.type === 'stream_event') {
          const event = (message as StreamEvent).event;
          if (
            event.type === 'content_block_delta' &&
            event.delta?.type === 'text_delta' &&
            event.delta.text
          ) {
            streamingTextBuffer += event.delta.text;
            const fullText = completedTurnsText
              ? completedTurnsText + '\n\n' + streamingTextBuffer
              : streamingTextBuffer;
            const visible = stripInternalTags(fullText);
            if (visible) {
              onOutput({ result: visible, partial: true });
            }
          }
          if (event.type === 'message_start') {
            streamingTextBuffer = '';
          }
        }
        if (message.type === 'assistant') {
          if (streamingTextBuffer) {
            completedTurnsText = completedTurnsText
              ? completedTurnsText + '\n\n' + streamingTextBuffer
              : streamingTextBuffer;
          }
          streamingTextBuffer = '';
        }
        if (message.type === 'result') {
          const sdkText = (message as ResultMessage).result ?? null;
          const textResult = completedTurnsText || sdkText;
          if (textResult && textResult !== lastFinalText) {
            lastFinalText = textResult;
            onOutput({ result: textResult, partial: false });
          } else if (!textResult) {
            onOutput({ result: null, partial: false });
          }
          completedTurnsText = '';
          streamingTextBuffer = '';
        }
      }
    }

    const outputs: Array<{ result: string | null; partial: boolean }> = [];
    simulateWithResult(
      [{ type: 'result' }], // no result field → null
      (o) => outputs.push(o),
    );

    expect(outputs).toHaveLength(1);
    expect(outputs[0]).toEqual({ result: null, partial: false });
  });

  it('empty text delta produces no output', () => {
    simulateAgentRunner(
      [
        {
          type: 'stream_event',
          event: {
            type: 'content_block_delta',
            delta: { type: 'text_delta', text: '' },
          },
        },
      ],
      writeOutput,
    );

    expect(writeOutputMock).not.toHaveBeenCalled();
  });
});

/**
 * Integration tests: StreamEditLoop used in the same pattern as index.ts.
 * These verify that the new buffered approach preserves the critical
 * behavioral contracts documented by the tests above.
 */
describe('streaming output with StreamEditLoop', () => {
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
   * Simulates the index.ts integration pattern:
   * - Creates a StreamEditLoop with a sendOrEdit callback that calls
   *   sendStreamMessage (first) or editMessage (subsequent).
   * - Processes results: partials call loop.update(), finals call loop.flush().
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

      // Final result — flush streaming, then deliver
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

      // Reset for next query
      loop.resetForNextQuery();
      streamMessageId = null;
      streamingFailed = false;
      lastSentText = null;
    }

    loop.stop();
    return { outputSentToUser };
  }

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

    // First chunk triggers sendStreamMessage
    expect(channel.sendStreamMessage).toHaveBeenCalledTimes(1);
    expect(channel.sendStreamMessage).toHaveBeenCalledWith('jid', 'Hello');
    // Buffered updates coalesce — 'Hello wor' is the latest before throttle fires
    // Then 'Hello world' at +600ms, and final edit with 'Hello world!'
    expect(channel.editMessage).toHaveBeenCalled();
    // Final text should be delivered
    const lastEditCall =
      channel.editMessage.mock.calls[channel.editMessage.mock.calls.length - 1];
    expect(lastEditCall[2]).toBe('Hello world!');
  });

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
    // Final uses sendMessage because streamingFailed
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

    // sendStreamMessage attempted but sendOrEdit throws → streamingFailed
    // Final uses sendMessage
    expect(channel.sendMessage).toHaveBeenCalledWith(
      'jid',
      'Complete response',
    );
    expect(outputSentToUser).toBe(true);
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

  it('resets state between IPC queries', async () => {
    const channel = makeChannel();

    await simulateWithLoop(
      [
        // First query
        { result: 'First answer', partial: true },
        { result: 'First answer', partial: false, delay: 600 },
        // Second query
        { result: 'Second answer', partial: true, delay: 100 },
        { result: 'Second answer', partial: false, delay: 600 },
      ],
      channel,
    );

    // Each query creates its own streaming message
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
    // Text already sent via sendStreamMessage — no extra edit or send
    expect(channel.editMessage).not.toHaveBeenCalled();
    expect(channel.sendMessage).not.toHaveBeenCalled();
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
