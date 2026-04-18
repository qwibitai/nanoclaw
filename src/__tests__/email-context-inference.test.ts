import { describe, it, expect } from 'vitest';
import { inferEmailContext } from '../email-context-inference.js';

describe('inferEmailContext', () => {
  it('extracts thread_id from trigger-style echo', () => {
    const text =
      'Processed email from Alice — [personal] From: alice@x.com, Subject: Hi (thread: 19d99c2c4efb0225)';
    expect(inferEmailContext(text)).toEqual({
      emailId: '19d99c2c4efb0225',
      emailAccount: 'personal',
    });
  });

  it('extracts thread_id without surrounding parens', () => {
    const text = 'Marked thread_id: 19d99c343394c43c as processed.';
    expect(inferEmailContext(text)).toEqual({
      emailId: '19d99c343394c43c',
      emailAccount: undefined,
    });
  });

  it('handles threadId (camelCase) form', () => {
    const text = 'See threadId=abc12345deadbeef for details.';
    expect(inferEmailContext(text)?.emailId).toBe('abc12345deadbeef');
  });

  it('returns null when no thread id found', () => {
    expect(inferEmailContext('hello world, no email context')).toBeNull();
  });

  it('returns null when multiple distinct thread ids appear', () => {
    const text =
      'Two items: (thread: 111111111111) and (thread: 222222222222).';
    expect(inferEmailContext(text)).toBeNull();
  });

  it('treats repeated same id as a single match', () => {
    const text = '(thread: 19d99c2c4efb0225) — see thread: 19d99c2c4efb0225';
    expect(inferEmailContext(text)?.emailId).toBe('19d99c2c4efb0225');
  });

  it('ignores too-short matches ("thread: it")', () => {
    expect(inferEmailContext('let me thread: it through')).toBeNull();
  });

  it('skips common bracketed words as false-positive accounts', () => {
    const text = '[email] Something happened (thread: 19d99c2c4efb0225)';
    const ctx = inferEmailContext(text);
    expect(ctx?.emailId).toBe('19d99c2c4efb0225');
    expect(ctx?.emailAccount).toBeUndefined();
  });

  it('returns no account when multiple account tags appear', () => {
    const text = '[personal] and [whoisxml] — (thread: 19d99c2c4efb0225)';
    const ctx = inferEmailContext(text);
    expect(ctx?.emailId).toBe('19d99c2c4efb0225');
    expect(ctx?.emailAccount).toBeUndefined();
  });
});
