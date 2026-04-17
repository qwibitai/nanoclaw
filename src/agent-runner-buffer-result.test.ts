import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  simulateAgentRunnerWithResult,
  type StreamEvent,
  type SDKMessage,
} from './output-dedup-test-harness.js';
import { stripInternalTags } from './router.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let writeOutputMock: any;
const writeOutput = (output: { result: string; partial: boolean }) =>
  writeOutputMock(output);

beforeEach(() => {
  writeOutputMock = vi.fn();
});

describe('agent-runner streaming buffer — result + buffer reset', () => {
  it('resets buffers after result so follow-up query starts clean', () => {
    simulateAgentRunnerWithResult(
      [
        {
          type: 'stream_event',
          event: {
            type: 'content_block_delta',
            delta: { type: 'text_delta', text: 'First response' },
          },
        },
        { type: 'assistant' },
        { type: 'result', result: 'First response' },
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

    const lastCall =
      writeOutputMock.mock.calls[writeOutputMock.mock.calls.length - 1][0];
    expect(lastCall.result).toBe('Second response');
    expect(lastCall.partial).toBe(true);
  });

  it('resets buffers after duplicate result skip', () => {
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
        { type: 'result', result: 'Response A' },
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

  it('null result emits output with result: null', () => {
    const outputs: Array<{ result: string | null; partial: boolean }> = [];
    simulateAgentRunnerWithResult([{ type: 'result' }], (o) =>
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      outputs.push(o as any),
    );

    expect(outputs).toHaveLength(1);
    expect(outputs[0]).toEqual({ result: null, partial: false });
  });
});

// Regression: the old split logic had a `return` instead of `continue`
// inside the runQuery for-await loop, which caused the query to exit
// early and return undefined on `\n\n` in a text delta. Full pipeline
// inlined here because it also exercises usage-bookkeeping.
describe('agent-runner streaming buffer — full pipeline regression', () => {
  it('text with \\n\\n streams through to result without early exit', () => {
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
            if (visible) onOutput({ result: visible, partial: true });
          }
          if (event.type === 'message_start') streamingTextBuffer = '';
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

    expect(completed).toBe(true);
    expect(outputs[0]).toEqual({
      result: 'Part 1\n\nPart 2',
      partial: true,
    });
    expect(outputs[1]).toEqual({
      result: 'Part 1\n\nPart 2',
      partial: false,
      usage: { inputTokens: 100, outputTokens: 50, numTurns: 1 },
    });
  });
});
