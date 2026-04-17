import { beforeEach, describe, expect, it, vi } from 'vitest';

import { simulateAgentRunner } from './output-dedup-test-harness.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let writeOutputMock: any;
const writeOutput = (output: { result: string; partial: boolean }) =>
  writeOutputMock(output);

beforeEach(() => {
  writeOutputMock = vi.fn();
});

describe('agent-runner streaming buffer — accumulation', () => {
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
    expect(writeOutputMock).toHaveBeenNthCalledWith(2, {
      result: 'First turn\n\nSecond turn',
      partial: true,
    });
  });

  it('accumulates text across turns (assistant → message_start → new text)', () => {
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

describe('agent-runner streaming buffer — newline handling', () => {
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
});
