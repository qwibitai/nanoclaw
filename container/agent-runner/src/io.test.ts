import { describe, expect, it, vi } from 'vitest';

import {
  OUTPUT_END_MARKER,
  OUTPUT_START_MARKER,
  log,
  stripInternalTags,
  writeOutput,
} from './io.js';

describe('stripInternalTags', () => {
  it('strips a balanced <internal>...</internal> block', () => {
    expect(stripInternalTags('before <internal>secret</internal> after')).toBe(
      'before  after',
    );
  });

  it('strips an unterminated <internal>... tail', () => {
    expect(stripInternalTags('visible <internal>still thinking')).toBe(
      'visible',
    );
  });

  it('strips a partial "<int" prefix at end of string', () => {
    expect(stripInternalTags('partial tag <internal')).toBe('partial tag');
    expect(stripInternalTags('partial tag <inter')).toBe('partial tag');
    expect(stripInternalTags('partial tag <int')).toBe('partial tag');
  });

  it('leaves plain text untouched', () => {
    expect(stripInternalTags('plain text')).toBe('plain text');
  });
});

describe('writeOutput', () => {
  it('emits start/end markers around the JSON payload', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    writeOutput({ status: 'success', result: 'ok' });
    const calls = log.mock.calls.map((c) => c[0]);
    expect(calls[0]).toBe(OUTPUT_START_MARKER);
    expect(JSON.parse(calls[1] as string)).toEqual({
      status: 'success',
      result: 'ok',
    });
    expect(calls[2]).toBe(OUTPUT_END_MARKER);
    log.mockRestore();
  });
});

describe('log', () => {
  it('writes to stderr with the [agent-runner] prefix', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    log('hello');
    expect(err).toHaveBeenCalledWith('[agent-runner] hello');
    err.mockRestore();
  });
});
