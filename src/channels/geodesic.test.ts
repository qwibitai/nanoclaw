import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import http from 'http';

// --- Mocks ---

vi.mock('./registry.js', () => ({ registerChannel: vi.fn() }));

vi.mock('../config.js', () => ({
  ASSISTANT_NAME: 'Andy',
  TRIGGER_PATTERN: /^@Andy\b/i,
}));

vi.mock('../logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('../db.js', () => ({
  updateChatName: vi.fn(),
}));

vi.mock('../env.js', () => ({
  readEnvFile: vi.fn().mockReturnValue({
    GEODESIC_RELAY_PORT: '0', // port 0 = OS-assigned
    GEODESIC_ENDPOINT: 'https://test.example.com/gql',
    GEODESIC_DATA_TENANT: 'test-tenant-id',
    ANTHROPIC_API_KEY: 'test-api-key',
  }),
}));

import { GeodesicChannel } from './geodesic.js';
import { registerChannel } from './registry.js';

// --- Test helpers ---

const TEST_CREDS = {
  GRAPHQL_AUTH_TENANT_ID: 'test-tenant',
  GRAPHQL_AUTH_CLIENT_ID: 'test-client-id',
  GRAPHQL_AUTH_CLIENT_SECRET: 'test-secret',
  GRAPHQL_AUTH_SCOPE: 'api://test-scope',
};

function createTestOpts() {
  return {
    onMessage: vi.fn(),
    onChatMetadata: vi.fn(),
    registeredGroups: vi.fn(() => ({
      'geodesic:workspace-123': {
        name: 'geodesic-copilot',
        folder: 'geodesic-copilot',
        trigger: '',
        added_at: '2024-01-01T00:00:00.000Z',
        requiresTrigger: false,
      },
    })),
  };
}

function getChannelPort(channel: GeodesicChannel): number {
  // Access the private server to get the assigned port
  const server = (channel as any).server as http.Server;
  const addr = server.address();
  return typeof addr === 'object' && addr ? addr.port : 0;
}

async function postJson(
  port: number,
  path: string,
  body: Record<string, unknown>,
): Promise<{ status: number; body: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(data),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          const responseBody = JSON.parse(Buffer.concat(chunks).toString());
          resolve({ status: res.statusCode || 0, body: responseBody });
        });
      },
    );
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

async function getJson(
  port: number,
  path: string,
): Promise<{ status: number; body: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path,
        method: 'GET',
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          const responseBody = JSON.parse(Buffer.concat(chunks).toString());
          resolve({ status: res.statusCode || 0, body: responseBody });
        });
      },
    );
    req.on('error', reject);
    req.end();
  });
}

// --- Tests ---

describe('GeodesicChannel registration', () => {
  it('registerChannel is called with "geodesic"', () => {
    // registerChannel is called at module load time (import './geodesic.js')
    // so we check before any beforeEach/clearAllMocks runs
    expect(registerChannel).toHaveBeenCalledWith(
      'geodesic',
      expect.any(Function),
    );
  });
});

describe('GeodesicChannel', () => {
  let channel: GeodesicChannel;
  let opts: ReturnType<typeof createTestOpts>;
  let port: number;

  beforeEach(async () => {
    vi.clearAllMocks();
    // Mock fetch globally to prevent real network calls
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          access_token: 'mock-token',
          expires_in: 3600,
          content: [{ text: 'NO' }],
        }),
        text: async () => '{}',
        status: 200,
      }),
    );

    opts = createTestOpts();
    channel = new GeodesicChannel(opts, TEST_CREDS);
    await channel.connect();
    port = getChannelPort(channel);
  });

  afterEach(async () => {
    await channel.disconnect();
    vi.unstubAllGlobals();
  });

  // --- Connection lifecycle ---

  describe('connection lifecycle', () => {
    it('connect() starts HTTP server', () => {
      expect(channel.isConnected()).toBe(true);
    });

    it('disconnect() stops HTTP server', async () => {
      await channel.disconnect();
      expect(channel.isConnected()).toBe(false);
    });

    it('isConnected() returns false before connect', () => {
      const fresh = new GeodesicChannel(createTestOpts(), TEST_CREDS);
      expect(fresh.isConnected()).toBe(false);
    });
  });

  // --- ownsJid ---

  describe('ownsJid', () => {
    it('owns geodesic: JIDs', () => {
      expect(channel.ownsJid('geodesic:workspace-123')).toBe(true);
    });

    it('does not own slack: JIDs', () => {
      expect(channel.ownsJid('slack:C0123456789')).toBe(false);
    });

    it('does not own WhatsApp JIDs', () => {
      expect(channel.ownsJid('12345@g.us')).toBe(false);
    });

    it('does not own unknown JID formats', () => {
      expect(channel.ownsJid('random-string')).toBe(false);
    });
  });

  // --- Health endpoint ---

  describe('GET /health', () => {
    it('returns status ok with no active conversations', async () => {
      const resp = await getJson(port, '/health');

      expect(resp.status).toBe(200);
      expect(resp.body).toEqual({
        status: 'ok',
        active_conversations: 0,
        workspaces: [],
      });
    });
  });

  // --- 404 for unknown routes ---

  describe('unknown routes', () => {
    it('returns 404 for unknown paths', async () => {
      const resp = await getJson(port, '/unknown');
      expect(resp.status).toBe(404);
    });
  });

  // --- POST /v1/start_run ---

  describe('POST /v1/start_run', () => {
    it('returns 400 when required fields are missing', async () => {
      const resp = await postJson(port, '/v1/start_run', { prompt: 'test' });
      expect(resp.status).toBe(400);
    });

    it('injects message into NanoClaw on valid request', async () => {
      // Mock fetch: first call = intent classification, second = OAuth token, third = workflow_started
      const mockFetch = vi.fn()
        // Intent classification
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ content: [{ text: 'NO' }] }),
        })
        // OAuth token
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ access_token: 'tok', expires_in: 3600 }),
        })
        // workflow_started GraphQL
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ data: { appendScenarioRunLog: 1 } }),
          text: async () => '{}',
        })
        // SSE watcher token refresh
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ access_token: 'tok2', expires_in: 3600 }),
        })
        // SSE connection itself
        .mockResolvedValueOnce({
          ok: false,
          status: 404,
          body: null,
        });

      vi.stubGlobal('fetch', mockFetch);

      const resp = await postJson(port, '/v1/start_run', {
        runId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
        workspaceId: 'workspace-123',
        tenantId: 'tenant-456',
        prompt: 'How many prescriptions are there?',
      });

      expect(resp.status).toBe(200);
      expect(resp.body.status).toBe('hook_delivered');

      // Verify message was injected
      expect(opts.onMessage).toHaveBeenCalledWith(
        'geodesic:workspace-123',
        expect.objectContaining({
          chat_jid: 'geodesic:workspace-123',
          sender_name: 'Geodesic User',
          is_from_me: false,
        }),
      );

      // Verify metadata was reported
      expect(opts.onChatMetadata).toHaveBeenCalledWith(
        'geodesic:workspace-123',
        expect.any(String),
        expect.stringContaining('Geodesic'),
        'geodesic',
        true,
      );
    });

    it('accepts camelCase field names', async () => {
      const resp = await postJson(port, '/v1/start_run', {
        runId: 'run-id-123',
        workspaceId: 'ws-123',
        tenantId: 'tenant-123',
        prompt: 'Test prompt',
      });

      expect(resp.status).toBe(200);
    });

    it('accepts snake_case field names', async () => {
      const resp = await postJson(port, '/v1/start_run', {
        run_id: 'run-id-123',
        workspace_id: 'ws-123',
        tenant_id: 'tenant-123',
        prompt: 'Test prompt',
      });

      expect(resp.status).toBe(200);
    });
  });

  // --- sendMessage ---

  describe('sendMessage', () => {
    it('drops message when no active conversation', async () => {
      // No active conversation for this workspace
      await channel.sendMessage('geodesic:no-such-workspace', 'Hello');

      // Should not throw, just warn
      const { logger } = await import('../logger.js');
      expect(logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ jid: 'geodesic:no-such-workspace' }),
        expect.stringContaining('No active Geodesic conversation'),
      );
    });

    it('posts to Geodesic GraphQL when conversation is active', async () => {
      // First set up an active conversation by making a start_run call
      const mockFetch = vi.fn()
        .mockResolvedValue({
          ok: true,
          json: async () => ({
            access_token: 'tok',
            expires_in: 3600,
            content: [{ text: 'NO' }],
            data: { appendScenarioRunLog: 1 },
          }),
          text: async () => '{}',
          status: 200,
          body: null,
        });
      vi.stubGlobal('fetch', mockFetch);

      await postJson(port, '/v1/start_run', {
        runId: 'run-for-send',
        workspaceId: 'ws-for-send',
        tenantId: 'tenant-for-send',
        prompt: 'test',
      });

      // Reset mock to track sendMessage calls specifically
      mockFetch.mockClear();
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({
          access_token: 'tok',
          expires_in: 3600,
          data: { appendScenarioRunLog: 2 },
        }),
        text: async () => '{}',
      });

      await channel.sendMessage('geodesic:ws-for-send', 'Agent response text');

      // Should have called fetch for OAuth + GraphQL mutation
      expect(mockFetch).toHaveBeenCalled();
    });
  });

  // --- POST /v1/report_ready ---

  describe('POST /v1/report_ready', () => {
    it('accepts report_ready and returns ok', async () => {
      const resp = await postJson(port, '/v1/report_ready', {
        run_id: 'run-123',
        workspace_id: 'ws-123',
        data_file: '/tmp/test.json',
      });

      expect(resp.status).toBe(200);
      expect(resp.body.ok).toBe(true);
    });
  });

  // --- setTyping ---

  describe('setTyping', () => {
    it('resolves without error (no-op)', async () => {
      await expect(
        channel.setTyping('geodesic:ws-123', true),
      ).resolves.toBeUndefined();
    });
  });

  // --- Channel properties ---

  describe('channel properties', () => {
    it('has name "geodesic"', () => {
      expect(channel.name).toBe('geodesic');
    });
  });
});
