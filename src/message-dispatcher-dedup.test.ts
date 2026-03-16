import { describe, it, expect } from 'vitest';
import { createHash } from 'crypto';

/**
 * Tests for the SDK result event deduplication logic used in message-dispatcher.ts.
 *
 * The deduplication guard uses a per-invocation Set<string> of SHA-256 content
 * hashes to prevent dispatching duplicate result events from the Claude Agent SDK.
 */

function hashText(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

/**
 * Simulates the deduplication callback logic from processGroupMessages.
 * Returns an array of texts that would actually be sent to the user.
 */
function simulateResultDispatching(
  results: Array<{ status: string; result: string | null }>,
): string[] {
  const seenResultHashes = new Set<string>();
  const sent: string[] = [];

  for (const result of results) {
    if (result.result) {
      const raw =
        typeof result.result === 'string'
          ? result.result
          : JSON.stringify(result.result);
      const text = raw.replace(/<internal>[\s\S]*?<\/internal>/g, '').trim();
      if (text) {
        const hash = createHash('sha256').update(text).digest('hex');
        if (!seenResultHashes.has(hash)) {
          seenResultHashes.add(hash);
          sent.push(text);
        }
      }
    }
  }

  return sent;
}

describe('SDK result event deduplication', () => {
  it('dispatches a single result normally', () => {
    const sent = simulateResultDispatching([
      { status: 'success', result: 'Hello, world!' },
    ]);
    expect(sent).toEqual(['Hello, world!']);
  });

  it('deduplicates identical result events', () => {
    const sent = simulateResultDispatching([
      { status: 'success', result: 'Hello, world!' },
      { status: 'success', result: 'Hello, world!' },
    ]);
    expect(sent).toEqual(['Hello, world!']);
  });

  it('deduplicates triple identical result events', () => {
    const sent = simulateResultDispatching([
      { status: 'success', result: 'Same text' },
      { status: 'success', result: 'Same text' },
      { status: 'success', result: 'Same text' },
    ]);
    expect(sent).toEqual(['Same text']);
  });

  it('allows distinct results through', () => {
    const sent = simulateResultDispatching([
      { status: 'success', result: 'First response' },
      { status: 'success', result: 'Second response' },
    ]);
    expect(sent).toEqual(['First response', 'Second response']);
  });

  it('deduplicates only identical results in a mixed stream', () => {
    const sent = simulateResultDispatching([
      { status: 'success', result: 'A' },
      { status: 'success', result: 'B' },
      { status: 'success', result: 'A' },
      { status: 'success', result: 'C' },
      { status: 'success', result: 'B' },
    ]);
    expect(sent).toEqual(['A', 'B', 'C']);
  });

  it('skips null results without error', () => {
    const sent = simulateResultDispatching([
      { status: 'success', result: null },
      { status: 'success', result: 'Hello' },
      { status: 'success', result: null },
    ]);
    expect(sent).toEqual(['Hello']);
  });

  it('skips empty-after-stripping results', () => {
    const sent = simulateResultDispatching([
      { status: 'success', result: '<internal>thinking</internal>' },
      { status: 'success', result: 'Actual answer' },
    ]);
    expect(sent).toEqual(['Actual answer']);
  });

  it('deduplicates after stripping internal blocks', () => {
    const sent = simulateResultDispatching([
      {
        status: 'success',
        result: '<internal>thought 1</internal>Hello',
      },
      {
        status: 'success',
        result: '<internal>thought 2</internal>Hello',
      },
    ]);
    // Both results have the same visible text "Hello" after stripping
    expect(sent).toEqual(['Hello']);
  });

  it('produces consistent hashes for identical content', () => {
    const h1 = hashText('test content');
    const h2 = hashText('test content');
    expect(h1).toBe(h2);
  });

  it('produces different hashes for different content', () => {
    const h1 = hashText('content A');
    const h2 = hashText('content B');
    expect(h1).not.toBe(h2);
  });

  it('is idempotent on retry — fresh Set per invocation', () => {
    // First invocation
    const sent1 = simulateResultDispatching([
      { status: 'success', result: 'Hello' },
    ]);
    // Second invocation (retry) — same content should be sent again
    // because each invocation gets a fresh Set
    const sent2 = simulateResultDispatching([
      { status: 'success', result: 'Hello' },
    ]);
    expect(sent1).toEqual(['Hello']);
    expect(sent2).toEqual(['Hello']);
  });
});
