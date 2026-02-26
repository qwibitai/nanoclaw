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

  it('extracts text from result-style events', () => {
    const events = [
      { type: 'step_finish' },
      { type: 'result', result: '<completion>{"run_id":"r1"}</completion>' },
    ];
    const result = extractResult('', null, events);
    expect(result).toContain('<completion>');
    expect(result).toContain('"run_id":"r1"');
  });

  it('extracts nested message.content text parts', () => {
    const events = [
      {
        type: 'message',
        message: {
          content: [
            { type: 'text', text: 'first line' },
            { type: 'text', text: 'second line' },
          ],
        },
      },
    ];
    const result = extractResult('', null, events);
    expect(result).toBe('first line\nsecond line');
  });

  it('prefers completion block found in stdout', () => {
    const stdout = [
      '{"type":"system/init"}',
      '<completion>{"run_id":"r2","branch":"jarvis-x","commit_sha":"deadbeef","files_changed":["a.ts"],"test_result":"pass","risk":"low","pr_skipped_reason":"n/a"}</completion>',
      '{"type":"step_finish"}',
    ].join('\n');
    const result = extractResult(stdout, { type: 'step_finish' }, []);
    expect(result).toContain('<completion>');
    expect(result).toContain('"run_id":"r2"');
  });

  it('falls back to raw stdout when payload has no extractable text', () => {
    const stdout = '{"type":"step_finish","sessionID":"ses_123"}';
    const result = extractResult(stdout, { type: 'step_finish' }, []);
    expect(result).toBe(stdout);
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
