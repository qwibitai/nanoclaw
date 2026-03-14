/**
 * Smoke tests for the add-corsair skill source files.
 * Run from the skill directory: npx vitest run .claude/skills/add-corsair/tests/corsair.test.ts
 *
 * These tests verify that the skill files are structurally correct and export
 * the expected symbols. All external dependencies are mocked.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mock external dependencies ────────────────────────────────────────────────

vi.mock('better-sqlite3', () => {
  const stmt = { all: vi.fn(() => []), get: vi.fn(() => undefined), run: vi.fn(), prepare: vi.fn() };
  const db = { prepare: vi.fn(() => stmt), close: vi.fn() };
  return { default: vi.fn(() => db) };
});

vi.mock('corsair', () => ({
  createCorsair: vi.fn(() => ({
    list_operations: vi.fn(() => []),
    get_schema: vi.fn(() => ({})),
  })),
  processWebhook: vi.fn(),
  executePermission: vi.fn(() => Promise.resolve({ result: 'ok' })),
}));

vi.mock('express', () => {
  const app = {
    use: vi.fn(),
    get: vi.fn(),
    post: vi.fn(),
    listen: vi.fn((_port: number, cb?: () => void) => { cb?.(); return app; }),
  };
  const express = vi.fn(() => app) as unknown as typeof import('express') & { json: typeof vi.fn; raw: typeof vi.fn };
  (express as any).json = vi.fn(() => vi.fn());
  (express as any).raw = vi.fn(() => vi.fn());
  return { default: express };
});

vi.mock('@modelcontextprotocol/sdk/server/mcp.js', () => ({
  McpServer: vi.fn(() => ({
    tool: vi.fn(),
    connect: vi.fn(),
  })),
}));

vi.mock('@modelcontextprotocol/sdk/server/sse.js', () => ({
  SSEServerTransport: vi.fn(() => ({
    sessionId: 'test-session',
    handlePostMessage: vi.fn(),
  })),
}));

vi.mock('zod', () => {
  const schema = { optional: vi.fn(() => schema), describe: vi.fn(() => schema) };
  return {
    z: {
      string: vi.fn(() => schema),
      enum: vi.fn(() => schema),
      record: vi.fn(() => schema),
      unknown: vi.fn(() => schema),
    },
  };
});

// Mock NanoClaw internal modules
vi.mock('../add/src/config.js', () => ({
  DATA_DIR: '/tmp/test-data',
  STORE_DIR: '/tmp/test-store',
  MAIN_GROUP_FOLDER: 'main',
}));

vi.mock('../add/src/db.js', () => ({
  getAllRegisteredGroups: vi.fn(() => ({})),
}));

vi.mock('../add/src/logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

// Mock fs to prevent real filesystem operations
vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return {
    ...actual,
    mkdirSync: vi.fn(),
    writeFileSync: vi.fn(),
    readFileSync: vi.fn(() => '[]'),
    existsSync: vi.fn(() => false),
    unlinkSync: vi.fn(),
  };
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('src/corsair.ts', () => {
  it('exports db and corsair', async () => {
    const mod = await import('../add/src/corsair.js');
    expect(mod).toHaveProperty('db');
    expect(mod).toHaveProperty('corsair');
  });

  it('corsair has expected methods', async () => {
    const { corsair } = await import('../add/src/corsair.js');
    expect(typeof corsair.list_operations).toBe('function');
    expect(typeof corsair.get_schema).toBe('function');
  });
});

describe('src/corsair-mcp.ts', () => {
  it('exports required functions', async () => {
    const mod = await import('../add/src/corsair-mcp.js');
    expect(typeof mod.writeIpcMessage).toBe('function');
    expect(typeof mod.writeIpcTask).toBe('function');
    expect(typeof mod.triggerWebhookListeners).toBe('function');
    expect(typeof mod.startPermissionPoller).toBe('function');
    expect(typeof mod.startCorsairMcpServer).toBe('function');
  });

  it('writeIpcMessage writes a file', async () => {
    const fs = await import('fs');
    const { writeIpcMessage } = await import('../add/src/corsair-mcp.js');
    writeIpcMessage('main', 'test@jid', 'hello');
    expect(fs.mkdirSync).toHaveBeenCalled();
    expect(fs.writeFileSync).toHaveBeenCalled();
  });

  it('writeIpcTask writes a schedule_task file', async () => {
    const fs = await import('fs');
    const { writeIpcTask } = await import('../add/src/corsair-mcp.js');
    writeIpcTask('test@jid', 'do something');
    const written = vi.mocked(fs.writeFileSync).mock.calls.at(-1)?.[1] as string;
    const parsed = JSON.parse(written);
    expect(parsed.type).toBe('schedule_task');
    expect(parsed.prompt).toBe('do something');
  });

  it('triggerWebhookListeners is a no-op when no listeners registered', async () => {
    const { triggerWebhookListeners } = await import('../add/src/corsair-mcp.js');
    // Should not throw
    expect(() => triggerWebhookListeners('slack', { event: 'test' })).not.toThrow();
  });

  it('startCorsairMcpServer starts without throwing', async () => {
    const { startCorsairMcpServer } = await import('../add/src/corsair-mcp.js');
    expect(() => startCorsairMcpServer(4002)).not.toThrow();
  });
});

describe('src/corsair-webhooks.ts', () => {
  it('exports startCorsairWebhookServer', async () => {
    const mod = await import('../add/src/corsair-webhooks.js');
    expect(typeof mod.startCorsairWebhookServer).toBe('function');
  });

  it('startCorsairWebhookServer starts without throwing', async () => {
    const { startCorsairWebhookServer } = await import('../add/src/corsair-webhooks.js');
    expect(() => startCorsairWebhookServer(4001)).not.toThrow();
  });

  it('registers /webhooks/:plugin, GET /api/permission/:token, POST /api/permission/:token', async () => {
    const express = (await import('express')).default;
    const app = express();
    const { startCorsairWebhookServer } = await import('../add/src/corsair-webhooks.js');
    startCorsairWebhookServer(4001);

    const routes = vi.mocked(app.post).mock.calls.map(c => c[0]);
    expect(routes).toContain('/webhooks/:plugin');
    expect(routes).toContain('/api/permission/:token');

    const getRoutes = vi.mocked(app.get).mock.calls.map(c => c[0]);
    expect(getRoutes).toContain('/api/permission/:token');
  });
});
