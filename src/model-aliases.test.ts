import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import { loadModelAliases, resolveModelAlias, MODEL_ALIASES_PATH } from './config.js';

describe('loadModelAliases', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('loads aliases from JSON file', () => {
    vi.spyOn(fs, 'readFileSync').mockReturnValue(
      JSON.stringify({
        opus: 'claude-opus-4-20250514',
        sonnet: 'claude-sonnet-4-20250514',
      }),
    );

    const aliases = loadModelAliases();

    expect(aliases).toEqual({
      opus: 'claude-opus-4-20250514',
      sonnet: 'claude-sonnet-4-20250514',
    });
    expect(fs.readFileSync).toHaveBeenCalledWith(MODEL_ALIASES_PATH, 'utf-8');
  });

  it('returns empty object when file does not exist', () => {
    vi.spyOn(fs, 'readFileSync').mockImplementation(() => {
      throw new Error('ENOENT');
    });

    const aliases = loadModelAliases();

    expect(aliases).toEqual({});
  });

  it('returns empty object when file contains invalid JSON', () => {
    vi.spyOn(fs, 'readFileSync').mockReturnValue('not valid json');

    const aliases = loadModelAliases();

    expect(aliases).toEqual({});
  });
});

describe('resolveModelAlias', () => {
  beforeEach(() => {
    vi.spyOn(fs, 'readFileSync').mockReturnValue(
      JSON.stringify({
        opus: 'claude-opus-4-20250514',
        sonnet: 'claude-sonnet-4-20250514',
        haiku: 'claude-haiku-4-20250514',
      }),
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('resolves known alias to full model ID', () => {
    expect(resolveModelAlias('opus')).toBe('claude-opus-4-20250514');
    expect(resolveModelAlias('sonnet')).toBe('claude-sonnet-4-20250514');
    expect(resolveModelAlias('haiku')).toBe('claude-haiku-4-20250514');
  });

  it('resolves alias case-insensitively', () => {
    expect(resolveModelAlias('OPUS')).toBe('claude-opus-4-20250514');
    expect(resolveModelAlias('Sonnet')).toBe('claude-sonnet-4-20250514');
  });

  it('returns input unchanged when alias is not found', () => {
    expect(resolveModelAlias('claude-opus-4-20250514')).toBe(
      'claude-opus-4-20250514',
    );
    expect(resolveModelAlias('unknown-model')).toBe('unknown-model');
  });
});
