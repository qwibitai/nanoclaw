import { describe, it, expect } from 'vitest';
import {
  parseTranscript,
  formatTranscriptMarkdown,
  sanitizeFilename,
  generateFallbackName,
  type ParsedMessage,
} from './precompact-hook.js';

describe('parseTranscript', () => {
  it('parses user and assistant messages from NDJSON', () => {
    const content = [
      JSON.stringify({ type: 'user', message: { role: 'user', content: 'Hello' } }),
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'Hi there' }] } }),
    ].join('\n');

    const messages = parseTranscript(content);
    expect(messages).toEqual([
      { role: 'user', content: 'Hello' },
      { role: 'assistant', content: 'Hi there' },
    ]);
  });

  it('handles array content blocks for user messages', () => {
    const content = JSON.stringify({
      type: 'user',
      message: { role: 'user', content: [{ text: 'Part 1' }, { text: ' Part 2' }] },
    });
    const messages = parseTranscript(content);
    expect(messages).toEqual([{ role: 'user', content: 'Part 1 Part 2' }]);
  });

  it('filters out non-text assistant content blocks', () => {
    const content = JSON.stringify({
      type: 'assistant',
      message: { content: [
        { type: 'tool_use', id: 'tu_1', name: 'Bash', input: {} },
        { type: 'text', text: 'Done!' },
      ] },
    });
    const messages = parseTranscript(content);
    expect(messages).toEqual([{ role: 'assistant', content: 'Done!' }]);
  });

  it('skips malformed JSON lines', () => {
    const content = 'not-json\n' + JSON.stringify({ type: 'user', message: { content: 'ok' } });
    const messages = parseTranscript(content);
    expect(messages).toEqual([{ role: 'user', content: 'ok' }]);
  });

  it('skips empty lines', () => {
    const content = '\n\n' + JSON.stringify({ type: 'user', message: { content: 'hello' } }) + '\n\n';
    const messages = parseTranscript(content);
    expect(messages).toHaveLength(1);
  });

  it('returns empty array for empty input', () => {
    expect(parseTranscript('')).toEqual([]);
  });

  it('skips messages with empty text', () => {
    const content = JSON.stringify({ type: 'user', message: { content: '' } });
    expect(parseTranscript(content)).toEqual([]);
  });

  it('skips system messages', () => {
    const content = JSON.stringify({ type: 'system', subtype: 'init', session_id: 'abc' });
    expect(parseTranscript(content)).toEqual([]);
  });
});

describe('formatTranscriptMarkdown', () => {
  const messages: ParsedMessage[] = [
    { role: 'user', content: 'Hello' },
    { role: 'assistant', content: 'Hi!' },
  ];

  it('generates markdown with title', () => {
    const md = formatTranscriptMarkdown(messages, 'Test Chat');
    expect(md).toContain('# Test Chat');
    expect(md).toContain('**User**: Hello');
    expect(md).toContain('**Assistant**: Hi!');
  });

  it('uses custom assistant name', () => {
    const md = formatTranscriptMarkdown(messages, null, 'Claw');
    expect(md).toContain('**Claw**: Hi!');
  });

  it('uses fallback title when none provided', () => {
    const md = formatTranscriptMarkdown(messages, null);
    expect(md).toContain('# Conversation');
  });

  it('truncates long content at 2000 chars', () => {
    const longMsg: ParsedMessage[] = [
      { role: 'user', content: 'x'.repeat(3000) },
    ];
    const md = formatTranscriptMarkdown(longMsg, null);
    expect(md).toContain('x'.repeat(2000) + '...');
    expect(md).not.toContain('x'.repeat(2001));
  });
});

describe('sanitizeFilename', () => {
  it('lowercases and replaces non-alphanumeric chars', () => {
    expect(sanitizeFilename('Hello World!')).toBe('hello-world');
  });

  it('trims leading/trailing dashes', () => {
    expect(sanitizeFilename('---test---')).toBe('test');
  });

  it('truncates to 50 chars', () => {
    const long = 'a'.repeat(60);
    expect(sanitizeFilename(long).length).toBe(50);
  });

  it('handles unicode characters', () => {
    expect(sanitizeFilename('대화 내용 정리')).toBe('');
  });
});

describe('generateFallbackName', () => {
  it('uses HH:MM format', () => {
    const date = new Date(2026, 2, 18, 14, 5);
    expect(generateFallbackName(date)).toBe('conversation-1405');
  });

  it('zero-pads single digit hours/minutes', () => {
    const date = new Date(2026, 0, 1, 3, 7);
    expect(generateFallbackName(date)).toBe('conversation-0307');
  });
});
