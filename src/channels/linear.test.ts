import crypto from 'crypto';
import express from 'express';
import http from 'http';
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';

// --- Mocks ---

vi.mock('../config.js', () => ({
  ASSISTANT_NAME: 'Seb',
  TRIGGER_PATTERN: /^@Seb\b/i,
}));

vi.mock('../logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

import {
  LinearChannel,
  makeLinearFolder,
  verifyLinearSignature,
} from './linear.js';
import { ChannelOpts } from './registry.js';

// --- Test helpers ---

function createApp(): express.Application {
  return express();
}

function startServer(
  app: express.Application,
): Promise<{ server: http.Server; port: number }> {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, () => {
      const addr = server.address() as import('net').AddressInfo;
      resolve({ server, port: addr.port });
    });
    server.on('error', reject);
  });
}

function createTestOpts(overrides?: Partial<ChannelOpts>): ChannelOpts {
  const app = createApp();
  return {
    app,
    onMessage: vi.fn(),
    onChatMetadata: vi.fn(),
    registeredGroups: vi.fn(() => ({})),
    registerGroup: vi.fn(),
    ...overrides,
  };
}

function signLinear(secret: string, payload: string): string {
  return crypto.createHmac('sha256', secret).update(payload).digest('hex');
}

async function sendLinearWebhook(
  port: number,
  opts: {
    payload: any;
    secret: string;
    deliveryId?: string;
    skipSignature?: boolean;
  },
): Promise<Response> {
  const body = JSON.stringify(opts.payload);
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'Linear-Delivery': opts.deliveryId || 'test-delivery-1',
    'Linear-Event': opts.payload.type || 'Issue',
  };
  if (!opts.skipSignature) {
    headers['Linear-Signature'] = signLinear(opts.secret, body);
  }
  return fetch(`http://localhost:${port}/linear/webhook`, {
    method: 'POST',
    headers,
    body,
  });
}

// --- makeLinearFolder ---

describe('makeLinearFolder', () => {
  it('creates folder from issue identifier', () => {
    expect(makeLinearFolder('ENG-123')).toBe('linear_eng-123');
  });

  it('lowercases the identifier', () => {
    expect(makeLinearFolder('TEAM-456')).toBe('linear_team-456');
  });

  it('strips non-alphanumeric characters except hyphens', () => {
    expect(makeLinearFolder('MY.TEAM-789')).toBe('linear_myteam-789');
  });

  it('truncates long identifiers to fit 64-char limit', () => {
    const longId = 'A'.repeat(100) + '-1';
    const folder = makeLinearFolder(longId);
    expect(folder.length).toBeLessThanOrEqual(64);
    expect(folder).toMatch(/^linear_/);
  });

  it('always starts with linear_ prefix', () => {
    expect(makeLinearFolder('X-1')).toMatch(/^linear_/);
  });
});

// --- verifyLinearSignature ---

describe('verifyLinearSignature', () => {
  const secret = 'test-secret';

  it('returns true for valid signature', () => {
    const payload = '{"test": true}';
    const sig = signLinear(secret, payload);
    expect(verifyLinearSignature(secret, payload, sig)).toBe(true);
  });

  it('returns false for invalid signature', () => {
    expect(verifyLinearSignature(secret, '{"test": true}', 'bad-sig')).toBe(
      false,
    );
  });

  it('returns false for wrong secret', () => {
    const payload = '{"test": true}';
    const sig = signLinear('wrong-secret', payload);
    expect(verifyLinearSignature(secret, payload, sig)).toBe(false);
  });

  it('returns false for tampered payload', () => {
    const sig = signLinear(secret, '{"original": true}');
    expect(verifyLinearSignature(secret, '{"tampered": true}', sig)).toBe(
      false,
    );
  });
});

// --- LinearChannel ---

describe('LinearChannel', () => {
  const SECRET = 'test-webhook-secret';
  let port: number;
  let server: http.Server;
  let channel: LinearChannel;
  let opts: ChannelOpts;

  afterEach(async () => {
    if (channel?.isConnected()) {
      await channel.disconnect();
    }
    if (server) server.close();
  });

  describe('webhook server', () => {
    beforeEach(async () => {
      opts = createTestOpts();
      channel = new LinearChannel(
        SECRET,
        'test-client-id',
        'test-client-secret',
        '',
        opts,
      );
      await channel.connect();
      const result = await startServer(opts.app!);
      server = result.server;
      port = result.port;
    });

    it('responds to webhook POST', async () => {
      const payload = {
        type: 'Issue',
        action: 'create',
        data: {
          identifier: 'ENG-1',
          title: 'Test',
          url: 'https://linear.app/test/issue/ENG-1',
        },
        actor: { id: 'user-1', name: 'Chris' },
      };
      const res = await sendLinearWebhook(port, { payload, secret: SECRET });
      expect(res.status).toBe(200);
    });

    it('rejects requests without signature', async () => {
      const res = await sendLinearWebhook(port, {
        payload: { type: 'Issue', action: 'create', data: {} },
        secret: SECRET,
        skipSignature: true,
      });
      expect(res.status).toBe(400);
    });

    it('rejects requests with invalid signature', async () => {
      const body = JSON.stringify({
        type: 'Issue',
        action: 'create',
        data: {},
      });
      const res = await fetch(`http://localhost:${port}/linear/webhook`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Linear-Signature': 'invalid-signature',
          'Linear-Event': 'Issue',
        },
        body,
      });
      expect(res.status).toBe(401);
    });

    it('acknowledges valid webhook with 200', async () => {
      const res = await sendLinearWebhook(port, {
        payload: {
          type: 'Issue',
          action: 'create',
          data: {
            identifier: 'ENG-1',
            title: 'Test',
            url: 'https://linear.app/test/issue/ENG-1',
          },
          actor: { id: 'user-1', name: 'Chris' },
        },
        secret: SECRET,
      });
      expect(res.status).toBe(200);
    });

    it('processes Issue create event', async () => {
      const payload = {
        type: 'Issue',
        action: 'create',
        data: {
          identifier: 'ENG-42',
          title: 'Fix login bug',
          priority: 2,
          url: 'https://linear.app/test/issue/ENG-42',
          team: { key: 'ENG' },
        },
        actor: { id: 'user-1', name: 'Chris' },
        createdAt: '2026-03-21T12:00:00Z',
      };
      await sendLinearWebhook(port, { payload, secret: SECRET });

      // Wait for async processing
      await new Promise((r) => setTimeout(r, 50));

      expect(opts.onMessage).toHaveBeenCalledWith(
        'linear:ENG-42',
        expect.objectContaining({
          chat_jid: 'linear:ENG-42',
          sender: 'Chris',
          content: expect.stringContaining('[Linear] Issue created: ENG-42'),
        }),
      );
    });

    it('processes Comment create event', async () => {
      const payload = {
        type: 'Comment',
        action: 'create',
        data: {
          id: 'comment-1',
          body: 'Can you also fix the edge case?',
          url: 'https://linear.app/test/issue/ENG-42#comment-1',
          issue: {
            id: 'issue-uuid',
            identifier: 'ENG-42',
            title: 'Fix login bug',
          },
        },
        actor: { id: 'user-1', name: 'Chris' },
        createdAt: '2026-03-21T12:00:00Z',
      };
      await sendLinearWebhook(port, { payload, secret: SECRET });
      await new Promise((r) => setTimeout(r, 50));

      expect(opts.onMessage).toHaveBeenCalledWith(
        'linear:ENG-42',
        expect.objectContaining({
          chat_jid: 'linear:ENG-42',
          sender: 'Chris',
          content: expect.stringContaining('Can you also fix the edge case?'),
          metadata: expect.objectContaining({
            linear_comment_id: 'comment-1',
            linear_issue_identifier: 'ENG-42',
          }),
        }),
      );
    });

    it('skips unsupported event types', async () => {
      const payload = {
        type: 'Project',
        action: 'update',
        data: { id: 'project-1' },
        actor: { id: 'user-1', name: 'Chris' },
      };
      await sendLinearWebhook(port, { payload, secret: SECRET });
      await new Promise((r) => setTimeout(r, 50));

      expect(opts.onMessage).not.toHaveBeenCalled();
    });
  });

  describe('auto-registration', () => {
    beforeEach(async () => {
      opts = createTestOpts();
      channel = new LinearChannel(
        SECRET,
        'test-client-id',
        'test-client-secret',
        '',
        opts,
      );
      await channel.connect();
      const result = await startServer(opts.app!);
      server = result.server;
      port = result.port;
    });

    it('auto-registers a group for new issues', async () => {
      const payload = {
        type: 'Issue',
        action: 'create',
        data: {
          identifier: 'ENG-10',
          title: 'New feature',
          url: 'https://linear.app/test/issue/ENG-10',
          team: { key: 'ENG' },
        },
        actor: { id: 'user-1', name: 'Chris' },
      };
      await sendLinearWebhook(port, { payload, secret: SECRET });
      await new Promise((r) => setTimeout(r, 50));

      expect(opts.registerGroup).toHaveBeenCalledWith(
        'linear:ENG-10',
        expect.objectContaining({
          name: 'ENG-10',
          folder: 'linear_eng-10',
          trigger: '@Seb',
          requiresTrigger: true,
          metadata: expect.objectContaining({
            type: 'issue',
            title: 'New feature',
            identifier: 'ENG-10',
            team: 'ENG',
          }),
        }),
      );
    });

    it('sets requiresTrigger=false when assigned to bot', async () => {
      const botUserId = 'bot-user-123';
      await channel.disconnect();
      server.close();
      opts = createTestOpts();
      channel = new LinearChannel(
        SECRET,
        'test-client-id',
        'test-client-secret',
        botUserId,
        opts,
      );
      await channel.connect();
      const result = await startServer(opts.app!);
      server = result.server;
      port = result.port;

      const payload = {
        type: 'Issue',
        action: 'update',
        data: {
          identifier: 'ENG-20',
          title: 'Assigned to bot',
          url: 'https://linear.app/test/issue/ENG-20',
          assignee: { id: botUserId, name: 'Seb' },
          team: { key: 'ENG' },
        },
        actor: { id: 'user-1', name: 'Chris' },
      };
      await sendLinearWebhook(port, { payload, secret: SECRET });
      await new Promise((r) => setTimeout(r, 50));

      expect(opts.registerGroup).toHaveBeenCalledWith(
        'linear:ENG-20',
        expect.objectContaining({
          requiresTrigger: false,
        }),
      );
    });
  });

  describe('bot event filtering', () => {
    it('skips events triggered by the bot itself', async () => {
      const botUserId = 'bot-user-123';
      opts = createTestOpts();
      channel = new LinearChannel(
        SECRET,
        'test-client-id',
        'test-client-secret',
        botUserId,
        opts,
      );
      await channel.connect();
      const result = await startServer(opts.app!);
      server = result.server;
      port = result.port;

      const payload = {
        type: 'Comment',
        action: 'create',
        data: {
          id: 'comment-1',
          body: 'Bot comment',
          issue: { id: 'issue-1', identifier: 'ENG-1' },
        },
        actor: { id: botUserId, name: 'Seb' },
      };
      await sendLinearWebhook(port, { payload, secret: SECRET });
      await new Promise((r) => setTimeout(r, 50));

      expect(opts.onMessage).not.toHaveBeenCalled();
    });
  });

  describe('team filtering', () => {
    it('skips events from non-allowed teams', async () => {
      opts = createTestOpts();
      channel = new LinearChannel(
        SECRET,
        'test-client-id',
        'test-client-secret',
        '',
        opts,
        ['ENG'],
      );
      await channel.connect();
      const result = await startServer(opts.app!);
      server = result.server;
      port = result.port;

      const payload = {
        type: 'Issue',
        action: 'create',
        data: {
          identifier: 'DESIGN-5',
          title: 'Design issue',
          team: { key: 'DESIGN' },
        },
        actor: { id: 'user-1', name: 'Chris' },
      };
      await sendLinearWebhook(port, { payload, secret: SECRET });
      await new Promise((r) => setTimeout(r, 50));

      expect(opts.onMessage).not.toHaveBeenCalled();
    });

    it('processes events from allowed teams', async () => {
      opts = createTestOpts();
      channel = new LinearChannel(
        SECRET,
        'test-client-id',
        'test-client-secret',
        '',
        opts,
        ['ENG'],
      );
      await channel.connect();
      const result = await startServer(opts.app!);
      server = result.server;
      port = result.port;

      const payload = {
        type: 'Issue',
        action: 'create',
        data: {
          identifier: 'ENG-99',
          title: 'Eng issue',
          url: 'https://linear.app/test/issue/ENG-99',
          team: { key: 'ENG' },
        },
        actor: { id: 'user-1', name: 'Chris' },
      };
      await sendLinearWebhook(port, { payload, secret: SECRET });
      await new Promise((r) => setTimeout(r, 50));

      expect(opts.onMessage).toHaveBeenCalled();
    });
  });

  describe('ownsJid', () => {
    beforeEach(() => {
      opts = createTestOpts();
      channel = new LinearChannel(SECRET, '', '', '', opts);
    });

    it('returns true for linear: JIDs', () => {
      expect(channel.ownsJid('linear:ENG-123')).toBe(true);
    });

    it('returns false for non-linear JIDs', () => {
      expect(channel.ownsJid('gh:cmraible/seb#1')).toBe(false);
      expect(channel.ownsJid('tg:-1001234')).toBe(false);
    });
  });

  describe('assignment changes', () => {
    it('updates requiresTrigger when issue is reassigned to bot', async () => {
      const botUserId = 'bot-user-123';
      const existingGroup = {
        name: 'ENG-30',
        folder: 'linear_eng-30',
        trigger: '@Seb',
        added_at: '2026-03-21T12:00:00Z',
        requiresTrigger: true,
        metadata: { type: 'issue', identifier: 'ENG-30', title: 'Old issue' },
      };
      opts = createTestOpts({
        registeredGroups: vi.fn(() => ({
          'linear:ENG-30': existingGroup,
        })),
      });
      channel = new LinearChannel(
        SECRET,
        'test-client-id',
        'test-client-secret',
        botUserId,
        opts,
      );
      await channel.connect();
      const result = await startServer(opts.app!);
      server = result.server;
      port = result.port;

      const payload = {
        type: 'Issue',
        action: 'update',
        data: {
          identifier: 'ENG-30',
          title: 'Old issue',
          assignee: { id: botUserId, name: 'Seb' },
          team: { key: 'ENG' },
          url: 'https://linear.app/test/issue/ENG-30',
        },
        actor: { id: 'user-1', name: 'Chris' },
      };
      await sendLinearWebhook(port, { payload, secret: SECRET });
      await new Promise((r) => setTimeout(r, 50));

      expect(opts.registerGroup).toHaveBeenCalledWith(
        'linear:ENG-30',
        expect.objectContaining({
          requiresTrigger: false,
        }),
      );
    });
  });
});
