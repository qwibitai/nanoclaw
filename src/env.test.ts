import { describe, it, expect, afterEach, vi } from 'vitest';
import http from 'http';
import type { AddressInfo } from 'net';

vi.mock('./logger.js', () => ({
  logger: { info: vi.fn(), error: vi.fn(), debug: vi.fn(), warn: vi.fn() },
}));

describe('env', () => {
  afterEach(() => {
    delete process.env.SOLO_VAULT_TOKEN;
    delete process.env.SOLO_VAULT_ADMIN_KEY;
    delete process.env.SOLO_VAULT_URL;
    delete process.env.SOLO_VAULT_PROJECT;
    delete process.env.SOLO_VAULT_ENV;
    vi.resetModules();
  });

  it('readEnvFile returns values from .env when vault cache is empty', async () => {
    const { readEnvFile } = await import('./env.js');
    const result = readEnvFile(['ASSISTANT_NAME']);
    expect(typeof result).toBe('object');
  });

  it('initSecrets logs warning when SOLO_VAULT_TOKEN is not set', async () => {
    const { logger } = await import('./logger.js');
    const { initSecrets } = await import('./env.js');
    await initSecrets();
    expect(logger.warn).toHaveBeenCalledWith(
      'SOLO_VAULT_TOKEN not set — using .env file as secret source',
    );
  });

  it('initSecrets accepts SOLO_VAULT_ADMIN_KEY for backward compatibility', async () => {
    const { logger } = await import('./logger.js');
    const { initSecrets, isVaultConfigured } = await import('./env.js');

    process.env.SOLO_VAULT_ADMIN_KEY = 'legacy-key';
    process.env.SOLO_VAULT_URL = 'http://127.0.0.1:1'; // won't be hit

    await initSecrets();
    expect(isVaultConfigured()).toBe(true);
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ project: 'nanoclaw', environment: 'production' }),
      'Solo Vault configured for on-demand secret fetching',
    );
  });

  it('refreshSecrets fetches individual keys from vault and caches with TTL', async () => {
    const requestPaths: string[] = [];
    const server = http.createServer((req, res) => {
      requestPaths.push(req.url || '');
      if (req.headers.authorization !== 'Bearer test-token') {
        res.writeHead(401);
        res.end('Unauthorized');
        return;
      }
      const key = (req.url || '').split('/').pop();
      const values: Record<string, string> = {
        ANTHROPIC_API_KEY: 'sk-vault-key',
        TELEGRAM_BOT_TOKEN: 'vault-telegram-token',
      };
      if (key && values[key]) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ value: values[key] }));
      } else {
        res.writeHead(404);
        res.end('Not found');
      }
    });
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve),
    );
    const port = (server.address() as AddressInfo).port;

    try {
      process.env.SOLO_VAULT_TOKEN = 'test-token';
      process.env.SOLO_VAULT_URL = `http://127.0.0.1:${port}`;

      const { initSecrets, refreshSecrets, readEnvFile } = await import(
        './env.js'
      );
      await initSecrets();
      await refreshSecrets(['ANTHROPIC_API_KEY', 'TELEGRAM_BOT_TOKEN']);

      const result = readEnvFile(['ANTHROPIC_API_KEY', 'TELEGRAM_BOT_TOKEN']);
      expect(result.ANTHROPIC_API_KEY).toBe('sk-vault-key');
      expect(result.TELEGRAM_BOT_TOKEN).toBe('vault-telegram-token');

      // Verify per-key endpoint was used
      expect(requestPaths).toContain(
        '/v1/secrets/nanoclaw/production/ANTHROPIC_API_KEY',
      );
      expect(requestPaths).toContain(
        '/v1/secrets/nanoclaw/production/TELEGRAM_BOT_TOKEN',
      );
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it('refreshSecrets skips keys that are still cached (TTL not expired)', async () => {
    let requestCount = 0;
    const server = http.createServer((_req, res) => {
      requestCount++;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ value: 'cached-value' }));
    });
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve),
    );
    const port = (server.address() as AddressInfo).port;

    try {
      process.env.SOLO_VAULT_TOKEN = 'key';
      process.env.SOLO_VAULT_URL = `http://127.0.0.1:${port}`;

      const { initSecrets, refreshSecrets, readEnvFile } = await import(
        './env.js'
      );
      await initSecrets();

      // First fetch
      await refreshSecrets(['MY_SECRET']);
      expect(requestCount).toBe(1);
      expect(readEnvFile(['MY_SECRET']).MY_SECRET).toBe('cached-value');

      // Second fetch — should use cache, not hit vault
      await refreshSecrets(['MY_SECRET']);
      expect(requestCount).toBe(1);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it('refreshSecrets falls back gracefully when vault is unreachable', async () => {
    process.env.SOLO_VAULT_TOKEN = 'test-token';
    process.env.SOLO_VAULT_URL = 'http://127.0.0.1:59999';

    const { logger } = await import('./logger.js');
    const { initSecrets, refreshSecrets } = await import('./env.js');

    await initSecrets();
    await refreshSecrets(['ANTHROPIC_API_KEY']);

    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.anything() }),
      'Failed to fetch secret from Solo Vault — will use .env fallback',
    );
  });

  it('vault cache takes priority over .env values', async () => {
    const server = http.createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ value: 'vault-key' }));
    });
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve),
    );
    const port = (server.address() as AddressInfo).port;

    try {
      process.env.SOLO_VAULT_TOKEN = 'key';
      process.env.SOLO_VAULT_URL = `http://127.0.0.1:${port}`;

      const { initSecrets, refreshSecrets, readEnvFile } = await import(
        './env.js'
      );
      await initSecrets();
      await refreshSecrets(['ANTHROPIC_API_KEY']);

      // Even if .env has a different value, vault cache wins
      const result = readEnvFile(['ANTHROPIC_API_KEY']);
      expect(result.ANTHROPIC_API_KEY).toBe('vault-key');
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it('refreshSecrets sends correct project and environment in URL path', async () => {
    let requestUrl = '';
    const server = http.createServer((req, res) => {
      requestUrl = req.url || '';
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ value: 'val' }));
    });
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve),
    );
    const port = (server.address() as AddressInfo).port;

    try {
      process.env.SOLO_VAULT_TOKEN = 'key';
      process.env.SOLO_VAULT_URL = `http://127.0.0.1:${port}`;
      process.env.SOLO_VAULT_PROJECT = 'myproject';
      process.env.SOLO_VAULT_ENV = 'staging';

      const { initSecrets, refreshSecrets } = await import('./env.js');
      await initSecrets();
      await refreshSecrets(['MY_KEY']);

      expect(requestUrl).toBe('/v1/secrets/myproject/staging/MY_KEY');
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it('isVaultConfigured returns false when token is not set', async () => {
    const { initSecrets, isVaultConfigured } = await import('./env.js');
    await initSecrets();
    expect(isVaultConfigured()).toBe(false);
  });

  it('isVaultConfigured returns true when token is set', async () => {
    process.env.SOLO_VAULT_TOKEN = 'some-token';
    const { initSecrets, isVaultConfigured } = await import('./env.js');
    await initSecrets();
    expect(isVaultConfigured()).toBe(true);
  });
});
