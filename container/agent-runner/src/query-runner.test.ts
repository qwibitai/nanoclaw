import { describe, expect, it } from 'vitest';

import type { ContainerOutput, QueryRunnerMessage } from './query-runner.js';
import { PromptQueue, runQueryRunner } from './query-runner.js';
import {
  NO_REPLY_RECOVERY_PROMPT,
  QUERY_EXIT_ERROR,
  RECOVERY_EXHAUSTED_ERROR,
} from './query-loop.js';

async function* createMessageStream(
  promptQueue: PromptQueue,
  steps: Array<
    (
      prompt: string,
    ) => Promise<QueryRunnerMessage[]> | QueryRunnerMessage[]
  >,
): AsyncGenerator<QueryRunnerMessage> {
  const iterator = promptQueue[Symbol.asyncIterator]();

  for (const step of steps) {
    const next = await iterator.next();
    expect(next.done).toBe(false);

    const messages = await step(next.value.message.content);
    for (const message of messages) {
      yield message;
    }
  }
}

function createHarness(options?: {
  initialPrompt?: string;
  followUps?: string[];
  isScheduledTask?: boolean;
}) {
  const promptQueue = new PromptQueue(options?.initialPrompt ?? 'user prompt');
  for (const prompt of options?.followUps ?? []) {
    promptQueue.enqueuePrompt(prompt);
  }

  const outputs: ContainerOutput[] = [];
  const dispatchedPrompts: string[] = [];
  let sendMessageCount = 0;

  return {
    promptQueue,
    outputs,
    dispatchedPrompts,
    recordSendMessage(text = 'sent'): void {
      if (text.trim()) {
        sendMessageCount += 1;
      }
    },
    run(
      messages: AsyncIterable<QueryRunnerMessage>,
      closedDuringQuery = false,
    ) {
      return runQueryRunner({
        promptQueue,
        messages,
        isScheduledTask: options?.isScheduledTask ?? false,
        closedDuringQuery,
        consumeSendMessageCount: () => {
          const current = sendMessageCount;
          sendMessageCount = 0;
          return current;
        },
        onPromptDispatched: (prompt) => {
          dispatchedPrompts.push(prompt);
        },
        writeOutput: async (output) => {
          outputs.push(output);
        },
      });
    },
  };
}

describe('runQueryRunner', () => {
  it('throws the query-exit error when a conversational round emits assistant activity but no final result or send_message delivery', async () => {
    const harness = createHarness();

    await expect(
      harness.run(
        createMessageStream(harness.promptQueue, [
          async (prompt) => {
            expect(prompt).toBe('user prompt');
            return [{ type: 'assistant', uuid: 'assistant-1' }];
          },
        ]),
      ),
    ).rejects.toThrow(QUERY_EXIT_ERROR);

    expect(harness.outputs).toEqual([]);
    expect(harness.dispatchedPrompts).toEqual(['user prompt']);
  });

  it('throws the query-exit error when close-sentinel shutdown ends an unresolved conversational round', async () => {
    const harness = createHarness();

    await expect(
      harness.run(
        createMessageStream(harness.promptQueue, [
          async (prompt) => {
            expect(prompt).toBe('user prompt');
            return [{ type: 'assistant', uuid: 'assistant-1' }];
          },
        ]),
        true,
      ),
    ).rejects.toThrow(QUERY_EXIT_ERROR);

    expect(harness.outputs).toEqual([]);
    expect(harness.dispatchedPrompts).toEqual(['user prompt']);
  });

  it('inserts NO_REPLY_RECOVERY_PROMPT ahead of already-buffered follow-up prompts after the first silent success result', async () => {
    const harness = createHarness({ followUps: ['follow-up prompt'] });

    await harness.run(
      createMessageStream(harness.promptQueue, [
        async (prompt) => {
          expect(prompt).toBe('user prompt');
          return [{ type: 'result', subtype: 'success', result: '' }];
        },
        async (prompt) => {
          expect(prompt).toBe(NO_REPLY_RECOVERY_PROMPT);
          return [
            {
              type: 'result',
              subtype: 'success',
              result: 'Recovered reply',
            },
          ];
        },
        async (prompt) => {
          expect(prompt).toBe('follow-up prompt');
          return [
            {
              type: 'result',
              subtype: 'success',
              result: 'Follow-up reply',
            },
          ];
        },
      ]),
    );

    expect(harness.dispatchedPrompts).toEqual([
      'user prompt',
      NO_REPLY_RECOVERY_PROMPT,
      'follow-up prompt',
    ]);
  });

  it('writes the recovered visible result, then leaves the buffered follow-up prompt queued until it is actually dispatched', async () => {
    const harness = createHarness({ followUps: ['follow-up prompt'] });

    await harness.run(
      createMessageStream(harness.promptQueue, [
        async (prompt) => {
          expect(prompt).toBe('user prompt');
          return [
            { type: 'system', subtype: 'init', session_id: 'session-123' },
            { type: 'result', subtype: 'success', result: '   ' },
          ];
        },
        async (prompt) => {
          expect(prompt).toBe(NO_REPLY_RECOVERY_PROMPT);
          return [
            {
              type: 'result',
              subtype: 'success',
              result: 'Recovered reply',
            },
          ];
        },
        async (prompt) => {
          expect(prompt).toBe('follow-up prompt');
          return [
            {
              type: 'result',
              subtype: 'success',
              result: 'Follow-up reply',
            },
          ];
        },
      ]),
    );

    expect(harness.outputs).toEqual([
      {
        status: 'success',
        result: 'Recovered reply',
        newSessionId: 'session-123',
      },
      {
        status: 'success',
        result: 'Follow-up reply',
        newSessionId: 'session-123',
      },
    ]);
    expect(harness.dispatchedPrompts).toEqual([
      'user prompt',
      NO_REPLY_RECOVERY_PROMPT,
      'follow-up prompt',
    ]);
  });

  it('treats a second silent success result as the explicit recovery-exhausted error', async () => {
    const harness = createHarness();

    await expect(
      harness.run(
        createMessageStream(harness.promptQueue, [
          async (prompt) => {
            expect(prompt).toBe('user prompt');
            return [{ type: 'result', subtype: 'success', result: '' }];
          },
          async (prompt) => {
            expect(prompt).toBe(NO_REPLY_RECOVERY_PROMPT);
            return [
              {
                type: 'result',
                subtype: 'success',
                result: '<internal>still hidden</internal>',
              },
            ];
          },
        ]),
      ),
    ).rejects.toThrow(RECOVERY_EXHAUSTED_ERROR);

    expect(harness.outputs).toEqual([]);
  });

  it('treats a send_message-only conversational round as delivered when query exits cleanly', async () => {
    const harness = createHarness();

    await expect(
      harness.run(
        createMessageStream(harness.promptQueue, [
          async (prompt) => {
            expect(prompt).toBe('user prompt');
            harness.recordSendMessage();
            return [{ type: 'assistant', uuid: 'assistant-1' }];
          },
        ]),
      ),
    ).resolves.toEqual({
      closedDuringQuery: false,
      lastAssistantUuid: 'assistant-1',
      newSessionId: undefined,
    });

    expect(harness.outputs).toEqual([]);
  });

  it('does not trigger recovery for a round that already emitted visible result output', async () => {
    const harness = createHarness();

    await harness.run(
      createMessageStream(harness.promptQueue, [
        async (prompt) => {
          expect(prompt).toBe('user prompt');
          return [
            {
              type: 'result',
              subtype: 'success',
              result: 'Visible reply',
            },
            { type: 'result', subtype: 'success', result: '' },
          ];
        },
      ]),
    );

    expect(harness.outputs).toEqual([
      {
        status: 'success',
        result: 'Visible reply',
        newSessionId: undefined,
      },
    ]);
    expect(harness.dispatchedPrompts).toEqual(['user prompt']);
  });

  it('surfaces SDK result/error_* immediately without emitting success', async () => {
    const harness = createHarness();

    await expect(
      harness.run(
        createMessageStream(harness.promptQueue, [
          async (prompt) => {
            expect(prompt).toBe('user prompt');
            return [
              {
                type: 'result',
                subtype: 'error_during_execution',
                result: 'sdk failed',
              },
            ];
          },
        ]),
      ),
    ).rejects.toThrow('Claude query returned error_during_execution: sdk failed');

    expect(harness.outputs).toEqual([]);
  });

  it('allows scheduled-task silent success and silent exit without emitted errors', async () => {
    const harness = createHarness({ isScheduledTask: true });

    await expect(
      harness.run(
        createMessageStream(harness.promptQueue, [
          async (prompt) => {
            expect(prompt).toBe('user prompt');
            return [{ type: 'result', subtype: 'success', result: null }];
          },
        ]),
      ),
    ).resolves.toEqual({
      closedDuringQuery: false,
      lastAssistantUuid: undefined,
      newSessionId: undefined,
    });

    expect(harness.outputs).toEqual([]);
  });
});
