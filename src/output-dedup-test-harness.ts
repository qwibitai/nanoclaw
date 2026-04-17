import { vi } from 'vitest';

import { stripInternalTags } from './router.js';

export const EDIT_THROTTLE_MS = 1000;

export interface StreamChannel {
  sendStreamMessage: (jid: string, text: string) => number | null;
  editMessage: (jid: string, messageId: number, text: string) => void;
  sendMessage: (jid: string, text: string) => void;
}

/**
 * Replicates the streaming logic from the pre-loop processGroupMessages
 * onOutput callback: forwards partials to sendStreamMessage/editMessage
 * (throttled) and finals to editMessage or sendMessage.
 */
export function simulateStreamingOutput(
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
    streamMessageId = null;
    lastEditTime = 0;
    streamingFailed = false;
    lastSentText = null;
  }

  return { outputSentToUser };
}

export function makeStreamChannel(
  overrides?: Partial<StreamChannel>,
): StreamChannel {
  return {
    sendStreamMessage: vi.fn(() => 42),
    editMessage: vi.fn(() => {}),
    sendMessage: vi.fn(() => {}),
    ...overrides,
  };
}

// ─── agent-runner event types (shared by buffer tests) ────────────

export type StreamEvent = {
  type: string;
  event: {
    type: string;
    delta?: { type?: string; text?: string };
  };
};

export type AssistantMessage = {
  type: 'assistant';
  message?: { content?: Array<{ type: string; text?: string }> };
};

export type SDKMessage = StreamEvent | AssistantMessage | { type: string };

/**
 * Replicates the stream_event + assistant message processing logic
 * from the agent-runner's runQuery function (no result handling).
 */
export function simulateAgentRunner(
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

type ResultMessage = { type: 'result'; result?: string; subtype?: string };
export type ExtMessage = SDKMessage | ResultMessage;

/**
 * Same as simulateAgentRunner but also handles `result` messages:
 * emits a final (partial=false) output and resets the accumulation buffers.
 * De-duplicates identical back-to-back results.
 */
export function simulateAgentRunnerWithResult(
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
      } else if (!textResult) {
        onOutput({
          result: null as unknown as string,
          partial: false,
        });
      }
      completedTurnsText = '';
      streamingTextBuffer = '';
    }
  }
}
