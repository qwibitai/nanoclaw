import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AnonymizeConfig } from './anonymize.js';
import {
  checkForPii,
  formatPiiAlert,
  generatePseudonym,
  matchVariant,
  PiiResult,
} from './pii-check.js';

const baseCfg: AnonymizeConfig = {
  enabled: true,
  piiCheck: true,
  piiModel: 'llama3.2:3b',
  mappings: { Olivia: 'Luna', Simon: 'Alex' },
};

// Mock global fetch
const mockFetch = vi.fn();
beforeEach(() => {
  vi.stubGlobal('fetch', mockFetch);
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe('checkForPii', () => {
  it('returns null when piiCheck is false', async () => {
    const cfg = { ...baseCfg, piiCheck: false };
    expect(await checkForPii('some text', cfg)).toBeNull();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('returns null when piiCheck is undefined', async () => {
    const cfg = { ...baseCfg, piiCheck: undefined };
    expect(await checkForPii('some text', cfg)).toBeNull();
  });

  it('returns PII items with generated pseudonyms', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        response: JSON.stringify({
          found: [{ text: 'Claire', type: 'name' }],
        }),
      }),
    });

    const result = await checkForPii('Hello Claire', baseCfg);
    expect(result).not.toBeNull();
    expect(result!.found).toHaveLength(1);
    expect(result!.found[0].text).toBe('Claire');
    // Gets a pool pseudonym, NOT Luna or Alex
    expect(result!.found[0].suggestion).toBe('Ember');
    expect(result!.found[0].variantOf).toBeUndefined();
  });

  it('overrides suggestion for variant matches via matchVariant', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        response: JSON.stringify({
          found: [{ text: 'Livvy', type: 'name' }],
        }),
      }),
    });

    const result = await checkForPii('Hello Livvy', baseCfg);
    expect(result).not.toBeNull();
    expect(result!.found).toHaveLength(1);
    expect(result!.found[0].suggestion).toBe('Luna');
    expect(result!.found[0].variantOf).toBe('Olivia');
  });

  it('generates unique pseudonyms for multiple items in one batch', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        response: JSON.stringify({
          found: [
            { text: 'Claire', type: 'name' },
            { text: 'Rich', type: 'name' },
            { text: 'Hannah', type: 'name' },
          ],
        }),
      }),
    });

    const result = await checkForPii('Claire, Rich and Hannah', baseCfg);
    expect(result!.found).toHaveLength(3);
    const suggestions = result!.found.map((i) => i.suggestion);
    // All different
    expect(new Set(suggestions).size).toBe(3);
    // None are Luna or Alex
    expect(suggestions).not.toContain('Luna');
    expect(suggestions).not.toContain('Alex');
  });

  it('handles Ollama response that still includes suggestion field', async () => {
    // Model might still return suggestion — we ignore it and generate our own
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        response: JSON.stringify({
          found: [{ text: 'Claire', type: 'name', suggestion: 'Luna' }],
        }),
      }),
    });

    const result = await checkForPii('Hello Claire', baseCfg);
    // Our code overrides with pool pseudonym
    expect(result!.found[0].suggestion).toBe('Ember');
  });

  it('returns null when Ollama finds no PII', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        response: JSON.stringify({ found: [] }),
      }),
    });

    expect(await checkForPii('Hello Luna', baseCfg)).toBeNull();
  });

  it('filters out known pseudonyms from findings', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        response: JSON.stringify({
          found: [
            { text: 'Luna', type: 'name' },
            { text: 'Claire', type: 'name' },
          ],
        }),
      }),
    });

    const result = await checkForPii('Hello Luna and Claire', baseCfg);
    expect(result!.found).toHaveLength(1);
    expect(result!.found[0].text).toBe('Claire');
  });

  it('throws on fetch error (never skip PII check)', async () => {
    mockFetch.mockRejectedValue(new Error('Connection refused'));
    await expect(checkForPii('text', baseCfg)).rejects.toThrow(
      'Connection refused',
    );
  });

  it('throws on non-OK response', async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 500 });
    await expect(checkForPii('text', baseCfg)).rejects.toThrow('status 500');
  });

  it('throws on malformed JSON response', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ response: 'not json at all' }),
    });
    await expect(checkForPii('text', baseCfg)).rejects.toThrow();
  });

  it('handles markdown-fenced JSON from model', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        response:
          '```json\n{"found": [{"text": "Dr Patel", "type": "name"}]}\n```',
      }),
    });

    const result = await checkForPii('Visit Dr Patel', baseCfg);
    expect(result!.found).toHaveLength(1);
    expect(result!.found[0].text).toBe('Dr Patel');
    expect(result!.found[0].suggestion).toBe('Ember');
  });
});

describe('matchVariant', () => {
  const mappings = { Olivia: 'Luna', Simon: 'Alex' };

  it('matches via shared 3-char window: Livvy↔Olivia share "liv"', () => {
    const result = matchVariant('Livvy', mappings);
    expect(result).toEqual({ pseudo: 'Luna', real: 'Olivia' });
  });

  it('matches substring: Oli is contained in Olivia', () => {
    const result = matchVariant('Oli', mappings);
    expect(result).toEqual({ pseudo: 'Luna', real: 'Olivia' });
  });

  it('matches prefix: Sim shares 3-char window with Simon', () => {
    const result = matchVariant('Sim', mappings);
    expect(result).toEqual({ pseudo: 'Alex', real: 'Simon' });
  });

  it('does NOT match unrelated names', () => {
    expect(matchVariant('Claire', mappings)).toBeNull();
    expect(matchVariant('Hannah', mappings)).toBeNull();
    expect(matchVariant('Pete', mappings)).toBeNull();
    expect(matchVariant('Rich', mappings)).toBeNull();
    expect(matchVariant('Hyun', mappings)).toBeNull();
    expect(matchVariant('Jenny', mappings)).toBeNull();
  });

  it('skips names shorter than 3 chars', () => {
    expect(matchVariant('Si', mappings)).toBeNull();
    expect(matchVariant('Ol', mappings)).toBeNull();
  });

  it('skips mapping keys shorter than 3 chars', () => {
    expect(matchVariant('Bobby', { Bo: 'Bee' })).toBeNull();
  });

  it('is case insensitive', () => {
    expect(matchVariant('LIVVY', mappings)).toEqual({
      pseudo: 'Luna',
      real: 'Olivia',
    });
    expect(matchVariant('olivia', mappings)).toEqual({
      pseudo: 'Luna',
      real: 'Olivia',
    });
  });
});

describe('generatePseudonym', () => {
  it('picks the first available pseudonym from the pool', () => {
    expect(generatePseudonym(new Set())).toBe('Ember');
  });

  it('skips already-used pseudonyms', () => {
    expect(generatePseudonym(new Set(['Ember']))).toBe('Azure');
    expect(generatePseudonym(new Set(['Ember', 'Azure']))).toBe('Coral');
  });

  it('is case insensitive when checking used names', () => {
    expect(generatePseudonym(new Set(['ember']))).toBe('Azure');
    expect(generatePseudonym(new Set(['EMBER']))).toBe('Azure');
  });

  it('also skips non-pool pseudonyms (e.g. Luna, Alex)', () => {
    // Luna and Alex aren't in the pool, so they don't affect selection
    expect(generatePseudonym(new Set(['Luna', 'Alex']))).toBe('Ember');
  });

  it('falls back to PersonN when pool exhausted', () => {
    const allUsed = new Set([
      'Ember',
      'Azure',
      'Coral',
      'Sage',
      'River',
      'Cedar',
      'Ivory',
      'Jade',
      'Pearl',
      'Flint',
      'Hazel',
      'Onyx',
      'Robin',
      'Sterling',
      'Wren',
      'Briar',
      'Echo',
      'Fern',
      'Harbor',
      'Indigo',
      'Lark',
      'Maple',
      'Nova',
      'Orion',
      'Piper',
      'Reed',
      'Sable',
      'Terra',
      'Vale',
      'Willow',
    ]);
    expect(generatePseudonym(allUsed)).toBe('Person31');
  });
});

describe('formatPiiAlert', () => {
  it('formats a readable alert message', () => {
    const result: PiiResult = {
      found: [
        { text: 'Claire', type: 'name', suggestion: 'Ember' },
        { text: 'Dr Patel', type: 'name', suggestion: 'Azure' },
      ],
    };
    const msg = formatPiiAlert(result);
    expect(msg).toContain('PII detected');
    expect(msg).toContain('"Claire" (name)');
    expect(msg).toContain('"Dr Patel" (name)');
    expect(msg).toContain('suggest mapping to "Ember"');
    expect(msg).toContain('suggest mapping to "Azure"');
    expect(msg).toContain('"approve"');
    expect(msg).toContain('"skip"');
    expect(msg).toContain('"map X > Y"');
  });

  it('shows variant note when variantOf is set', () => {
    const result: PiiResult = {
      found: [
        {
          text: 'Livvy',
          type: 'name',
          suggestion: 'Luna',
          variantOf: 'Olivia',
        },
      ],
    };
    const msg = formatPiiAlert(result);
    expect(msg).toContain('(variant of Olivia)');
    expect(msg).toContain('suggest mapping to "Luna"');
  });

  it('shows no variant note when variantOf is not set', () => {
    const result: PiiResult = {
      found: [{ text: 'Dr Patel', type: 'name', suggestion: 'Ember' }],
    };
    const msg = formatPiiAlert(result);
    expect(msg).not.toContain('variant of');
    expect(msg).toContain('suggest mapping to "Ember"');
  });
});
