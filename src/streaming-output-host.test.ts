import { describe, expect, it, vi } from 'vitest';

import {
  makeStreamChannel,
  simulateStreamingOutput,
} from './output-dedup-test-harness.js';

describe('streaming output — basic throttle + fallback', () => {
  it('uses partial text directly (agent-runner accumulates)', () => {
    const channel = makeStreamChannel();

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
    const channel = makeStreamChannel();

    simulateStreamingOutput(
      [
        { result: 'Hello', partial: true, time: 0 },
        { result: 'Hello w', partial: true, time: 300 },
        { result: 'Hello wor', partial: true, time: 700 },
        { result: 'Hello world', partial: true, time: 1500 },
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
    const channel = makeStreamChannel({
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
    const channel = makeStreamChannel();

    const { outputSentToUser } = simulateStreamingOutput(
      [
        { result: 'Complete text', partial: true, time: 0 },
        { result: 'Complete text', partial: false, time: 2000 },
      ],
      channel,
    );

    expect(outputSentToUser).toBe(true);
    expect(channel.editMessage).not.toHaveBeenCalled();
    expect(channel.sendMessage).not.toHaveBeenCalled();
  });

  it('stops streaming when text exceeds 4000 chars', () => {
    const channel = makeStreamChannel();
    const longText = 'x'.repeat(4001);

    const { outputSentToUser } = simulateStreamingOutput(
      [
        { result: 'Short', partial: true, time: 0 },
        { result: longText, partial: true, time: 2000 },
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
    const channel = makeStreamChannel();

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

  it('reduced throttle (1000ms) allows edits that 1500ms would have blocked', () => {
    const channel = makeStreamChannel();

    simulateStreamingOutput(
      [
        { result: 'First chunk', partial: true, time: 0 },
        { result: 'Second chunk', partial: true, time: 1200 },
        { result: 'Final', partial: false, time: 3000 },
      ],
      channel,
    );

    expect(channel.sendStreamMessage).toHaveBeenCalledTimes(1);
    expect(channel.editMessage).toHaveBeenCalledTimes(2);
  });
});

describe('streaming output — multi-query reset + final delivery', () => {
  it('resets streaming state between IPC queries (consecutive finals)', () => {
    const channel = makeStreamChannel();

    simulateStreamingOutput(
      [
        { result: 'First answer', partial: true, time: 0 },
        { result: 'First answer', partial: false, time: 1000 },
        { result: 'Second answer', partial: true, time: 5000 },
        { result: 'Second answer', partial: false, time: 6000 },
      ],
      channel,
    );

    expect(channel.sendStreamMessage).toHaveBeenCalledTimes(2);
    expect(channel.editMessage).not.toHaveBeenCalled();
    expect(channel.sendMessage).not.toHaveBeenCalled();
  });

  it('creates new streaming message for each IPC query', () => {
    const channel = makeStreamChannel();

    simulateStreamingOutput(
      [
        { result: 'First response', partial: true, time: 0 },
        { result: 'First response', partial: false, time: 1000 },
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
    const channel = makeStreamChannel();

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

  it('no-ops when final has no text and streaming was active', () => {
    const channel = makeStreamChannel();

    const { outputSentToUser } = simulateStreamingOutput(
      [
        { result: 'Streamed text', partial: true, time: 0 },
        { result: '<internal>done</internal>', partial: false, time: 2000 },
      ],
      channel,
    );

    expect(channel.sendStreamMessage).toHaveBeenCalledTimes(1);
    expect(outputSentToUser).toBe(true);
    expect(channel.editMessage).not.toHaveBeenCalled();
    expect(channel.sendMessage).not.toHaveBeenCalled();
  });
});

describe('streaming output — failure fallbacks', () => {
  it('falls back to sendMessage when editMessage fails during partial', () => {
    let editCallCount = 0;
    const channel = makeStreamChannel({
      editMessage: vi.fn(() => {
        editCallCount++;
        if (editCallCount === 1) throw new Error('Telegram edit failed');
      }),
    });

    const { outputSentToUser } = simulateStreamingOutput(
      [
        { result: 'First chunk', partial: true, time: 0 },
        { result: 'Second chunk', partial: true, time: 2000 },
        { result: 'Third chunk', partial: true, time: 4000 },
        { result: 'Complete response', partial: false, time: 6000 },
      ],
      channel,
    );

    expect(channel.sendStreamMessage).toHaveBeenCalledTimes(1);
    expect(channel.editMessage).toHaveBeenCalledTimes(1);
    expect(channel.sendMessage).toHaveBeenCalledWith(
      'jid',
      'Complete response',
    );
    expect(outputSentToUser).toBe(true);
  });

  it('switches to sendMessage when pending messages arrive during partial streaming', () => {
    const channel = makeStreamChannel();

    const { outputSentToUser } = simulateStreamingOutput(
      [
        { result: 'First chunk', partial: true, time: 0 },
        { result: 'Second chunk', partial: true, time: 2000 },
        { result: 'Third chunk', partial: true, time: 4000 },
        { result: 'Complete response', partial: false, time: 6000 },
      ],
      channel,
      { hasPendingMessages: true },
    );

    expect(channel.sendStreamMessage).toHaveBeenCalledTimes(1);
    expect(channel.editMessage).not.toHaveBeenCalled();
    expect(channel.sendMessage).toHaveBeenCalledWith(
      'jid',
      'Complete response',
    );
    expect(outputSentToUser).toBe(true);
  });

  it('final result uses sendMessage when pending messages exist even if streaming succeeded', () => {
    const channel = makeStreamChannel();

    const { outputSentToUser } = simulateStreamingOutput(
      [
        { result: 'Streamed text', partial: true, time: 0 },
        { result: 'Final text', partial: false, time: 2000 },
      ],
      channel,
      { hasPendingMessages: true },
    );

    expect(channel.sendStreamMessage).toHaveBeenCalledTimes(1);
    expect(channel.sendMessage).toHaveBeenCalledWith('jid', 'Final text');
    expect(channel.editMessage).not.toHaveBeenCalled();
    expect(outputSentToUser).toBe(true);
  });
});
