import crypto from 'crypto';
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';

// --- Mocks ---

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

import { GitHubChannel } from './github.js';
import { ChannelOpts } from './registry.js';

// --- Test helpers ---

function createTestOpts(overrides?: Partial<ChannelOpts>): ChannelOpts {
  return {
    onMessage: vi.fn(),
    onChatMetadata: vi.fn(),
    registeredGroups: vi.fn(() => ({})),
    registerGroup: vi.fn(),
    ...overrides,
  };
}

function sign(secret: string, payload: string): string {
  return (
    'sha256=' +
    crypto.createHmac('sha256', secret).update(payload).digest('hex')
  );
}

async function sendWebhook(
  port: number,
  opts: {
    event: string;
    payload: any;
    secret: string;
    deliveryId?: string;
    skipSignature?: boolean;
  },
): Promise<Response> {
  const body = JSON.stringify(opts.payload);
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'X-GitHub-Event': opts.event,
    'X-GitHub-Delivery': opts.deliveryId || 'test-delivery-1',
  };
  if (!opts.skipSignature) {
    headers['X-Hub-Signature-256'] = sign(opts.secret, body);
  }
  return fetch(`http://localhost:${port}/webhook`, {
    method: 'POST',
    headers,
    body,
  });
}

// --- Tests ---

describe('GitHubChannel', () => {
  const SECRET = 'test-webhook-secret';
  let port: number;
  let channel: GitHubChannel;
  let opts: ChannelOpts;

  beforeEach(async () => {
    vi.clearAllMocks();
    opts = createTestOpts();
    // Use port 0 to get a random available port
    channel = new GitHubChannel(SECRET, 0, 'test-github-token', opts);
    await channel.connect();
    const addr = (channel as any).server.address();
    port = addr.port;
  });

  afterEach(async () => {
    await channel.disconnect();
  });

  // --- Connection lifecycle ---

  describe('connection lifecycle', () => {
    it('is connected after connect()', () => {
      expect(channel.isConnected()).toBe(true);
    });

    it('is not connected after disconnect()', async () => {
      await channel.disconnect();
      expect(channel.isConnected()).toBe(false);
    });

    it('isConnected() returns false before connect', () => {
      const ch = new GitHubChannel(
        SECRET,
        0,
        'test-github-token',
        createTestOpts(),
      );
      expect(ch.isConnected()).toBe(false);
    });
  });

  // --- Signature verification ---

  describe('signature verification', () => {
    it('rejects requests with invalid signature', async () => {
      const body = JSON.stringify({ repository: { full_name: 'a/b' } });
      const res = await fetch(`http://localhost:${port}/webhook`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-GitHub-Event': 'issues',
          'X-GitHub-Delivery': 'd-1',
          'X-Hub-Signature-256': 'sha256=invalid',
        },
        body,
      });
      expect(res.status).toBe(401);
    });

    it('rejects requests with missing signature', async () => {
      const res = await fetch(`http://localhost:${port}/webhook`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-GitHub-Event': 'issues',
          'X-GitHub-Delivery': 'd-1',
        },
        body: '{}',
      });
      expect(res.status).toBe(400);
    });

    it('rejects requests with missing event header', async () => {
      const body = '{}';
      const res = await fetch(`http://localhost:${port}/webhook`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Hub-Signature-256': sign(SECRET, body),
        },
        body,
      });
      expect(res.status).toBe(400);
    });

    it('accepts requests with valid signature', async () => {
      const res = await sendWebhook(port, {
        event: 'issues',
        secret: SECRET,
        payload: {
          action: 'opened',
          repository: { full_name: 'cmraible/seb' },
          issue: {
            number: 1,
            title: 'Test issue',
            html_url: 'https://github.com/cmraible/seb/issues/1',
          },
          sender: { login: 'alice' },
        },
      });
      expect(res.status).toBe(200);
    });
  });

  // --- Event formatting ---

  describe('issue events', () => {
    it('processes issue opened', async () => {
      await sendWebhook(port, {
        event: 'issues',
        secret: SECRET,
        payload: {
          action: 'opened',
          repository: { full_name: 'cmraible/seb' },
          issue: {
            number: 42,
            title: 'Bug report',
            html_url: 'https://github.com/cmraible/seb/issues/42',
          },
          sender: { login: 'alice' },
        },
      });

      expect(opts.onChatMetadata).toHaveBeenCalledWith(
        'gh:cmraible/seb',
        expect.any(String),
        'cmraible/seb',
        'github',
        false,
      );
      expect(opts.onMessage).toHaveBeenCalledWith(
        'gh:cmraible/seb',
        expect.objectContaining({
          chat_jid: 'gh:cmraible/seb',
          sender: 'alice',
          sender_name: 'alice',
          content: expect.stringContaining('Issue opened: #42 "Bug report"'),
          is_from_me: false,
        }),
      );
    });

    it('processes issue closed', async () => {
      await sendWebhook(port, {
        event: 'issues',
        secret: SECRET,
        payload: {
          action: 'closed',
          repository: { full_name: 'cmraible/seb' },
          issue: {
            number: 42,
            title: 'Bug report',
            html_url: 'https://github.com/cmraible/seb/issues/42',
          },
          sender: { login: 'bob' },
        },
      });

      expect(opts.onMessage).toHaveBeenCalledWith(
        'gh:cmraible/seb',
        expect.objectContaining({
          content: expect.stringContaining('Issue closed: #42'),
        }),
      );
    });

    it('ignores issue labeled action', async () => {
      await sendWebhook(port, {
        event: 'issues',
        secret: SECRET,
        payload: {
          action: 'labeled',
          repository: { full_name: 'cmraible/seb' },
          issue: {
            number: 42,
            title: 'Bug report',
            html_url: 'https://github.com/cmraible/seb/issues/42',
          },
          sender: { login: 'alice' },
        },
      });

      expect(opts.onChatMetadata).toHaveBeenCalled();
      expect(opts.onMessage).not.toHaveBeenCalled();
    });
  });

  describe('pull request events', () => {
    it('processes PR opened', async () => {
      await sendWebhook(port, {
        event: 'pull_request',
        secret: SECRET,
        payload: {
          action: 'opened',
          repository: { full_name: 'cmraible/seb' },
          pull_request: {
            number: 7,
            title: 'New feature',
            html_url: 'https://github.com/cmraible/seb/pull/7',
            merged: false,
          },
          sender: { login: 'alice' },
        },
      });

      expect(opts.onMessage).toHaveBeenCalledWith(
        'gh:cmraible/seb',
        expect.objectContaining({
          content: expect.stringContaining('PR opened: #7 "New feature"'),
        }),
      );
    });

    it('processes PR merged', async () => {
      await sendWebhook(port, {
        event: 'pull_request',
        secret: SECRET,
        payload: {
          action: 'closed',
          repository: { full_name: 'cmraible/seb' },
          pull_request: {
            number: 7,
            title: 'New feature',
            html_url: 'https://github.com/cmraible/seb/pull/7',
            merged: true,
          },
          sender: { login: 'alice' },
        },
      });

      expect(opts.onMessage).toHaveBeenCalledWith(
        'gh:cmraible/seb',
        expect.objectContaining({
          content: expect.stringContaining('PR merged: #7 "New feature"'),
        }),
      );
    });

    it('processes PR closed without merge', async () => {
      await sendWebhook(port, {
        event: 'pull_request',
        secret: SECRET,
        payload: {
          action: 'closed',
          repository: { full_name: 'cmraible/seb' },
          pull_request: {
            number: 7,
            title: 'New feature',
            html_url: 'https://github.com/cmraible/seb/pull/7',
            merged: false,
          },
          sender: { login: 'alice' },
        },
      });

      expect(opts.onMessage).toHaveBeenCalledWith(
        'gh:cmraible/seb',
        expect.objectContaining({
          content: expect.stringContaining('PR closed: #7'),
        }),
      );
    });
  });

  describe('issue comment events', () => {
    it('processes new comment on issue', async () => {
      await sendWebhook(port, {
        event: 'issue_comment',
        secret: SECRET,
        payload: {
          action: 'created',
          repository: { full_name: 'cmraible/seb' },
          issue: {
            number: 5,
            title: 'Question',
          },
          comment: {
            user: { login: 'bob' },
            body: 'This looks great!',
            html_url: 'https://github.com/cmraible/seb/issues/5#issuecomment-1',
          },
          sender: { login: 'bob' },
        },
      });

      expect(opts.onMessage).toHaveBeenCalledWith(
        'gh:cmraible/seb',
        expect.objectContaining({
          content: expect.stringContaining(
            'New comment on Issue #5 "Question" by bob',
          ),
        }),
      );
    });

    it('processes new comment on PR', async () => {
      await sendWebhook(port, {
        event: 'issue_comment',
        secret: SECRET,
        payload: {
          action: 'created',
          repository: { full_name: 'cmraible/seb' },
          issue: {
            number: 7,
            title: 'Feature PR',
            pull_request: { url: 'https://api.github.com/...' },
          },
          comment: {
            user: { login: 'alice' },
            body: 'LGTM',
            html_url: 'https://github.com/cmraible/seb/pull/7#issuecomment-2',
          },
          sender: { login: 'alice' },
        },
      });

      expect(opts.onMessage).toHaveBeenCalledWith(
        'gh:cmraible/seb',
        expect.objectContaining({
          content: expect.stringContaining('New comment on PR #7'),
        }),
      );
    });

    it('truncates long comments', async () => {
      await sendWebhook(port, {
        event: 'issue_comment',
        secret: SECRET,
        payload: {
          action: 'created',
          repository: { full_name: 'cmraible/seb' },
          issue: { number: 1, title: 'Test' },
          comment: {
            user: { login: 'alice' },
            body: 'x'.repeat(300),
            html_url: 'https://github.com/cmraible/seb/issues/1#issuecomment-1',
          },
          sender: { login: 'alice' },
        },
      });

      const call = (opts.onMessage as any).mock.calls[0];
      const content = call[1].content;
      expect(content).toContain('...');
      // Truncated at 200 chars + "..."
      expect(content.length).toBeLessThan(400);
    });
  });

  describe('PR review events', () => {
    it('processes review approved', async () => {
      await sendWebhook(port, {
        event: 'pull_request_review',
        secret: SECRET,
        payload: {
          action: 'submitted',
          repository: { full_name: 'cmraible/seb' },
          pull_request: {
            number: 7,
            title: 'Feature',
          },
          review: {
            state: 'approved',
            user: { login: 'chris' },
            html_url:
              'https://github.com/cmraible/seb/pull/7#pullrequestreview-1',
          },
          sender: { login: 'chris' },
        },
      });

      expect(opts.onMessage).toHaveBeenCalledWith(
        'gh:cmraible/seb',
        expect.objectContaining({
          content: expect.stringContaining('review: approved by chris'),
        }),
      );
    });

    it('ignores review with "commented" state', async () => {
      await sendWebhook(port, {
        event: 'pull_request_review',
        secret: SECRET,
        payload: {
          action: 'submitted',
          repository: { full_name: 'cmraible/seb' },
          pull_request: { number: 7, title: 'Feature' },
          review: {
            state: 'commented',
            user: { login: 'chris' },
            html_url:
              'https://github.com/cmraible/seb/pull/7#pullrequestreview-1',
          },
          sender: { login: 'chris' },
        },
      });

      expect(opts.onChatMetadata).toHaveBeenCalled();
      expect(opts.onMessage).not.toHaveBeenCalled();
    });
  });

  describe('check suite events', () => {
    it('processes failed check suite', async () => {
      await sendWebhook(port, {
        event: 'check_suite',
        secret: SECRET,
        payload: {
          action: 'completed',
          repository: { full_name: 'cmraible/seb' },
          check_suite: {
            conclusion: 'failure',
            head_branch: 'feat/test',
            url: 'https://api.github.com/repos/cmraible/seb/check-suites/1',
          },
          sender: { login: 'github-actions[bot]' },
        },
      });

      expect(opts.onMessage).toHaveBeenCalledWith(
        'gh:cmraible/seb',
        expect.objectContaining({
          content: expect.stringContaining('Check suite failure on feat/test'),
        }),
      );
    });

    it('ignores successful check suite', async () => {
      await sendWebhook(port, {
        event: 'check_suite',
        secret: SECRET,
        payload: {
          action: 'completed',
          repository: { full_name: 'cmraible/seb' },
          check_suite: {
            conclusion: 'success',
            head_branch: 'main',
            url: 'https://api.github.com/repos/cmraible/seb/check-suites/1',
          },
          sender: { login: 'github-actions[bot]' },
        },
      });

      expect(opts.onChatMetadata).toHaveBeenCalled();
      expect(opts.onMessage).not.toHaveBeenCalled();
    });
  });

  describe('unsupported events', () => {
    it('returns 200 but does not process push events', async () => {
      const res = await sendWebhook(port, {
        event: 'push',
        secret: SECRET,
        payload: {
          repository: { full_name: 'cmraible/seb' },
          sender: { login: 'alice' },
        },
      });

      expect(res.status).toBe(200);
      expect(opts.onMessage).not.toHaveBeenCalled();
    });
  });

  // --- ownsJid ---

  describe('ownsJid', () => {
    it('owns gh: JIDs', () => {
      expect(channel.ownsJid('gh:cmraible/seb')).toBe(true);
    });

    it('does not own tg: JIDs', () => {
      expect(channel.ownsJid('tg:123456')).toBe(false);
    });

    it('does not own WhatsApp JIDs', () => {
      expect(channel.ownsJid('12345@g.us')).toBe(false);
    });
  });

  // --- Health check ---

  describe('health check', () => {
    it('returns ok status', async () => {
      const res = await fetch(`http://localhost:${port}/health`);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toEqual({ status: 'ok', channel: 'github' });
    });
  });

  // --- Channel properties ---

  describe('channel properties', () => {
    it('has name "github"', () => {
      expect(channel.name).toBe('github');
    });
  });

  // --- sendMessage ---

  describe('sendMessage', () => {
    it('posts a comment to the most recent issue/PR', async () => {
      // First, send a webhook to set the reply target
      await sendWebhook(port, {
        event: 'issues',
        secret: SECRET,
        payload: {
          action: 'opened',
          repository: { full_name: 'cmraible/seb' },
          issue: {
            number: 42,
            title: 'Test issue',
            html_url: 'https://github.com/cmraible/seb/issues/42',
          },
          sender: { login: 'alice' },
        },
      });

      // Mock fetch for the GitHub API call
      const originalFetch = globalThis.fetch;
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 201,
        json: () => Promise.resolve({ id: 1 }),
      });
      globalThis.fetch = mockFetch as any;

      try {
        await channel.sendMessage('gh:cmraible/seb', 'Hello from the bot!');

        // Find the call that went to api.github.com (not localhost webhook)
        const apiCall = mockFetch.mock.calls.find((c: any[]) =>
          c[0]?.toString().includes('api.github.com'),
        );
        expect(apiCall).toBeDefined();
        expect(apiCall![0]).toBe(
          'https://api.github.com/repos/cmraible/seb/issues/42/comments',
        );
        const callOpts = apiCall![1];
        expect(callOpts.method).toBe('POST');
        expect(JSON.parse(callOpts.body)).toEqual({
          body: 'Hello from the bot!',
        });
        expect(callOpts.headers.Authorization).toBe('Bearer test-github-token');
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it('warns when no reply target exists', async () => {
      const { logger: mockLogger } = await import('../logger.js');

      await channel.sendMessage('gh:unknown/repo', 'Hello');

      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ jid: 'gh:unknown/repo' }),
        expect.stringContaining('No reply target'),
      );
    });

    it('logs error for invalid JID format', async () => {
      const { logger: mockLogger } = await import('../logger.js');

      await channel.sendMessage('invalid-jid', 'Hello');

      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.objectContaining({ jid: 'invalid-jid' }),
        expect.stringContaining('Invalid GitHub JID'),
      );
    });

    it('updates reply target when new events arrive', async () => {
      // Send issue event
      await sendWebhook(port, {
        event: 'issues',
        secret: SECRET,
        payload: {
          action: 'opened',
          repository: { full_name: 'cmraible/seb' },
          issue: {
            number: 10,
            title: 'First issue',
            html_url: 'https://github.com/cmraible/seb/issues/10',
          },
          sender: { login: 'alice' },
        },
      });

      // Send another event for a different issue
      await sendWebhook(port, {
        event: 'issues',
        secret: SECRET,
        payload: {
          action: 'opened',
          repository: { full_name: 'cmraible/seb' },
          issue: {
            number: 20,
            title: 'Second issue',
            html_url: 'https://github.com/cmraible/seb/issues/20',
          },
          sender: { login: 'bob' },
        },
      });

      const originalFetch = globalThis.fetch;
      const mockFetch = vi.fn().mockResolvedValue({ ok: true, status: 201 });
      globalThis.fetch = mockFetch as any;

      try {
        await channel.sendMessage('gh:cmraible/seb', 'Reply');

        const apiCall = mockFetch.mock.calls.find((c: any[]) =>
          c[0]?.toString().includes('api.github.com'),
        );
        // Should target issue 20 (most recent)
        expect(apiCall![0]).toContain('/issues/20/comments');
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it('tracks PR numbers from pull_request events', async () => {
      await sendWebhook(port, {
        event: 'pull_request',
        secret: SECRET,
        payload: {
          action: 'opened',
          repository: { full_name: 'cmraible/seb' },
          pull_request: {
            number: 99,
            title: 'Big PR',
            html_url: 'https://github.com/cmraible/seb/pull/99',
            merged: false,
          },
          sender: { login: 'alice' },
        },
      });

      const originalFetch = globalThis.fetch;
      const mockFetch = vi.fn().mockResolvedValue({ ok: true, status: 201 });
      globalThis.fetch = mockFetch as any;

      try {
        await channel.sendMessage('gh:cmraible/seb', 'PR comment');

        const apiCall = mockFetch.mock.calls.find((c: any[]) =>
          c[0]?.toString().includes('api.github.com'),
        );
        // GitHub API uses /issues/ endpoint for both issues and PRs
        expect(apiCall![0]).toBe(
          'https://api.github.com/repos/cmraible/seb/issues/99/comments',
        );
      } finally {
        globalThis.fetch = originalFetch;
      }
    });
  });
});
