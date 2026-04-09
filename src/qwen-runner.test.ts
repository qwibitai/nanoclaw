import { describe, it, expect } from 'vitest';
import { classifyQwenError } from './qwen-runner.js';

describe('classifyQwenError', () => {
  it('returns stale-session for missing session message', () => {
    expect(classifyQwenError('No saved session found with ID abc123', 1)).toBe(
      'stale-session',
    );
  });

  it('returns context-exhausted for context window errors', () => {
    expect(
      classifyQwenError('context length exceeded maximum token limit', 1),
    ).toBe('context-exhausted');
    expect(classifyQwenError('Context window is full', 1)).toBe(
      'context-exhausted',
    );
    expect(classifyQwenError('maximum context length', 1)).toBe(
      'context-exhausted',
    );
  });

  it('returns non-retryable for 4xx client errors (not 429)', () => {
    expect(classifyQwenError('HTTP 400 Bad Request', 1)).toBe('non-retryable');
    expect(classifyQwenError('HTTP 401 Unauthorized', 1)).toBe('non-retryable');
    expect(classifyQwenError('HTTP 403 Forbidden', 1)).toBe('non-retryable');
  });

  it('returns retryable for 429 rate limit', () => {
    expect(classifyQwenError('HTTP 429 Too Many Requests', 1)).toBe(
      'retryable',
    );
  });

  it('returns retryable for timeout (exit code 0 edge case)', () => {
    expect(classifyQwenError('', 1)).toBe('retryable');
  });

  it('returns retryable for unknown errors', () => {
    expect(classifyQwenError('something went wrong', 1)).toBe('retryable');
  });
});
