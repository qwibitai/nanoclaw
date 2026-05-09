import { describe, it, expect } from 'vitest';

import { unwrapRedundantMarkdownLinks } from './discord-mentions.js';

describe('unwrapRedundantMarkdownLinks', () => {
  it('unwraps [url](sameurl) to bare url', () => {
    const input = '[https://opensea.io/item/matic/0x28D/2](https://opensea.io/item/matic/0x28D/2)';
    expect(unwrapRedundantMarkdownLinks(input)).toBe('https://opensea.io/item/matic/0x28D/2');
  });

  it('preserves genuine [label](url) where label != url', () => {
    const input = '[click here](https://example.com)';
    expect(unwrapRedundantMarkdownLinks(input)).toBe('[click here](https://example.com)');
  });

  it('handles multiple links in one message', () => {
    const input = 'See [https://a.com](https://a.com) and [Real](https://b.com) and [https://c.com](https://c.com).';
    expect(unwrapRedundantMarkdownLinks(input)).toBe('See https://a.com and [Real](https://b.com) and https://c.com.');
  });

  it('leaves text without markdown links unchanged', () => {
    expect(unwrapRedundantMarkdownLinks('plain text')).toBe('plain text');
    expect(unwrapRedundantMarkdownLinks('https://example.com bare url')).toBe('https://example.com bare url');
  });

  it('handles empty/short strings without scanning', () => {
    expect(unwrapRedundantMarkdownLinks('')).toBe('');
    expect(unwrapRedundantMarkdownLinks('hi')).toBe('hi');
  });
});
