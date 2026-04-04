import { describe, it, expect } from 'vitest';
import { filterNoise } from './memory-noise-filter.js';

describe('filterNoise', () => {
  const getText = (item: { text: string }) => item.text;

  it('keeps normal text', () => {
    const items = [{ text: 'This is a valid memory entry' }];
    expect(filterNoise(items, getText)).toEqual(items);
  });

  it('removes empty text', () => {
    const items = [{ text: '' }, { text: 'valid' }];
    expect(filterNoise(items, getText)).toEqual([{ text: 'valid' }]);
  });

  it('removes whitespace-only text', () => {
    const items = [{ text: '   ' }, { text: 'valid' }];
    expect(filterNoise(items, getText)).toEqual([{ text: 'valid' }]);
  });

  it('removes text shorter than 5 chars', () => {
    const items = [{ text: 'hi' }, { text: 'ok' }, { text: 'valid text here' }];
    expect(filterNoise(items, getText)).toEqual([{ text: 'valid text here' }]);
  });

  it('removes punctuation-only text', () => {
    const items = [{ text: '!!...,,,???' }, { text: 'valid text' }];
    expect(filterNoise(items, getText)).toEqual([{ text: 'valid text' }]);
  });

  it('returns empty array when all items are noise', () => {
    const items = [{ text: '' }, { text: '...' }, { text: '  ' }];
    expect(filterNoise(items, getText)).toEqual([]);
  });

  it('returns empty array for empty input', () => {
    expect(filterNoise([], getText)).toEqual([]);
  });
});
