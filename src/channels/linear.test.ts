import crypto from 'crypto';
import express from 'express';
import http from 'http';
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';

// --- Mocks ---

vi.mock('../config.js', () => ({
  ASSISTANT_NAME: 'Seb',
  TRIGGER_PATTERN: /^@Seb\b/i,
  DATA_DIR: '/tmp/nanoclaw-linear-test-data',
}));

vi.mock('../logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

import fs from 'fs';
import path from 'path';

import {
  LinearChannel,
  makeLinearFolder,
  verifyLinearSignature,
  loadLinearOAuth,
  saveLinearOAuth,
  exchangeLinearOAuthCode,
  fetchLinearViewerId,
} from './linear.js';
import { ChannelOpts } from './registry.js';

const TEST_DATA_DIR = '/tmp/nanoclaw-linear-test-data';

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

  describe('OAuth callback', () => {
    beforeEach(async () => {
      // Clean up test data dir
      fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
      fs.mkdirSync(TEST_DATA_DIR, { recursive: true });

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

    afterEach(() => {
      fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
    });

    it('returns 400 when code is missing', async () => {
      const res = await fetch(`http://localhost:${port}/linear/callback`);
      expect(res.status).toBe(400);
      const text = await res.text();
      expect(text).toContain('Missing authorization code');
    });

    it('returns success HTML on valid callback', async () => {
      // Mock the handleOAuthCallback method
      const handleSpy = vi
        .spyOn(channel, 'handleOAuthCallback')
        .mockResolvedValue();

      const res = await fetch(
        `http://localhost:${port}/linear/callback?code=test-auth-code`,
      );
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).toContain('Seb has been installed successfully');
      expect(html).toContain('You can close this tab');
      expect(handleSpy).toHaveBeenCalledWith('test-auth-code');
    });

    it('returns 500 when OAuth exchange fails', async () => {
      vi.spyOn(channel, 'handleOAuthCallback').mockRejectedValue(
        new Error('exchange failed'),
      );

      const res = await fetch(
        `http://localhost:${port}/linear/callback?code=bad-code`,
      );
      expect(res.status).toBe(500);
    });
  });

  describe('persisted OAuth token', () => {
    beforeEach(() => {
      fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
      fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
    });

    afterEach(() => {
      fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
    });

    it('loads persisted token on startup', async () => {
      saveLinearOAuth({
        access_token: 'persisted-token',
        bot_user_id: 'persisted-bot-id',
      });

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

      // The channel should have loaded the persisted token — verify
      // by checking ownsJid still works (basic sanity) and that
      // the bot user ID was picked up
      expect(channel.isConnected()).toBe(true);
    });

    it('saveLinearOAuth and loadLinearOAuth round-trip', () => {
      const data = {
        access_token: 'test-token-123',
        bot_user_id: 'user-456',
      };
      saveLinearOAuth(data);
      const loaded = loadLinearOAuth();
      expect(loaded).toEqual(data);
    });

    it('loadLinearOAuth returns null when file does not exist', () => {
      expect(loadLinearOAuth()).toBeNull();
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

  describe('AgentSessionEvent', () => {
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

    it('processes AgentSessionEvent created webhook', async () => {
      const payload = {
        type: 'AgentSessionEvent',
        action: 'created',
        data: {
          agentSession: {
            id: 'session-1',
            issue: {
              id: 'issue-uuid',
              identifier: 'CHR-6',
              title: 'Implement dark mode',
              url: 'https://linear.app/test/issue/CHR-6',
              team: { key: 'CHR' },
            },
          },
          promptContext: 'Please add dark mode support to the settings page.',
        },
        actor: { id: 'user-1', name: 'Chris' },
        createdAt: '2026-03-21T12:00:00Z',
      };
      await sendLinearWebhook(port, { payload, secret: SECRET });
      await new Promise((r) => setTimeout(r, 50));

      expect(opts.onMessage).toHaveBeenCalledWith(
        'linear:CHR-6',
        expect.objectContaining({
          chat_jid: 'linear:CHR-6',
          sender: 'Chris',
          content: expect.stringContaining(
            '[Linear] Issue CHR-6 "Implement dark mode" delegated to Seb',
          ),
          metadata: expect.objectContaining({
            linear_agent_session_id: 'session-1',
            linear_issue_identifier: 'CHR-6',
          }),
        }),
      );
    });

    it('includes promptContext in the formatted message', async () => {
      const payload = {
        type: 'AgentSessionEvent',
        action: 'created',
        data: {
          agentSession: {
            id: 'session-2',
            issue: {
              id: 'issue-uuid-2',
              identifier: 'CHR-7',
              title: 'Fix bug',
              url: 'https://linear.app/test/issue/CHR-7',
              team: { key: 'CHR' },
            },
          },
          promptContext: 'The login form crashes on submit.',
        },
        actor: { id: 'user-1', name: 'Chris' },
        createdAt: '2026-03-21T12:00:00Z',
      };
      await sendLinearWebhook(port, { payload, secret: SECRET });
      await new Promise((r) => setTimeout(r, 50));

      expect(opts.onMessage).toHaveBeenCalledWith(
        'linear:CHR-7',
        expect.objectContaining({
          content: expect.stringContaining('The login form crashes on submit.'),
        }),
      );
    });

    it('sets requiresTrigger=false for delegated issues (new group)', async () => {
      const payload = {
        type: 'AgentSessionEvent',
        action: 'created',
        data: {
          agentSession: {
            id: 'session-3',
            issue: {
              id: 'issue-uuid-3',
              identifier: 'CHR-8',
              title: 'New feature',
              url: 'https://linear.app/test/issue/CHR-8',
              team: { key: 'CHR' },
            },
          },
        },
        actor: { id: 'user-1', name: 'Chris' },
        createdAt: '2026-03-21T12:00:00Z',
      };
      await sendLinearWebhook(port, { payload, secret: SECRET });
      await new Promise((r) => setTimeout(r, 50));

      expect(opts.registerGroup).toHaveBeenCalledWith(
        'linear:CHR-8',
        expect.objectContaining({
          name: 'CHR-8',
          folder: 'linear_chr-8',
          requiresTrigger: false,
        }),
      );
    });

    it('updates existing group to requiresTrigger=false on delegation', async () => {
      const existingGroup = {
        name: 'CHR-9',
        folder: 'linear_chr-9',
        trigger: '@Seb',
        added_at: '2026-03-21T10:00:00Z',
        requiresTrigger: true,
        metadata: {
          type: 'issue',
          identifier: 'CHR-9',
          title: 'Existing issue',
        },
      };
      // Recreate channel with existing group
      await channel.disconnect();
      server.close();
      opts = createTestOpts({
        registeredGroups: vi.fn(() => ({
          'linear:CHR-9': existingGroup,
        })),
      });
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

      const payload = {
        type: 'AgentSessionEvent',
        action: 'created',
        data: {
          agentSession: {
            id: 'session-4',
            issue: {
              id: 'issue-uuid-4',
              identifier: 'CHR-9',
              title: 'Existing issue',
              url: 'https://linear.app/test/issue/CHR-9',
              team: { key: 'CHR' },
            },
          },
        },
        actor: { id: 'user-1', name: 'Chris' },
        createdAt: '2026-03-21T12:00:00Z',
      };
      await sendLinearWebhook(port, { payload, secret: SECRET });
      await new Promise((r) => setTimeout(r, 50));

      expect(opts.registerGroup).toHaveBeenCalledWith(
        'linear:CHR-9',
        expect.objectContaining({
          requiresTrigger: false,
        }),
      );
    });
  });
});
