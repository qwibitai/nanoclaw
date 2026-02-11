import { describe, expect, it, vi } from 'vitest';

import {
  detectLanguageFromText,
  getFallbackErrorMessage,
  getPreferredLanguage,
} from './error-fallback.js';

describe('getPreferredLanguage', () => {
  it('returns supported language from lookup', () => {
    const lookup = vi.fn(() => 'hi');
    expect(getPreferredLanguage('919999999999', lookup)).toBe('hi');
  });

  it('returns null for unsupported language values', () => {
    const lookup = vi.fn(() => 'fr');
    expect(getPreferredLanguage('919999999999', lookup)).toBeNull();
  });

  it('returns null when lookup throws', () => {
    const lookup = vi.fn(() => {
      throw new Error('db error');
    });
    expect(getPreferredLanguage('919999999999', lookup)).toBeNull();
  });
});

describe('detectLanguageFromText', () => {
  it('detects english for latin text', () => {
    expect(detectLanguageFromText('Please help with road repair')).toBe('en');
  });

  it('detects marathi for devanagari text', () => {
    expect(detectLanguageFromText('कृपया मदत करा')).toBe('mr');
  });

  it('defaults to marathi for empty text', () => {
    expect(detectLanguageFromText('')).toBe('mr');
  });
});

describe('getFallbackErrorMessage', () => {
  it('returns hindi message for hi', () => {
    expect(getFallbackErrorMessage('hi')).toContain('तकनीकी समस्या');
  });

  it('returns english message for en', () => {
    expect(getFallbackErrorMessage('en')).toContain('technical issue');
  });

  it('returns marathi message for mr', () => {
    expect(getFallbackErrorMessage('mr')).toContain('तांत्रिक अडचणीमुळे');
  });
});
