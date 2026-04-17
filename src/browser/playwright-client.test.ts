import { describe, it, expect, vi, beforeEach } from 'vitest';
import { waitForSidecarReady } from './playwright-client.js';

vi.mock('../config.js', () => ({
  BROWSER_CDP_URL: 'http://test-sidecar:9222',
}));

vi.mock('../logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

// Mock playwright-core
const mockBrowser = {
  newContext: vi.fn(),
  isConnected: vi.fn(() => true),
  close: vi.fn(),
  on: vi.fn(),
};

vi.mock('playwright-core', () => ({
  chromium: {
    connectOverCDP: vi.fn(() => Promise.resolve(mockBrowser)),
  },
}));

import { PlaywrightClient } from './playwright-client.js';

describe('waitForSidecarReady', () => {
  it('returns true once CDP /json/version responds', async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new Error('ECONNREFUSED'))
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ Browser: 'Chromium/1' }),
      });
    const ok = await waitForSidecarReady('http://localhost:9222', {
      fetchImpl: fetchMock as unknown as typeof fetch,
      timeoutMs: 5000,
      intervalMs: 50,
    });
    expect(ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('returns false on timeout', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));
    const ok = await waitForSidecarReady('http://localhost:9222', {
      fetchImpl: fetchMock as unknown as typeof fetch,
      timeoutMs: 200,
      intervalMs: 50,
    });
    expect(ok).toBe(false);
  });
});

describe('PlaywrightClient', () => {
  let client: PlaywrightClient;

  beforeEach(() => {
    vi.clearAllMocks();
    client = new PlaywrightClient();
  });

  describe('connect', () => {
    it('connects to the sidecar CDP endpoint', async () => {
      await client.connect();
      const { chromium } = await import('playwright-core');
      expect(chromium.connectOverCDP).toHaveBeenCalledWith(
        'http://test-sidecar:9222',
      );
      expect(client.isConnected()).toBe(true);
    });

    it('is idempotent when already connected', async () => {
      await client.connect();
      await client.connect();
      const { chromium } = await import('playwright-core');
      expect(chromium.connectOverCDP).toHaveBeenCalledTimes(1);
    });
  });

  describe('newContext', () => {
    it('creates a browser context after connecting', async () => {
      const mockContext = { close: vi.fn(), pages: vi.fn(() => []) };
      mockBrowser.newContext.mockResolvedValueOnce(mockContext);

      await client.connect();
      const ctx = await client.newContext();
      expect(ctx).toBe(mockContext);
      expect(mockBrowser.newContext).toHaveBeenCalled();
    });

    it('auto-connects if not connected', async () => {
      const mockContext = { close: vi.fn(), pages: vi.fn(() => []) };
      mockBrowser.newContext.mockResolvedValueOnce(mockContext);

      const ctx = await client.newContext();
      expect(ctx).toBe(mockContext);
      expect(client.isConnected()).toBe(true);
    });
  });

  describe('disconnect', () => {
    it('closes the browser connection', async () => {
      await client.connect();
      await client.disconnect();
      expect(mockBrowser.close).toHaveBeenCalled();
      expect(client.isConnected()).toBe(false);
    });

    it('is safe to call when not connected', async () => {
      await client.disconnect(); // no throw
    });
  });
});
