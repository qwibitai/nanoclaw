import { describe, it, expect } from 'vitest';
import {
  extractWikilinks,
  createWikilink,
  replaceWikilinks,
} from './wikilinks.js';

describe('extractWikilinks', () => {
  it('extracts a simple wikilink', () => {
    const result = extractWikilinks('See [[Target]] for details.');
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({
      target: 'Target',
      heading: undefined,
      alias: undefined,
    });
  });

  it('extracts a wikilink with a heading', () => {
    const result = extractWikilinks('See [[Target#Introduction]] for more.');
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({
      target: 'Target',
      heading: 'Introduction',
      alias: undefined,
    });
  });

  it('extracts a wikilink with an alias', () => {
    const result = extractWikilinks('See [[Target|My Alias]] here.');
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({
      target: 'Target',
      heading: undefined,
      alias: 'My Alias',
    });
  });

  it('extracts a wikilink with both heading and alias', () => {
    const result = extractWikilinks('Read [[Target#Section|Click here]].');
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({
      target: 'Target',
      heading: 'Section',
      alias: 'Click here',
    });
  });

  it('returns empty array when there are no wikilinks', () => {
    const result = extractWikilinks('Just plain text with no links at all.');
    expect(result).toEqual([]);
  });

  it('ignores image embeds ![[figure.png]]', () => {
    const result = extractWikilinks(
      'Here is an image ![[figure.png]] embedded.',
    );
    expect(result).toEqual([]);
  });

  it('ignores image embeds but still extracts adjacent wikilinks', () => {
    const result = extractWikilinks(
      '![[image.png]] and [[RealLink]] together.',
    );
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({
      target: 'RealLink',
      heading: undefined,
      alias: undefined,
    });
  });

  it('extracts multiple wikilinks from the same text', () => {
    const result = extractWikilinks(
      '[[Alpha]] references [[Beta#Section]] and [[Gamma|G]].',
    );
    expect(result).toHaveLength(3);
    expect(result[0]).toEqual({
      target: 'Alpha',
      heading: undefined,
      alias: undefined,
    });
    expect(result[1]).toEqual({
      target: 'Beta',
      heading: 'Section',
      alias: undefined,
    });
    expect(result[2]).toEqual({
      target: 'Gamma',
      heading: undefined,
      alias: 'G',
    });
  });

  it('trims whitespace from target, heading, and alias', () => {
    const result = extractWikilinks('[[ Target # Heading | Alias ]]');
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({
      target: 'Target',
      heading: 'Heading',
      alias: 'Alias',
    });
  });
});

describe('createWikilink', () => {
  it('creates a simple wikilink', () => {
    expect(createWikilink('Target')).toBe('[[Target]]');
  });

  it('creates a wikilink with a heading', () => {
    expect(createWikilink('Target', { heading: 'Introduction' })).toBe(
      '[[Target#Introduction]]',
    );
  });

  it('creates a wikilink with an alias', () => {
    expect(createWikilink('Target', { alias: 'My Alias' })).toBe(
      '[[Target|My Alias]]',
    );
  });

  it('creates a wikilink with both heading and alias', () => {
    expect(
      createWikilink('Target', { heading: 'Section', alias: 'Click here' }),
    ).toBe('[[Target#Section|Click here]]');
  });

  it('creates a wikilink with no opts provided', () => {
    expect(createWikilink('My Note')).toBe('[[My Note]]');
  });
});

describe('replaceWikilinks', () => {
  it('renames a simple target', () => {
    const result = replaceWikilinks(
      'See [[OldTarget]] here.',
      'OldTarget',
      'NewTarget',
    );
    expect(result).toBe('See [[NewTarget]] here.');
  });

  it('renames target while preserving heading', () => {
    const result = replaceWikilinks(
      'See [[OldTarget#Section]] here.',
      'OldTarget',
      'NewTarget',
    );
    expect(result).toBe('See [[NewTarget#Section]] here.');
  });

  it('renames target while preserving alias', () => {
    const result = replaceWikilinks(
      'See [[OldTarget|My Alias]] here.',
      'OldTarget',
      'NewTarget',
    );
    expect(result).toBe('See [[NewTarget|My Alias]] here.');
  });

  it('renames target while preserving both heading and alias', () => {
    const result = replaceWikilinks(
      'See [[OldTarget#Section|Click here]] here.',
      'OldTarget',
      'NewTarget',
    );
    expect(result).toBe('See [[NewTarget#Section|Click here]] here.');
  });

  it('replaces all occurrences of the target', () => {
    const result = replaceWikilinks(
      '[[Foo]] and [[Foo#Bar]] and [[Foo|baz]]',
      'Foo',
      'Qux',
    );
    expect(result).toBe('[[Qux]] and [[Qux#Bar]] and [[Qux|baz]]');
  });

  it('does not replace image embeds', () => {
    const result = replaceWikilinks(
      '![[OldTarget]] and [[OldTarget]]',
      'OldTarget',
      'NewTarget',
    );
    expect(result).toBe('![[OldTarget]] and [[NewTarget]]');
  });

  it('does not replace a different target with a similar name', () => {
    const result = replaceWikilinks(
      '[[OldTarget]] and [[OldTargetExtra]]',
      'OldTarget',
      'NewTarget',
    );
    expect(result).toBe('[[NewTarget]] and [[OldTargetExtra]]');
  });

  it('returns markdown unchanged if the target is not found', () => {
    const markdown = 'See [[SomeOtherNote]] here.';
    const result = replaceWikilinks(markdown, 'NonExistent', 'NewTarget');
    expect(result).toBe(markdown);
  });

  it('handles targets with regex special characters', () => {
    const result = replaceWikilinks(
      'See [[Note (2024)]] here.',
      'Note (2024)',
      'Note 2024',
    );
    expect(result).toBe('See [[Note 2024]] here.');
  });
});
