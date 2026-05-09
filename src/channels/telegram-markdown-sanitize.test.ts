import { describe, it, expect } from 'vitest';
import { sanitizeTelegramLegacyMarkdown } from './telegram-markdown-sanitize.js';

describe('sanitizeTelegramLegacyMarkdown', () => {
  it('downgrades CommonMark **bold** to legacy *bold*', () => {
    expect(sanitizeTelegramLegacyMarkdown('**Host path**')).toBe('*Host path*');
  });

  it('downgrades CommonMark __bold__ to legacy _italic_', () => {
    expect(sanitizeTelegramLegacyMarkdown('__label__')).toBe('_label_');
  });

  it('leaves balanced legacy *bold* and _italic_ alone', () => {
    expect(sanitizeTelegramLegacyMarkdown('a *b* c _d_ e')).toBe('a *b* c _d_ e');
  });

  it('preserves inline code spans untouched', () => {
    const input = 'see `file_name.py` and `**not bold**` here';
    expect(sanitizeTelegramLegacyMarkdown(input)).toBe(input);
  });

  it('preserves fenced code blocks untouched', () => {
    const input = '```\nfoo_bar **baz**\n```';
    expect(sanitizeTelegramLegacyMarkdown(input)).toBe(input);
  });

  it('escapes formatting chars on odd delimiter count (unbalanced *)', () => {
    expect(sanitizeTelegramLegacyMarkdown('a * b *c*')).toBe('a \\* b \\*c\\*');
  });

  it('escapes formatting chars on odd delimiter count (unbalanced _)', () => {
    expect(sanitizeTelegramLegacyMarkdown('file_name has _one italic_')).toBe('file\\_name has \\_one italic\\_');
  });

  it('preserves underscores in URL slugs (regression: `telegram_main` → `telegrammain`)', () => {
    const input = '**http://45.55.64.148/telegram_main/the-view/**';
    const out = sanitizeTelegramLegacyMarkdown(input);
    expect(out).toContain('telegram\\_main');
    expect(out).not.toContain('telegrammain');
  });

  it('strips brackets when unbalanced', () => {
    expect(sanitizeTelegramLegacyMarkdown('see [docs here')).toBe('see docs here');
  });

  it('leaves matched brackets (e.g. links) alone when counts balance', () => {
    const input = 'see [docs](https://example.com) for more';
    expect(sanitizeTelegramLegacyMarkdown(input)).toBe(input);
  });

  it('fixes the real failing message', () => {
    const input =
      'Sure! What do you want to mount, and where should it appear inside the container?\n\n' +
      '- **Host path** (on your machine): e.g. `~/projects/webapp`\n' +
      '- **Container path**: e.g. `workspace/webapp`\n' +
      '- **Read-only or read-write?**';
    const out = sanitizeTelegramLegacyMarkdown(input);
    expect(out).not.toContain('**');
    expect(out).toContain('*Host path*');
    expect(out).toContain('`~/projects/webapp`');
    expect((out.match(/\*/g) ?? []).length % 2).toBe(0);
  });

  it('is a no-op on empty string', () => {
    expect(sanitizeTelegramLegacyMarkdown('')).toBe('');
  });

  it('replaces dash list bullets with • so the adapter does not re-emit `*` markers', () => {
    expect(sanitizeTelegramLegacyMarkdown('- one\n- two')).toBe('• one\n• two');
  });

  it('preserves indented list structure', () => {
    expect(sanitizeTelegramLegacyMarkdown('  - nested')).toBe('  • nested');
  });

  it('flattens Markdown horizontal rules (---, ***, ___)', () => {
    const input = 'before\n---\n***\n___\nafter';
    expect(sanitizeTelegramLegacyMarkdown(input)).toBe('before\n⎯⎯⎯\n⎯⎯⎯\n⎯⎯⎯\nafter');
  });

  it('leaves horizontal rules inside code blocks alone', () => {
    const input = '```\n---\n```';
    expect(sanitizeTelegramLegacyMarkdown(input)).toBe(input);
  });
});
