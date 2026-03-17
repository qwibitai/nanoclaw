import { describe, it, expect } from 'vitest';

import { generateAudioFilename } from './obsidian.js';

// --- generateAudioFilename ---

describe('generateAudioFilename', () => {
  it('generates YYYY-MM-DD-HHMMSS.ogg from a Date', () => {
    // 2026-03-17 14:30:45 UTC
    const date = new Date('2026-03-17T14:30:45.000Z');
    expect(generateAudioFilename(date)).toBe('2026-03-17-143045.ogg');
  });

  it('zero-pads single-digit months, days, hours, minutes, seconds', () => {
    // 2026-01-05 03:07:09 UTC
    const date = new Date('2026-01-05T03:07:09.000Z');
    expect(generateAudioFilename(date)).toBe('2026-01-05-030709.ogg');
  });

  it('handles midnight correctly', () => {
    const date = new Date('2026-06-15T00:00:00.000Z');
    expect(generateAudioFilename(date)).toBe('2026-06-15-000000.ogg');
  });

  it('handles end of day correctly', () => {
    const date = new Date('2026-12-31T23:59:59.000Z');
    expect(generateAudioFilename(date)).toBe('2026-12-31-235959.ogg');
  });
});
