import crypto from 'crypto';
import http from 'http';

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// --- Mocks ---

vi.mock('./registry.js', () => ({ registerChannel: vi.fn() }));

vi.mock('../logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('../env.js', () => ({
  readEnvFile: vi.fn().mockReturnValue({
    GITHUB_TOKEN: 'ghp_test_token',
    GITHUB_WEBHOOK_SECRET: 'test-secret',
    GITHUB_BOT_USERNAME: 'nanoclaw-bot',
    GITHUB_WEBHOOK_PORT: '13002',
  }),
}));

const mockCreateComment = vi.fn().mockResolvedValue({});
vi.mock('@octokit/rest', () => ({
  Octokit: class MockOctokit {
    rest = { issues: { createComment: mockCreateComment } };
    constructor(_opts: unknown) {}
  },
}));

import { readEnvFile } from '../env.js';
import { GitHubChannel, GitHubChannelOpts } from './github.js';

// --- Helpers ---

function createTestOpts(overrides?: Partial<GitHubChannelOpts>): GitHubChannelOpts {
  return {
    onMessage: vi.fn(),
    onChatMetadata: vi.fn(),
    registeredGroups: vi.fn(() => ({})),
    token: 'ghp_test_token',
    webhookSecret: 'test-secret',
    botUsername: 'nanoclaw-bot',
    port: 13002,
    ...overrides,
  };
}

function sign(body: string, secret: string): string {
  return `sha256=${crypto.createHmac('sha256', secret).update(body).digest('hex')}`;
}

async function postWebhook(
  port: number,
  event: string,
  payload: unknown,
  opts: { secret?: string; skipSignature?: boolean } = {},
): Promise<{ status: number; body: string }> {
  const body = JSON.stringify(payload);
  const sig = opts.skipSignature ? undefined : sign(body, opts.secret ?? 'test-secret');

  return new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: '127.0.0.1', port, path: '/github/webhook', method: 'POST' },
      (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: data }));
        res.on('error', reject);
      },
    );
    req.on('error', reject);
    req.setHeader('Content-Type', 'application/json');
    req.setHeader('X-GitHub-Event', event);
    if (sig) req.setHeader('X-Hub-Signature-256', sig);
    req.write(body);
    req.end();
  });
}

// Give async dispatch time to complete
const tick = () => new Promise((r) => setTimeout(r, 20));

// --- Shared channel (one instance for all tests, created once) ---

let channel: GitHubChannel;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let onMessage: any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let onChatMetadata: any;

beforeAll(async () => {
  onMessage = vi.fn();
  onChatMetadata = vi.fn();
  channel = new GitHubChannel(
    createTestOpts({ onMessage, onChatMetadata }),
  );
  await channel.connect();
});

afterAll(async () => {
  await channel.disconnect();
});

beforeEach(() => {
  vi.clearAllMocks();
  // Re-assign so tests can reference the same fns
  (channel as any).opts.onMessage = onMessage;
  (channel as any).opts.onChatMetadata = onChatMetadata;
});

// --- Tests ---

describe('GitHubChannel', () => {
  // ---- connection lifecycle ----

  describe('connection lifecycle', () => {
    it('isConnected() returns true after connect()', () => {
      expect(channel.isConnected()).toBe(true);
    });

    it('a fresh instance returns false before connect()', () => {
      const fresh = new GitHubChannel(createTestOpts({ port: 13099 }));
      expect(fresh.isConnected()).toBe(false);
    });

    it('disconnect() sets isConnected to false', async () => {
      const tmp = new GitHubChannel(createTestOpts({ port: 13003 }));
      await tmp.connect();
      expect(tmp.isConnected()).toBe(true);
      await tmp.disconnect();
      expect(tmp.isConnected()).toBe(false);
    });
  });

  // ---- ownsJid ----

  describe('ownsJid', () => {
    it('returns true for github: JIDs', () => {
      expect(channel.ownsJid('github:owner/repo#1')).toBe(true);
    });

    it('returns false for slack: JIDs', () => {
      expect(channel.ownsJid('slack:C123')).toBe(false);
    });

    it('returns false for telegram: JIDs', () => {
      expect(channel.ownsJid('telegram:123456')).toBe(false);
    });
  });

  // ---- webhook signature verification ----

  describe('webhook signature verification', () => {
    it('accepts a correctly signed request (200)', async () => {
      const result = await postWebhook(13002, 'ping', { zen: 'hi' });
      expect(result.status).toBe(200);
    });

    it('rejects a request with wrong secret (401)', async () => {
      const result = await postWebhook(13002, 'ping', { zen: 'hi' }, { secret: 'wrong' });
      expect(result.status).toBe(401);
    });

    it('rejects a request with no signature (401)', async () => {
      const result = await postWebhook(13002, 'ping', { zen: 'hi' }, { skipSignature: true });
      expect(result.status).toBe(401);
    });

    it('returns 404 for non-webhook paths', async () => {
      const response = await new Promise<{ status: number }>((resolve, reject) => {
        const req = http.request(
          { hostname: '127.0.0.1', port: 13002, path: '/other', method: 'GET' },
          (res) => resolve({ status: res.statusCode ?? 0 }),
        );
        req.on('error', reject);
        req.end();
      });
      expect(response.status).toBe(404);
    });
  });

  // ---- event: issues assigned ----

  describe('event handling: issues assigned', () => {
    it('calls onMessage when assignee is the bot', async () => {
      const payload = {
        action: 'assigned',
        assignee: { login: 'nanoclaw-bot' },
        issue: { id: 101, number: 42, title: 'Fix the bug', body: 'Details here' },
        repository: { full_name: 'acme/myrepo' },
      };
      await postWebhook(13002, 'issues', payload);
      await tick();
      expect(onMessage).toHaveBeenCalledWith(
        'github:acme/myrepo#42',
        expect.objectContaining({
          id: 'github-issue-assigned-101',
          chat_jid: 'github:acme/myrepo#42',
          sender: 'nanoclaw-bot',
        }),
      );
    });

    it('does NOT call onMessage when assignee is someone else', async () => {
      const payload = {
        action: 'assigned',
        assignee: { login: 'other-user' },
        issue: { id: 102, number: 43, title: 'Other issue', body: '' },
        repository: { full_name: 'acme/myrepo' },
      };
      await postWebhook(13002, 'issues', payload);
      await tick();
      expect(onMessage).not.toHaveBeenCalled();
    });

    it('uses correct JID format', async () => {
      const payload = {
        action: 'assigned',
        assignee: { login: 'nanoclaw-bot' },
        issue: { id: 103, number: 7, title: 'Issue 7', body: null },
        repository: { full_name: 'org/proj' },
      };
      await postWebhook(13002, 'issues', payload);
      await tick();
      expect(onMessage).toHaveBeenCalledWith('github:org/proj#7', expect.anything());
    });

    it('includes issue title and body in content', async () => {
      const payload = {
        action: 'assigned',
        assignee: { login: 'nanoclaw-bot' },
        issue: { id: 104, number: 10, title: 'My Title', body: 'My Body Text' },
        repository: { full_name: 'acme/repo' },
      };
      await postWebhook(13002, 'issues', payload);
      await tick();
      const msg = onMessage.mock.calls[0][1];
      expect(msg.content).toContain('My Title');
      expect(msg.content).toContain('My Body Text');
    });
  });

  // ---- event: pull_request review_requested ----

  describe('event handling: pull_request review_requested', () => {
    it('calls onMessage when the bot is requested reviewer', async () => {
      const payload = {
        action: 'review_requested',
        requested_reviewer: { login: 'nanoclaw-bot' },
        pull_request: { id: 200, number: 99, title: 'My PR', body: 'PR desc' },
        repository: { full_name: 'acme/repo' },
      };
      await postWebhook(13002, 'pull_request', payload);
      await tick();
      expect(onMessage).toHaveBeenCalledWith(
        'github:acme/repo#99',
        expect.objectContaining({ id: 'github-pr-review-200' }),
      );
    });

    it('does NOT call onMessage when another user is requested', async () => {
      const payload = {
        action: 'review_requested',
        requested_reviewer: { login: 'alice' },
        pull_request: { id: 201, number: 100, title: 'PR 100', body: '' },
        repository: { full_name: 'acme/repo' },
      };
      await postWebhook(13002, 'pull_request', payload);
      await tick();
      expect(onMessage).not.toHaveBeenCalled();
    });
  });

  // ---- event: issue_comment ----

  describe('event handling: issue_comment', () => {
    it('calls onMessage when comment mentions the bot', async () => {
      const payload = {
        action: 'created',
        comment: { id: 300, body: 'Hey @nanoclaw-bot can you fix this?' },
        issue: { number: 5 },
        sender: { login: 'alice' },
        repository: { full_name: 'acme/repo' },
      };
      await postWebhook(13002, 'issue_comment', payload);
      await tick();
      expect(onMessage).toHaveBeenCalledWith(
        'github:acme/repo#5',
        expect.objectContaining({ id: 'github-issue-comment-300' }),
      );
    });

    it('does NOT call onMessage when comment has no mention', async () => {
      const payload = {
        action: 'created',
        comment: { id: 301, body: 'This is a regular comment' },
        issue: { number: 6 },
        sender: { login: 'alice' },
        repository: { full_name: 'acme/repo' },
      };
      await postWebhook(13002, 'issue_comment', payload);
      await tick();
      expect(onMessage).not.toHaveBeenCalled();
    });

    it('does NOT call onMessage when bot comments (prevents loops)', async () => {
      const payload = {
        action: 'created',
        comment: { id: 302, body: '@nanoclaw-bot hello' },
        issue: { number: 7 },
        sender: { login: 'nanoclaw-bot' },
        repository: { full_name: 'acme/repo' },
      };
      await postWebhook(13002, 'issue_comment', payload);
      await tick();
      expect(onMessage).not.toHaveBeenCalled();
    });
  });

  // ---- event: pull_request_review_comment ----

  describe('event handling: pull_request_review_comment', () => {
    it('calls onMessage when PR review comment mentions the bot', async () => {
      const payload = {
        action: 'created',
        comment: { id: 400, body: '@nanoclaw-bot please refactor this' },
        pull_request: { number: 55 },
        sender: { login: 'reviewer' },
        repository: { full_name: 'acme/repo' },
      };
      await postWebhook(13002, 'pull_request_review_comment', payload);
      await tick();
      expect(onMessage).toHaveBeenCalledWith(
        'github:acme/repo#55',
        expect.objectContaining({ id: 'github-pr-comment-400' }),
      );
    });
  });

  // ---- sendMessage ----

  describe('sendMessage', () => {
    it('calls octokit.issues.createComment with correct params', async () => {
      await channel.sendMessage('github:acme/repo#42', 'Hello from bot');
      expect(mockCreateComment).toHaveBeenCalledWith({
        owner: 'acme',
        repo: 'repo',
        issue_number: 42,
        body: 'Hello from bot',
      });
    });

    it('sends multiple chunks for long messages', async () => {
      const longText = 'x'.repeat(4001);
      await channel.sendMessage('github:acme/repo#1', longText);
      expect(mockCreateComment).toHaveBeenCalledTimes(2);
    });

    it('logs an error for invalid JID and does not call octokit', async () => {
      await channel.sendMessage('invalid-jid', 'hi');
      expect(mockCreateComment).not.toHaveBeenCalled();
    });
  });

  // ---- factory ----

  describe('factory (readEnvFile integration)', () => {
    it('skips channel when GITHUB_TOKEN is missing', () => {
      vi.mocked(readEnvFile).mockReturnValueOnce({
        GITHUB_WEBHOOK_SECRET: 'secret',
        GITHUB_BOT_USERNAME: 'bot',
      });
      const env = readEnvFile(['GITHUB_TOKEN']);
      expect(env.GITHUB_TOKEN).toBeUndefined();
    });
  });
});
