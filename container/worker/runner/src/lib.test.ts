import { describe, expect, it } from 'vitest';

import {
  buildModelCandidates,
  extractResult,
  getOpencodeErrorMessage,
  isModelNotFound,
  parseEventLines,
  parseMaybeJson,
} from './lib.js';

describe('worker runner lib', () => {
  it('builds de-duplicated model candidates with fallbacks', () => {
    const models = buildModelCandidates(
      'opencode/minimax-m2.5-free',
      'opencode/minimax-m2.5-free',
    );
    expect(models[0]).toBe('opencode/minimax-m2.5-free');
    expect(new Set(models).size).toBe(models.length);
    expect(models).toContain('opencode/big-pickle');
  });

  it('parses json events from plain and data-prefixed lines', () => {
    const stdout = [
      'data: {"type":"text","text":"hello"}',
      '{"type":"text","text":"world"}',
      'not-json',
    ].join('\n');

    const events = parseEventLines(stdout);
    expect(events).toHaveLength(2);
    expect(events[0].text).toBe('hello');
    expect(events[1].text).toBe('world');
  });

  it('extracts result text from event stream first', () => {
    const events = [
      { type: 'text', text: 'line one' },
      { type: 'text', text: 'line two' },
    ];
    const result = extractResult('', { message: 'fallback' }, events);
    expect(result).toBe('line one\nline two');
  });

  it('falls back to payload text when there are no text events', () => {
    const result = extractResult('', { message: 'payload result' }, []);
    expect(result).toBe('payload result');
  });

  it('returns opencode error from events and payload', () => {
    const eventErr = getOpencodeErrorMessage(
      [{ type: 'error', message: 'event-error' }],
      { message: 'payload-error' },
    );
    expect(eventErr).toBe('event-error');

    const payloadErr = getOpencodeErrorMessage([], { type: 'error', message: 'payload-error' });
    expect(payloadErr).toBe('payload-error');
  });

  it('detects model-not-found variants', () => {
    expect(isModelNotFound('Model not found: foo')).toBe(true);
    expect(isModelNotFound('Unknown model bar')).toBe(true);
    expect(isModelNotFound('network timeout')).toBe(false);
  });

  it('parseMaybeJson returns null for invalid json', () => {
    expect(parseMaybeJson('not-json')).toBeNull();
  });
});
