import { describe, it, expect, vi } from 'vitest';

/**
 * Tests for duplicate output suppression in the host-side onOutput callback.
 *
 * processGroupMessages is a non-exported function with heavy dependencies,
 * so we test the dedup pattern in isolation — the same logic used in
 * src/index.ts to prevent duplicate sendMessage calls.
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
      if (result.result && !result.partial) {
        const raw =
          typeof result.result === 'string'
            ? result.result
            : JSON.stringify(result.result);
        const text = raw.replace(/<internal>[\s\S]*?<\/internal>/g, '').trim();
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
      [
        { result: 'First response' },
        { result: 'Second response' },
      ],
      sendMessage,
    );

    expect(sendMessage).toHaveBeenCalledTimes(2);
    expect(sendMessage).toHaveBeenCalledWith('First response');
    expect(sendMessage).toHaveBeenCalledWith('Second response');
  });

  it('skips partial chunks', () => {
    const sendMessage = vi.fn(async () => {});

    simulateOnOutput(
      [
        { result: 'streaming...', partial: true },
        { result: 'Final answer' },
      ],
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
