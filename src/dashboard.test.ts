import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import http from 'http';

vi.mock('./config.js', () => ({
  DASHBOARD_AUTH_TOKEN: '',
  DASHBOARD_PORT: 0,
}));

vi.mock('./logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('./db.js', () => ({
  getAllRegisteredGroups: vi.fn(() => ({
    'dc:123': {
      name: 'Test',
      folder: 'test',
      trigger: '@Andy',
      added_at: '2024-01-01',
    },
  })),
  getAllTasks: vi.fn(() => []),
  getEmbeddingChunkCount: vi.fn(() => 42),
  getAllDbRoutines: vi.fn(() => []),
  getMessageStatsByGroup: vi.fn(() => ({
    'dc:123': { count: 10, lastActivity: '2024-01-01T00:00:00Z' },
  })),
}));

function fetch(
  url: string,
  options?: { headers?: Record<string, string> },
): Promise<{ status: number; headers: http.IncomingHttpHeaders; json: () => Promise<unknown>; text: () => Promise<string> }> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const reqOptions: http.RequestOptions = {
      hostname: parsed.hostname,
      port: parsed.port,
      path: parsed.pathname,
      method: 'GET',
      headers: options?.headers || {},
    };

    const req = http.request(reqOptions, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf-8');
        resolve({
          status: res.statusCode!,
          headers: res.headers,
          json: () => Promise.resolve(JSON.parse(body)),
          text: () => Promise.resolve(body),
        });
      });
    });

    req.on('error', reject);
    req.end();
  });
}

describe('Dashboard', () => {
  let server: http.Server;
  let baseUrl: string;

  beforeEach(async () => {
    // Reset config mock to no auth by default
    const config = await import('./config.js');
    (config as Record<string, unknown>).DASHBOARD_AUTH_TOKEN = '';

    const { startDashboard } = await import('./dashboard.js');
    server = startDashboard();
    await new Promise<void>((resolve) => {
      server.on('listening', resolve);
    });
    const addr = server.address() as { port: number };
    baseUrl = `http://127.0.0.1:${addr.port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  });

  it('GET /api/health returns 200 with { ok: true }', async () => {
    const res = await fetch(`${baseUrl}/api/health`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; uptime: number };
    expect(body.ok).toBe(true);
    expect(typeof body.uptime).toBe('number');
  });

  it('GET /api/status returns JSON with uptime, groups, tasks fields', async () => {
    const res = await fetch(`${baseUrl}/api/status`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(typeof body.uptime).toBe('number');
    expect(body.groups).toBe(1);
    expect(body.tasks).toBe(0);
    expect(body).toHaveProperty('memory');
    expect(body).toHaveProperty('version');
  });

  it('GET /api/groups returns registered groups data', async () => {
    const res = await fetch(`${baseUrl}/api/groups`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Array<Record<string, unknown>>;
    expect(Array.isArray(body)).toBe(true);
    expect(body.length).toBe(1);
    expect(body[0].jid).toBe('dc:123');
    expect(body[0].name).toBe('Test');
    expect(body[0].messageCount).toBe(10);
    expect(body[0].lastActivity).toBe('2024-01-01T00:00:00Z');
  });

  it('GET /api/memory returns embedding/routine counts', async () => {
    const res = await fetch(`${baseUrl}/api/memory`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.embeddingChunks).toBe(42);
    expect(body.routines).toBe(0);
  });

  it('GET / returns HTML with "Sovereign Dashboard"', async () => {
    const res = await fetch(`${baseUrl}/`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('Sovereign Dashboard');
    expect(html).toContain('<html');
    expect(html).toContain('setInterval');
  });

  it('returns 404 for unknown paths', async () => {
    const res = await fetch(`${baseUrl}/unknown`);
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('Not found');
  });

  it('returns 401 when auth token is set and request is unauthenticated', async () => {
    // Close current server
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });

    // Set auth token
    const config = await import('./config.js');
    (config as Record<string, unknown>).DASHBOARD_AUTH_TOKEN = 'secret-token';

    const { startDashboard } = await import('./dashboard.js');
    server = startDashboard();
    await new Promise<void>((resolve) => {
      server.on('listening', resolve);
    });
    const addr = server.address() as { port: number };
    baseUrl = `http://127.0.0.1:${addr.port}`;

    const res = await fetch(`${baseUrl}/api/health`);
    expect(res.status).toBe(401);
  });

  it('returns 200 when auth token is set and valid Bearer token is provided', async () => {
    // Close current server
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });

    // Set auth token
    const config = await import('./config.js');
    (config as Record<string, unknown>).DASHBOARD_AUTH_TOKEN = 'secret-token';

    const { startDashboard } = await import('./dashboard.js');
    server = startDashboard();
    await new Promise<void>((resolve) => {
      server.on('listening', resolve);
    });
    const addr = server.address() as { port: number };
    baseUrl = `http://127.0.0.1:${addr.port}`;

    const res = await fetch(`${baseUrl}/api/health`, {
      headers: { Authorization: 'Bearer secret-token' },
    });
    expect(res.status).toBe(200);
  });

  it('allows requests when no auth token is configured', async () => {
    // Default setup has no auth token
    const res = await fetch(`${baseUrl}/api/health`);
    expect(res.status).toBe(200);
  });

  it('JSON endpoints return proper Content-Type', async () => {
    const endpoints = ['/api/health', '/api/status', '/api/groups', '/api/memory'];
    for (const endpoint of endpoints) {
      const res = await fetch(`${baseUrl}${endpoint}`);
      expect(res.headers['content-type']).toBe('application/json');
    }
  });

  it('server starts and stops cleanly', async () => {
    // The server is already started in beforeEach
    const addr = server.address() as { port: number };
    expect(addr.port).toBeGreaterThan(0);

    // Verify we can make a request
    const res = await fetch(`${baseUrl}/api/health`);
    expect(res.status).toBe(200);

    // Server will be closed in afterEach — verify it closes cleanly
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });

    // Re-create server so afterEach doesn't fail
    const { startDashboard } = await import('./dashboard.js');
    server = startDashboard();
    await new Promise<void>((resolve) => {
      server.on('listening', resolve);
    });
    const newAddr = server.address() as { port: number };
    baseUrl = `http://127.0.0.1:${newAddr.port}`;
  });

  it('CORS headers are set on API responses', async () => {
    const res = await fetch(`${baseUrl}/api/status`);
    expect(res.headers['access-control-allow-origin']).toBe('*');
    expect(res.headers['access-control-allow-methods']).toContain('GET');
  });
});
