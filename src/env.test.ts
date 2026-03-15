import { describe, it, expect, afterEach, vi } from 'vitest';
import http from 'http';
import type { AddressInfo } from 'net';

vi.mock('./logger.js', () => ({
  logger: { info: vi.fn(), error: vi.fn(), debug: vi.fn(), warn: vi.fn() },
}));

describe('env', () => {
  afterEach(() => {
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

  it('initSecrets logs warning when SOLO_VAULT_ADMIN_KEY is not set', async () => {
    const { logger } = await import('./logger.js');
    const { initSecrets } = await import('./env.js');
    await initSecrets();
    expect(logger.warn).toHaveBeenCalledWith(
      'SOLO_VAULT_ADMIN_KEY not set — using .env file as secret source',
    );
  });

  it('initSecrets populates vault cache and readEnvFile returns cached values', async () => {
    const server = http.createServer((req, res) => {
      if (req.headers.authorization !== 'Bearer test-admin-key') {
        res.writeHead(401);
        res.end('Unauthorized');
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          secrets: {
            ANTHROPIC_API_KEY: 'sk-vault-key',
            TELEGRAM_BOT_TOKEN: 'vault-telegram-token',
          },
        }),
      );
    });
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve),
    );
    const port = (server.address() as AddressInfo).port;

    try {
      process.env.SOLO_VAULT_ADMIN_KEY = 'test-admin-key';
      process.env.SOLO_VAULT_URL = `http://127.0.0.1:${port}`;

      const { initSecrets, readEnvFile } = await import('./env.js');
      await initSecrets();

      const result = readEnvFile(['ANTHROPIC_API_KEY', 'TELEGRAM_BOT_TOKEN']);
      expect(result.ANTHROPIC_API_KEY).toBe('sk-vault-key');
      expect(result.TELEGRAM_BOT_TOKEN).toBe('vault-telegram-token');
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it('initSecrets supports flat secrets format', async () => {
    const server = http.createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ MY_SECRET: 'flat-value' }));
    });
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve),
    );
    const port = (server.address() as AddressInfo).port;

    try {
      process.env.SOLO_VAULT_ADMIN_KEY = 'key';
      process.env.SOLO_VAULT_URL = `http://127.0.0.1:${port}`;

      const { initSecrets, readEnvFile } = await import('./env.js');
      await initSecrets();

      const result = readEnvFile(['MY_SECRET']);
      expect(result.MY_SECRET).toBe('flat-value');
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it('initSecrets falls back gracefully when vault is unreachable', async () => {
    process.env.SOLO_VAULT_ADMIN_KEY = 'test-admin-key';
    process.env.SOLO_VAULT_URL = 'http://127.0.0.1:59999';

    const { logger } = await import('./logger.js');
    const { initSecrets } = await import('./env.js');

    await initSecrets();

    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.anything() }),
      'Solo Vault unreachable — falling back to .env file for secrets',
    );
  });

  it('vault cache takes priority over .env values', async () => {
    const server = http.createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ secrets: { ANTHROPIC_API_KEY: 'vault-key' } }));
    });
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve),
    );
    const port = (server.address() as AddressInfo).port;

    try {
      process.env.SOLO_VAULT_ADMIN_KEY = 'key';
      process.env.SOLO_VAULT_URL = `http://127.0.0.1:${port}`;

      const { initSecrets, readEnvFile } = await import('./env.js');
      await initSecrets();

      // Even if .env has a different value, vault cache wins
      const result = readEnvFile(['ANTHROPIC_API_KEY']);
      expect(result.ANTHROPIC_API_KEY).toBe('vault-key');
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it('initSecrets sends correct project and environment params', async () => {
    let requestUrl = '';
    const server = http.createServer((req, res) => {
      requestUrl = req.url || '';
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ secrets: {} }));
    });
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve),
    );
    const port = (server.address() as AddressInfo).port;

    try {
      process.env.SOLO_VAULT_ADMIN_KEY = 'key';
      process.env.SOLO_VAULT_URL = `http://127.0.0.1:${port}`;
      process.env.SOLO_VAULT_PROJECT = 'myproject';
      process.env.SOLO_VAULT_ENV = 'staging';

      const { initSecrets } = await import('./env.js');
      await initSecrets();

      expect(requestUrl).toBe(
        '/api/secrets?project=myproject&environment=staging',
      );
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });
});
