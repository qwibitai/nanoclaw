import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  fetchDispatchConfig,
  resolveConfig,
  getEffectiveConfig,
  refreshConfig,
  startConfigPolling,
  stopConfigPolling,
  _resetForTest,
} from './dispatch-config.js';

function mockFetchResponse(body: unknown, ok = true, status = 200) {
  return Promise.resolve({
    ok,
    status,
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body)),
  } as Response);
}

describe('dispatch-config', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    _resetForTest();
    fetchMock = vi
      .fn()
      .mockResolvedValue(mockFetchResponse({ success: true, data: {} }));
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    stopConfigPolling();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  describe('fetchDispatchConfig', () => {
    it('returns config data on success', async () => {
      fetchMock.mockResolvedValueOnce(
        mockFetchResponse({
          success: true,
          data: { provider: 'anthropic', model: 'claude-sonnet-4-5-20250929' },
        }),
      );

      const config = await fetchDispatchConfig();
      expect(config).toEqual({
        provider: 'anthropic',
        model: 'claude-sonnet-4-5-20250929',
      });

      const call = fetchMock.mock.calls[0];
      expect(call[0]).toContain('/dispatch-config');
    });

    it('returns null on non-ok response', async () => {
      fetchMock.mockResolvedValueOnce(
        mockFetchResponse({ error: 'not found' }, false, 404),
      );

      const config = await fetchDispatchConfig();
      expect(config).toBeNull();
    });

    it('returns null when API returns success: false', async () => {
      fetchMock.mockResolvedValueOnce(mockFetchResponse({ success: false }));

      const config = await fetchDispatchConfig();
      expect(config).toBeNull();
    });

    it('returns null when API returns no data', async () => {
      fetchMock.mockResolvedValueOnce(mockFetchResponse({ success: true }));

      const config = await fetchDispatchConfig();
      expect(config).toBeNull();
    });

    it('returns null on network error', async () => {
      fetchMock.mockRejectedValueOnce(new Error('network down'));

      const config = await fetchDispatchConfig();
      expect(config).toBeNull();
    });
  });

  describe('resolveConfig', () => {
    it('uses API values when present', () => {
      const resolved = resolveConfig({
        provider: 'openai',
        model: 'gpt-4',
        cli_bin: '/usr/local/bin/openai-cli',
      });

      expect(resolved.provider).toBe('openai');
      expect(resolved.model).toBe('gpt-4');
      expect(resolved.cliBin).toBe('/usr/local/bin/openai-cli');
    });

    it('falls back to env var defaults when API config is null', () => {
      const resolved = resolveConfig(null);

      // These come from config.ts defaults
      expect(resolved.provider).toBe('claude');
      expect(resolved.cliBin).toBe('claude');
      expect(resolved.model).toBeUndefined();
    });

    it('falls back to env vars for missing API fields', () => {
      const resolved = resolveConfig({ provider: 'anthropic' });

      expect(resolved.provider).toBe('anthropic');
      expect(resolved.cliBin).toBe('claude'); // default
      expect(resolved.model).toBeUndefined(); // not set
    });
  });

  describe('getEffectiveConfig', () => {
    it('returns env defaults when no API config has been fetched', () => {
      const config = getEffectiveConfig();
      expect(config.provider).toBe('claude');
      expect(config.cliBin).toBe('claude');
      expect(config.model).toBeUndefined();
    });

    it('returns API config after refresh', async () => {
      fetchMock.mockResolvedValueOnce(
        mockFetchResponse({
          success: true,
          data: { provider: 'anthropic', model: 'opus-4', cli_bin: 'claude' },
        }),
      );

      await refreshConfig();

      const config = getEffectiveConfig();
      expect(config.provider).toBe('anthropic');
      expect(config.model).toBe('opus-4');
      expect(config.cliBin).toBe('claude');
    });

    it('reverts to env defaults when API becomes unavailable', async () => {
      // First refresh succeeds
      fetchMock.mockResolvedValueOnce(
        mockFetchResponse({
          success: true,
          data: { provider: 'anthropic', model: 'opus-4' },
        }),
      );
      await refreshConfig();
      expect(getEffectiveConfig().model).toBe('opus-4');

      // Second refresh fails
      fetchMock.mockRejectedValueOnce(new Error('connection refused'));
      await refreshConfig();

      // Falls back to defaults
      const config = getEffectiveConfig();
      expect(config.provider).toBe('claude');
      expect(config.model).toBeUndefined();
    });
  });

  describe('startConfigPolling / stopConfigPolling', () => {
    it('fetches config immediately on start', async () => {
      fetchMock.mockResolvedValueOnce(
        mockFetchResponse({
          success: true,
          data: { provider: 'anthropic', model: 'sonnet' },
        }),
      );

      const stop = await startConfigPolling();

      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(getEffectiveConfig().model).toBe('sonnet');

      stop();
    });

    it('returns a cleanup function', async () => {
      fetchMock.mockResolvedValueOnce(
        mockFetchResponse({ success: true, data: {} }),
      );

      const stop = await startConfigPolling();
      expect(typeof stop).toBe('function');
      stop();
    });
  });

  describe('_resetForTest', () => {
    it('clears cached config', async () => {
      fetchMock.mockResolvedValueOnce(
        mockFetchResponse({
          success: true,
          data: { model: 'opus-4' },
        }),
      );
      await refreshConfig();
      expect(getEffectiveConfig().model).toBe('opus-4');

      _resetForTest();
      expect(getEffectiveConfig().model).toBeUndefined();
    });
  });
});
