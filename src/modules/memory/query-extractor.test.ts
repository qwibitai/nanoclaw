import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  extractFocusedQuery,
  setQueryExtractorBackendForTest,
  _resetQueryExtractorBackendForTest,
  clearCacheForTest,
} from './query-extractor.js';

describe('extractFocusedQuery', () => {
  beforeEach(() => {
    _resetQueryExtractorBackendForTest();
    clearCacheForTest();
  });

  afterEach(() => {
    _resetQueryExtractorBackendForTest();
    clearCacheForTest();
  });

  it('test_caches_by_current_message', async () => {
    let counter = 0;
    setQueryExtractorBackendForTest(async () => {
      counter++;
      return 'extracted';
    });
    await extractFocusedQuery('msg', 'slice1');
    await extractFocusedQuery('msg', 'slice2');
    await extractFocusedQuery('msg', 'slice3');
    expect(counter).toBe(1);
  });

  it('test_cache_miss_on_different_message', async () => {
    let counter = 0;
    setQueryExtractorBackendForTest(async () => {
      counter++;
      return 'extracted';
    });
    await extractFocusedQuery('msg1', 'slice');
    await extractFocusedQuery('msg2', 'slice');
    expect(counter).toBe(2);
  });

  it('test_truncates_long_output', async () => {
    const longOutput = 'x'.repeat(200);
    setQueryExtractorBackendForTest(async () => longOutput);
    const result = await extractFocusedQuery('q', 'slice');
    expect(result.length).toBe(80);
  });

  it('test_strips_quotes', async () => {
    setQueryExtractorBackendForTest(async () => '"foo bar"');
    const result = await extractFocusedQuery('q', 'slice');
    expect(result).toBe('foo bar');
  });

  it('test_strips_null_bytes', async () => {
    let capturedInput = '';
    setQueryExtractorBackendForTest(async (_sys: string, userPrompt: string) => {
      capturedInput = userPrompt;
      return 'result';
    });
    await extractFocusedQuery('msg', 'has\0null');
    expect(capturedInput).not.toContain('\0');
    expect(capturedInput).toContain('hasnull');
  });

  it('test_throws_on_timeout', async () => {
    setQueryExtractorBackendForTest(async () => {
      await new Promise((resolve) => setTimeout(resolve, 1000));
      return 'late';
    });
    await expect(extractFocusedQuery('q', 'slice', { timeoutMs: 100 })).rejects.toThrow();
  });

  it('test_throws_on_backend_error', async () => {
    setQueryExtractorBackendForTest(async () => {
      throw new Error('backend error');
    });
    await expect(extractFocusedQuery('q', 'slice')).rejects.toThrow('backend error');
  });
});
