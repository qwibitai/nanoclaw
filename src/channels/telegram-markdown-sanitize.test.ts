import { describe, it, expect } from 'vitest';
import { sanitizeTelegramLegacyMarkdown } from './telegram-markdown-sanitize.js';

// Contract: produce text that Telegram's legacy Markdown parser will ALWAYS
// accept. Markdown formatting in prose is stripped; code spans are preserved
// as-is so identifiers with underscores or stars survive intact.

describe('sanitizeTelegramLegacyMarkdown', () => {
  it('strips CommonMark **bold**', () => {
    expect(sanitizeTelegramLegacyMarkdown('**Host path**')).toBe('Host path');
  });

  it('strips CommonMark __bold__', () => {
    expect(sanitizeTelegramLegacyMarkdown('__label__')).toBe('label');
  });

  it('strips legacy *bold* and _italic_', () => {
    expect(sanitizeTelegramLegacyMarkdown('a *b* c _d_ e')).toBe('a b c d e');
  });

  it('preserves inline backtick code verbatim (underscores survive)', () => {
    expect(sanitizeTelegramLegacyMarkdown('see `file_name.py` here')).toBe('see `file_name.py` here');
  });

  it('preserves fenced code blocks verbatim', () => {
    const input = '```\nfoo_bar baz\n```';
    expect(sanitizeTelegramLegacyMarkdown(input)).toBe('```\nfoo_bar baz\n```');
  });

  it('drops language tag on fenced code blocks', () => {
    expect(sanitizeTelegramLegacyMarkdown('```python\nfoo\n```')).toBe('```\nfoo\n```');
  });

  it('strips stray markdown characters in prose', () => {
    expect(sanitizeTelegramLegacyMarkdown('a * b *c*')).toBe('a  b c');
    expect(sanitizeTelegramLegacyMarkdown('file_name has _one italic_')).toBe('filename has one italic');
  });

  it('drops unbalanced brackets (prose outside code)', () => {
    expect(sanitizeTelegramLegacyMarkdown('see [docs here')).toBe('see docs here');
  });

  it('rewrites markdown links as label + parenthesized URL', () => {
    expect(sanitizeTelegramLegacyMarkdown('see [docs](https://example.com) for more')).toBe(
      'see docs (https://example.com) for more',
    );
  });

  it('preserves underscores inside bare URLs (OAuth params, etc.)', () => {
    const url =
      'https://backend.composio.dev/api/v3/auth/dash/oauth2/authorize?response_type=code&client_id=abc&code_challenge=xyz&code_challenge_method=S256&scope=openid+offline_access';
    expect(sanitizeTelegramLegacyMarkdown(`Abre: ${url}`)).toBe(`Abre: ${url}`);
  });

  it('preserves URL underscores even when wrapped in markdown link syntax', () => {
    const url = 'https://example.com/path?key_one=a&key_two=b';
    expect(sanitizeTelegramLegacyMarkdown(`See [link](${url}) here`)).toBe(`See link (${url}) here`);
  });

  it('handles the real failing message that blocked Caio in the DM', () => {
    const input =
      'Sure! What do you want to mount, and where should it appear inside the container?\n\n' +
      '- **Host path** (on your machine): e.g. `~/projects/webapp`\n' +
      '- **Container path**: e.g. `workspace/webapp`\n' +
      '- **Read-only or read-write?**';
    const out = sanitizeTelegramLegacyMarkdown(input);
    expect(out).not.toContain('**');
    expect(out).toContain('Host path');
    // Inline code with special chars survives verbatim.
    expect(out).toContain('`~/projects/webapp`');
    // No stray markdown punctuation outside code — parser-safe.
    const outsideCode = out.replace(/`[^`\n]*`/g, '').replace(/```[\s\S]*?```/g, '');
    expect((outsideCode.match(/[*_[\]]/g) ?? []).length).toBe(0);
  });

  it('is a no-op on empty string', () => {
    expect(sanitizeTelegramLegacyMarkdown('')).toBe('');
  });

  it('replaces dash list bullets with •', () => {
    expect(sanitizeTelegramLegacyMarkdown('- one\n- two')).toBe('• one\n• two');
  });

  it('replaces asterisk list bullets with •', () => {
    expect(sanitizeTelegramLegacyMarkdown('* one\n* two')).toBe('• one\n• two');
  });

  it('preserves indented list structure', () => {
    expect(sanitizeTelegramLegacyMarkdown('  - nested')).toBe('  • nested');
  });
});
