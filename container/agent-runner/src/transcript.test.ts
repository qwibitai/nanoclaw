import { describe, expect, it } from 'vitest';

import {
  formatTranscriptMarkdown,
  generateFallbackName,
  parseTranscript,
  sanitizeFilename,
} from './transcript.js';

describe('sanitizeFilename', () => {
  it('lowercases and replaces non-alphanumerics with dashes', () => {
    expect(sanitizeFilename('Hello, World!')).toBe('hello-world');
  });

  it('trims leading and trailing dashes', () => {
    expect(sanitizeFilename('---foo---bar---')).toBe('foo-bar');
  });

  it('truncates to 50 characters', () => {
    const long = 'a'.repeat(100);
    expect(sanitizeFilename(long)).toHaveLength(50);
  });

  it('returns empty string for content with no alphanumerics', () => {
    expect(sanitizeFilename('!!!')).toBe('');
  });
});

describe('generateFallbackName', () => {
  it('produces a name matching conversation-HHMM', () => {
    expect(generateFallbackName()).toMatch(/^conversation-\d{4}$/);
  });
});

describe('parseTranscript', () => {
  it('extracts user string content', () => {
    const line = JSON.stringify({
      type: 'user',
      message: { content: 'hello' },
    });
    expect(parseTranscript(line)).toEqual([{ role: 'user', content: 'hello' }]);
  });

  it('extracts user array content by concatenating text parts', () => {
    const line = JSON.stringify({
      type: 'user',
      message: { content: [{ text: 'a' }, { text: 'b' }, { notText: 'x' }] },
    });
    expect(parseTranscript(line)).toEqual([{ role: 'user', content: 'ab' }]);
  });

  it('extracts assistant text-only parts, ignoring other block types', () => {
    const line = JSON.stringify({
      type: 'assistant',
      message: {
        content: [
          { type: 'text', text: 'hi' },
          { type: 'tool_use', input: {} },
          { type: 'text', text: ' there' },
        ],
      },
    });
    expect(parseTranscript(line)).toEqual([
      { role: 'assistant', content: 'hi there' },
    ]);
  });

  it('skips empty lines, malformed JSON, and unsupported types', () => {
    const transcript = [
      '',
      'not json',
      JSON.stringify({ type: 'system', message: { content: 'ignored' } }),
      JSON.stringify({ type: 'user', message: { content: 'ok' } }),
    ].join('\n');
    expect(parseTranscript(transcript)).toEqual([
      { role: 'user', content: 'ok' },
    ]);
  });

  it('drops messages whose extracted text is empty', () => {
    const line = JSON.stringify({
      type: 'user',
      message: { content: '' },
    });
    expect(parseTranscript(line)).toEqual([]);
  });
});

describe('formatTranscriptMarkdown', () => {
  it('renders a title, archive line, and each message', () => {
    const md = formatTranscriptMarkdown(
      [
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: 'hello' },
      ],
      'Greetings',
      'Andy',
    );
    expect(md).toContain('# Greetings');
    expect(md).toMatch(/Archived:/);
    expect(md).toContain('**User**: hi');
    expect(md).toContain('**Andy**: hello');
  });

  it('falls back to "Conversation" when no title is provided', () => {
    const md = formatTranscriptMarkdown([{ role: 'user', content: 'x' }]);
    expect(md).toContain('# Conversation');
  });

  it('uses "Assistant" when no assistantName is passed', () => {
    const md = formatTranscriptMarkdown([
      { role: 'assistant', content: 'ok' },
    ]);
    expect(md).toContain('**Assistant**: ok');
  });

  it('truncates individual messages over 2000 chars with an ellipsis', () => {
    const long = 'x'.repeat(2500);
    const md = formatTranscriptMarkdown([{ role: 'user', content: long }]);
    expect(md).toContain('x'.repeat(2000) + '...');
    expect(md).not.toContain('x'.repeat(2001));
  });
});
