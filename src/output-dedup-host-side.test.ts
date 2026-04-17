import { describe, expect, it, vi } from 'vitest';

import { stripInternalTags } from './router.js';

/**
 * Replicates the exact dedup logic from processGroupMessages onOutput
 * callback. When the agent emits multiple result chunks with the same
 * text, only the first should trigger sendMessage.
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
      if (result.partial) continue;
      if (text && text !== lastSentText) {
        sendMessage(text);
        lastSentText = text;
      }
    }
  }
}

describe('host-side output dedup', () => {
  it('suppresses duplicate result text', () => {
    const sendMessage = vi.fn(async () => {});
    simulateOnOutput(
      [{ result: 'Hello world' }, { result: 'Hello world' }],
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
      [{ result: 'Response text' }, { result: null }],
      sendMessage,
    );
    expect(sendMessage).toHaveBeenCalledTimes(1);
  });

  it('strips internal tags before dedup comparison', () => {
    const sendMessage = vi.fn(async () => {});
    simulateOnOutput(
      [
        { result: '<internal>thinking</internal>Hello' },
        { result: 'Hello' },
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
        { result: '<internal>reason B</internal>Answer' },
      ],
      sendMessage,
    );
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenCalledWith('Answer');
  });
});
