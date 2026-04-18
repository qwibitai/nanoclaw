import { describe, it, expect } from 'vitest';
import { truncatePreview } from '../email-preview.js';

describe('truncatePreview', () => {
  it('returns full text if under limit', () => {
    const text = 'Short email body.';
    expect(truncatePreview(text, 500)).toBe(text);
  });

  it('truncates at word boundary', () => {
    const text = 'word '.repeat(200); // 1000 chars
    const preview = truncatePreview(text, 500);
    expect(preview.length).toBeLessThanOrEqual(550); // some slack for suffix
    expect(preview).toContain('— truncated');
    expect(preview).not.toMatch(/\s— truncated/); // no trailing space before truncation marker
  });

  it('handles text with no spaces', () => {
    const text = 'a'.repeat(600);
    const preview = truncatePreview(text, 500);
    expect(preview.length).toBeLessThanOrEqual(550);
  });
});
