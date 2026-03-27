import { describe, it, expect } from 'vitest';
import {
  parseFrontmatter,
  serializeFrontmatter,
  updateFrontmatter,
} from './frontmatter.js';

describe('parseFrontmatter', () => {
  it('parses YAML frontmatter and body from a markdown string', () => {
    const markdown = `---
title: My Note
tags:
  - study
  - math
created: 2024-01-15
---

# My Note

Some content here.`;

    const result = parseFrontmatter(markdown);

    expect(result.data).toEqual({
      title: 'My Note',
      tags: ['study', 'math'],
      created: new Date('2024-01-15'),
    });
    expect(result.content).toBe('# My Note\n\nSome content here.');
  });

  it('returns empty data object when no frontmatter is present', () => {
    const markdown = '# Just a heading\n\nSome content.';
    const result = parseFrontmatter(markdown);

    expect(result.data).toEqual({});
    expect(result.content).toBe('# Just a heading\n\nSome content.');
  });

  it('handles empty string', () => {
    const result = parseFrontmatter('');

    expect(result.data).toEqual({});
    expect(result.content).toBe('');
  });

  it('handles frontmatter-only (no body)', () => {
    const markdown = `---
title: Empty Body
---
`;

    const result = parseFrontmatter(markdown);

    expect(result.data).toEqual({ title: 'Empty Body' });
    expect(result.content).toBe('');
  });

  it('trims whitespace from the body content', () => {
    const markdown = `---
title: Trim Test
---


Body after blank lines.
`;

    const result = parseFrontmatter(markdown);
    expect(result.content).toBe('Body after blank lines.');
  });

  it('parses numeric and boolean values in frontmatter', () => {
    const markdown = `---
count: 42
active: true
ratio: 3.14
---

Content.`;

    const result = parseFrontmatter(markdown);
    expect(result.data.count).toBe(42);
    expect(result.data.active).toBe(true);
    expect(result.data.ratio).toBe(3.14);
  });
});

describe('serializeFrontmatter', () => {
  it('combines data and content into a markdown string with YAML frontmatter', () => {
    const data = { title: 'Test Note', tags: ['a', 'b'] };
    const content = '# Test Note\n\nContent here.';

    const result = serializeFrontmatter(data, content);

    expect(result).toContain('---');
    expect(result).toContain('title: Test Note');
    expect(result).toContain('- a');
    expect(result).toContain('- b');
    expect(result).toContain('# Test Note');
    expect(result).toContain('Content here.');
  });

  it('handles empty data object', () => {
    const result = serializeFrontmatter({}, 'Just content.');

    // gray-matter.stringify with empty data still produces frontmatter delimiters
    expect(result).toContain('Just content.');
  });

  it('produces output that round-trips correctly through parseFrontmatter', () => {
    const data = { title: 'Round Trip', priority: 1, done: false };
    const content = 'Body text.';

    const serialized = serializeFrontmatter(data, content);
    const parsed = parseFrontmatter(serialized);

    expect(parsed.data.title).toBe('Round Trip');
    expect(parsed.data.priority).toBe(1);
    expect(parsed.data.done).toBe(false);
    expect(parsed.content).toBe('Body text.');
  });
});

describe('updateFrontmatter', () => {
  it('merges new fields into existing frontmatter', () => {
    const markdown = `---
title: Original
---

Content.`;

    const result = updateFrontmatter(markdown, {
      tags: ['new'],
      reviewed: true,
    });
    const parsed = parseFrontmatter(result);

    expect(parsed.data.title).toBe('Original');
    expect(parsed.data.tags).toEqual(['new']);
    expect(parsed.data.reviewed).toBe(true);
    expect(parsed.content).toBe('Content.');
  });

  it('overwrites existing fields with new values', () => {
    const markdown = `---
title: Old Title
count: 1
---

Body.`;

    const result = updateFrontmatter(markdown, {
      title: 'New Title',
      count: 99,
    });
    const parsed = parseFrontmatter(result);

    expect(parsed.data.title).toBe('New Title');
    expect(parsed.data.count).toBe(99);
    expect(parsed.content).toBe('Body.');
  });

  it('preserves body content unchanged', () => {
    const markdown = `---
title: Note
---

# Heading

Paragraph with **bold** and _italic_.`;

    const result = updateFrontmatter(markdown, { status: 'done' });
    const parsed = parseFrontmatter(result);

    expect(parsed.content).toBe(
      '# Heading\n\nParagraph with **bold** and _italic_.',
    );
  });

  it('adds frontmatter to markdown that has none', () => {
    const markdown = 'Just plain content.';

    const result = updateFrontmatter(markdown, { title: 'Added' });
    const parsed = parseFrontmatter(result);

    expect(parsed.data.title).toBe('Added');
    expect(parsed.content).toBe('Just plain content.');
  });

  it('handles empty updates gracefully', () => {
    const markdown = `---
title: Existing
---

Content.`;

    const result = updateFrontmatter(markdown, {});
    const parsed = parseFrontmatter(result);

    expect(parsed.data.title).toBe('Existing');
    expect(parsed.content).toBe('Content.');
  });
});
