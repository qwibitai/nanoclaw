import { describe, it, expect } from 'vitest';

import { extractPromptText, generateSessionId } from './acp-adapter.js';

// ── extractPromptText ───────────────────────────────────────────────

describe('extractPromptText', () => {
  it('extracts text from single text block', () => {
    const blocks = [{ type: 'text' as const, text: 'Hello world' }];
    expect(extractPromptText(blocks)).toBe('Hello world');
  });

  it('joins multiple text blocks with newline', () => {
    const blocks = [
      { type: 'text' as const, text: 'First line' },
      { type: 'text' as const, text: 'Second line' },
    ];
    expect(extractPromptText(blocks)).toBe('First line\nSecond line');
  });

  it('ignores non-text content blocks', () => {
    const blocks = [
      { type: 'text' as const, text: 'Keep this' },
      { type: 'image' as const, data: 'abc', mimeType: 'image/png' },
      { type: 'text' as const, text: 'And this' },
    ];
    // Cast to any to pass mixed types
    expect(extractPromptText(blocks as any)).toBe('Keep this\nAnd this');
  });

  it('returns empty string for no text blocks', () => {
    const blocks = [
      { type: 'image' as const, data: 'abc', mimeType: 'image/png' },
    ];
    expect(extractPromptText(blocks as any)).toBe('');
  });

  it('returns empty string for empty array', () => {
    expect(extractPromptText([])).toBe('');
  });

  it('preserves whitespace in text content', () => {
    const blocks = [
      { type: 'text' as const, text: '  indented\n\ttabbed  ' },
    ];
    expect(extractPromptText(blocks)).toBe('  indented\n\ttabbed  ');
  });
});

// ── generateSessionId ───────────────────────────────────────────────

describe('generateSessionId', () => {
  it('generates a 32-character hex string', () => {
    const id = generateSessionId();
    expect(id).toMatch(/^[0-9a-f]{32}$/);
  });

  it('generates unique IDs', () => {
    const ids = new Set(Array.from({ length: 100 }, () => generateSessionId()));
    expect(ids.size).toBe(100);
  });

  it('is lowercase hex only', () => {
    const id = generateSessionId();
    expect(id).toBe(id.toLowerCase());
    expect(id).toMatch(/^[0-9a-f]+$/);
  });
});
