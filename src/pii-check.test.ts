import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AnonymizeConfig } from './anonymize.js';
import { checkForPii, formatPiiAlert, PiiResult } from './pii-check.js';

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

  it('returns PII items when Ollama finds them', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        response: JSON.stringify({
          found: [{ text: 'Livvy', type: 'name', suggestion: 'Lulu' }],
        }),
      }),
    });

    const result = await checkForPii('Hello Livvy', baseCfg);
    expect(result).not.toBeNull();
    expect(result!.found).toHaveLength(1);
    expect(result!.found[0].text).toBe('Livvy');
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
            { text: 'Luna', type: 'name', suggestion: 'Star' },
            { text: 'Livvy', type: 'name', suggestion: 'Lulu' },
          ],
        }),
      }),
    });

    const result = await checkForPii('Hello Luna and Livvy', baseCfg);
    expect(result!.found).toHaveLength(1);
    expect(result!.found[0].text).toBe('Livvy');
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
          '```json\n{"found": [{"text": "Dr Patel", "type": "name", "suggestion": "Dr River"}]}\n```',
      }),
    });

    const result = await checkForPii('Visit Dr Patel', baseCfg);
    expect(result!.found).toHaveLength(1);
    expect(result!.found[0].text).toBe('Dr Patel');
  });
});

describe('formatPiiAlert', () => {
  it('formats a readable alert message', () => {
    const result: PiiResult = {
      found: [
        { text: 'Livvy', type: 'name', suggestion: 'Lulu' },
        { text: 'Dr Patel', type: 'name', suggestion: 'Dr River' },
      ],
    };
    const msg = formatPiiAlert(result);
    expect(msg).toContain('PII detected');
    expect(msg).toContain('"Livvy" (name)');
    expect(msg).toContain('"Dr Patel" (name)');
    expect(msg).toContain('"approve"');
    expect(msg).toContain('"skip"');
    expect(msg).toContain('"map X > Y"');
  });
});
