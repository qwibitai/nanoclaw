import { describe, expect, it } from 'vitest';

import { extractImages } from './router.js';

describe('extractImages', () => {
  it('returns text unchanged when no image tags', () => {
    const result = extractImages('Hello world');
    expect(result.cleanText).toBe('Hello world');
    expect(result.images).toEqual([]);
  });

  it('extracts a single image tag with caption', () => {
    const result = extractImages(
      'Here is a photo <image path="https://example.com/pic.jpg" caption="A photo" />',
    );
    expect(result.cleanText).toBe('Here is a photo');
    expect(result.images).toEqual([
      { path: 'https://example.com/pic.jpg', caption: 'A photo' },
    ]);
  });

  it('extracts image tag without caption', () => {
    const result = extractImages('<image path="/tmp/photo.png" />');
    expect(result.cleanText).toBe('');
    expect(result.images).toEqual([
      { path: '/tmp/photo.png', caption: undefined },
    ]);
  });

  it('extracts multiple image tags', () => {
    const result = extractImages(
      'First <image path="a.jpg" caption="A" /> middle <image path="b.jpg" caption="B" /> end',
    );
    expect(result.cleanText).toBe('First  middle  end');
    expect(result.images).toHaveLength(2);
    expect(result.images[0]).toEqual({ path: 'a.jpg', caption: 'A' });
    expect(result.images[1]).toEqual({ path: 'b.jpg', caption: 'B' });
  });

  it('handles image-only output (no surrounding text)', () => {
    const result = extractImages('<image path="photo.jpg" caption="Done" />');
    expect(result.cleanText).toBe('');
    expect(result.images).toHaveLength(1);
  });
});
