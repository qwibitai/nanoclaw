import { describe, it, expect } from 'vitest';

import {
  formatQuestion,
  getOptionEmoji,
  getReactionEmojis,
  resolveReaction,
  parseTextReply,
  buildResponse,
} from './structured-elicitation.js';

describe('formatQuestion', () => {
  it('formats question with numbered options', () => {
    const result = formatQuestion('Pick one:', ['Alpha', 'Beta', 'Gamma'], false);
    expect(result).toContain('Pick one:');
    expect(result).toContain('1️⃣ Alpha');
    expect(result).toContain('2️⃣ Beta');
    expect(result).toContain('3️⃣ Gamma');
  });

  it('includes freetext hint when allowed', () => {
    const result = formatQuestion('Choose:', ['A', 'B'], true);
    expect(result).toContain('custom response');
  });

  it('omits freetext hint when not allowed', () => {
    const result = formatQuestion('Choose:', ['A', 'B'], false);
    expect(result).not.toContain('custom response');
  });
});

describe('getOptionEmoji', () => {
  it('returns correct emojis for indices', () => {
    expect(getOptionEmoji(0)).toBe('1️⃣');
    expect(getOptionEmoji(1)).toBe('2️⃣');
    expect(getOptionEmoji(2)).toBe('3️⃣');
  });

  it('falls back to number string for overflow', () => {
    expect(getOptionEmoji(10)).toBe('11');
  });
});

describe('getReactionEmojis', () => {
  it('returns correct number of emojis', () => {
    expect(getReactionEmojis(3)).toHaveLength(3);
    expect(getReactionEmojis(3)).toEqual(['1️⃣', '2️⃣', '3️⃣']);
  });

  it('caps at 10 emojis', () => {
    expect(getReactionEmojis(15)).toHaveLength(10);
  });
});

describe('resolveReaction', () => {
  const options = ['Email follow-up', 'Research task', 'Both'];

  it('resolves first emoji to first option', () => {
    expect(resolveReaction('1️⃣', options)).toBe('Email follow-up');
  });

  it('resolves third emoji to third option', () => {
    expect(resolveReaction('3️⃣', options)).toBe('Both');
  });

  it('returns null for unrecognized emoji', () => {
    expect(resolveReaction('🎉', options)).toBeNull();
  });

  it('returns null for out-of-range emoji', () => {
    expect(resolveReaction('5️⃣', options)).toBeNull();
  });
});

describe('parseTextReply', () => {
  const options = ['Alpha', 'Beta', 'Gamma'];

  it('parses numeric reply "1"', () => {
    expect(parseTextReply('1', options)).toBe('Alpha');
  });

  it('parses numeric reply "3"', () => {
    expect(parseTextReply('3', options)).toBe('Gamma');
  });

  it('parses exact text match (case-insensitive)', () => {
    expect(parseTextReply('beta', options)).toBe('Beta');
  });

  it('returns null for non-matching text', () => {
    expect(parseTextReply('something else', options)).toBeNull();
  });

  it('returns null for out-of-range number', () => {
    expect(parseTextReply('5', options)).toBeNull();
  });

  it('returns null for zero', () => {
    expect(parseTextReply('0', options)).toBeNull();
  });

  it('trims whitespace', () => {
    expect(parseTextReply('  2  ', options)).toBe('Beta');
  });
});

describe('buildResponse', () => {
  it('builds chosen response', () => {
    const resp = buildResponse('req-1', 'Option A', null, false);
    expect(resp.id).toBe('req-1');
    expect(resp.chosen).toBe('Option A');
    expect(resp.freetext).toBeNull();
    expect(resp.timeout).toBe(false);
  });

  it('builds freetext response', () => {
    const resp = buildResponse('req-2', null, 'My custom answer', false);
    expect(resp.chosen).toBeNull();
    expect(resp.freetext).toBe('My custom answer');
  });

  it('builds timeout response', () => {
    const resp = buildResponse('req-3', null, null, true);
    expect(resp.timeout).toBe(true);
  });
});
