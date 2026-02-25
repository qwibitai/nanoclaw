import { describe, it, expect } from 'vitest';

import { toSlackMarkdown } from './slack.js';

describe('toSlackMarkdown', () => {
  it('converts markdown links to Slack format', () => {
    expect(toSlackMarkdown('[Google](https://google.com)')).toBe(
      '<https://google.com|Google>',
    );
  });

  it('converts multiple links', () => {
    const input = 'See [A](https://a.com) and [B](https://b.com)';
    expect(toSlackMarkdown(input)).toBe(
      'See <https://a.com|A> and <https://b.com|B>',
    );
  });

  it('handles links with special characters in label', () => {
    expect(toSlackMarkdown('[foo & bar](https://example.com)')).toBe(
      '<https://example.com|foo & bar>',
    );
  });

  it('converts bold syntax', () => {
    expect(toSlackMarkdown('this is **bold** text')).toBe(
      'this is *bold* text',
    );
  });

  it('converts strikethrough syntax', () => {
    expect(toSlackMarkdown('this is ~~struck~~ text')).toBe(
      'this is ~struck~ text',
    );
  });

  it('normalizes asterisk-style unordered lists to bullet points', () => {
    const input = '* first\n* second\n* third';
    expect(toSlackMarkdown(input)).toBe('• first\n• second\n• third');
  });

  it('leaves dash-style lists unchanged', () => {
    const input = '- first\n- second';
    expect(toSlackMarkdown(input)).toBe('- first\n- second');
  });

  it('converts headers to bold', () => {
    expect(toSlackMarkdown('### Heading')).toBe('*Heading*');
    expect(toSlackMarkdown('# Top Level')).toBe('*Top Level*');
    expect(toSlackMarkdown('## Mid Level')).toBe('*Mid Level*');
  });

  it('handles mixed content', () => {
    const input = '## Results\n\n**Total**: 5\n* [Link](https://x.com)\n* ~~old~~';
    const expected = '*Results*\n\n*Total*: 5\n• <https://x.com|Link>\n• ~old~';
    expect(toSlackMarkdown(input)).toBe(expected);
  });

  it('passes through plain text unchanged', () => {
    const input = 'Just some plain text with no formatting.';
    expect(toSlackMarkdown(input)).toBe(input);
  });
});
