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

import { GitHubChannel, makeGitHubFolder, extractAuthor } from './github.js';
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

// --- makeGitHubFolder ---

describe('makeGitHubFolder', () => {
  it('creates folder from repo and number', () => {
    expect(makeGitHubFolder('cmraible/seb', 42)).toBe('github_cmraible-seb-42');
  });

  it('strips non-alphanumeric characters', () => {
    expect(makeGitHubFolder('org.name/repo.name', 1)).toBe(
      'github_orgname-reponame-1',
    );
  });

  it('truncates long repo names to fit 64-char limit', () => {
    const longRepo = 'very-long-organization-name/very-long-repository-name';
    const folder = makeGitHubFolder(longRepo, 12345);
    expect(folder.length).toBeLessThanOrEqual(64);
    expect(folder).toMatch(/^github_/);
    expect(folder).toMatch(/-12345$/);
  });

  it('always starts with github_ prefix', () => {
    expect(makeGitHubFolder('a/b', 1)).toMatch(/^github_/);
  });
});

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
    channel = new GitHubChannel(SECRET, 0, 'test-github-token', [], opts);
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
        [],
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

  // --- Per-issue/PR JID routing ---

  describe('issue events', () => {
    it('routes issue events to per-issue JID', async () => {
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
        'gh:cmraible/seb#42',
        expect.any(String),
        'cmraible/seb#42',
        'github',
        false,
      );
      expect(opts.onMessage).toHaveBeenCalledWith(
        'gh:cmraible/seb#42',
        expect.objectContaining({
          chat_jid: 'gh:cmraible/seb#42',
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
        'gh:cmraible/seb#42',
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
    it('routes PR events to per-PR JID', async () => {
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
        'gh:cmraible/seb#7',
        expect.objectContaining({
          chat_jid: 'gh:cmraible/seb#7',
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
        'gh:cmraible/seb#7',
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
        'gh:cmraible/seb#7',
        expect.objectContaining({
          content: expect.stringContaining('PR closed: #7'),
        }),
      );
    });
  });

  describe('issue comment events', () => {
    it('routes comments to per-issue JID', async () => {
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
        'gh:cmraible/seb#5',
        expect.objectContaining({
          content: expect.stringContaining(
            'New comment on Issue #5 "Question" by bob',
          ),
        }),
      );
    });

    it('routes PR comments to per-PR JID', async () => {
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
        'gh:cmraible/seb#7',
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
    it('routes review to per-PR JID', async () => {
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
        'gh:cmraible/seb#7',
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
    it('routes failed check suite to PR JID when PR is associated', async () => {
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
            pull_requests: [{ number: 15 }],
          },
          sender: { login: 'github-actions[bot]' },
        },
      });

      expect(opts.onMessage).toHaveBeenCalledWith(
        'gh:cmraible/seb#15',
        expect.objectContaining({
          content: expect.stringContaining('Check suite failure on feat/test'),
        }),
      );
    });

    it('routes failed check suite to repo-level JID when no PR is associated', async () => {
      await sendWebhook(port, {
        event: 'check_suite',
        secret: SECRET,
        payload: {
          action: 'completed',
          repository: { full_name: 'cmraible/seb' },
          check_suite: {
            conclusion: 'failure',
            head_branch: 'main',
            url: 'https://api.github.com/repos/cmraible/seb/check-suites/1',
            pull_requests: [],
          },
          sender: { login: 'github-actions[bot]' },
        },
      });

      expect(opts.onMessage).toHaveBeenCalledWith(
        'gh:cmraible/seb',
        expect.objectContaining({
          content: expect.stringContaining('Check suite failure on main'),
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
            pull_requests: [],
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

  // --- Auto-registration ---

  describe('auto-registration', () => {
    it('auto-registers group with requiresTrigger true by default', async () => {
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
            user: { login: 'alice' },
          },
          sender: { login: 'alice' },
        },
      });

      expect(opts.registerGroup).toHaveBeenCalledWith(
        'gh:cmraible/seb#42',
        expect.objectContaining({
          name: 'cmraible/seb#42',
          folder: 'github_cmraible-seb-42',
          trigger: '@Andy',
          requiresTrigger: true,
        }),
      );
    });

    it('does not re-register already registered group', async () => {
      const registeredGroups: Record<string, any> = {
        'gh:cmraible/seb#42': {
          name: 'cmraible/seb#42',
          folder: 'github_cmraible-seb-42',
          trigger: '@Andy',
          added_at: '2024-01-01T00:00:00.000Z',
        },
      };
      (opts.registeredGroups as any).mockReturnValue(registeredGroups);

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
            user: { login: 'alice' },
          },
          sender: { login: 'alice' },
        },
      });

      expect(opts.registerGroup).not.toHaveBeenCalled();
    });

    it('auto-registers repo-level group with requiresTrigger true', async () => {
      await sendWebhook(port, {
        event: 'check_suite',
        secret: SECRET,
        payload: {
          action: 'completed',
          repository: { full_name: 'cmraible/seb' },
          check_suite: {
            conclusion: 'failure',
            head_branch: 'main',
            url: 'https://api.github.com/repos/cmraible/seb/check-suites/1',
            pull_requests: [],
          },
          sender: { login: 'github-actions[bot]' },
        },
      });

      expect(opts.registerGroup).toHaveBeenCalledWith(
        'gh:cmraible/seb',
        expect.objectContaining({
          name: 'cmraible/seb',
          folder: 'github_cmraible-seb',
          requiresTrigger: true,
        }),
      );
    });
  });

  // --- ownsJid ---

  describe('ownsJid', () => {
    it('owns gh: JIDs with issue number', () => {
      expect(channel.ownsJid('gh:cmraible/seb#42')).toBe(true);
    });

    it('owns gh: JIDs without issue number', () => {
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
    it('posts a comment using issue number from JID', async () => {
      const originalFetch = globalThis.fetch;
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 201,
        json: () => Promise.resolve({ id: 1 }),
      });
      globalThis.fetch = mockFetch as any;

      try {
        await channel.sendMessage('gh:cmraible/seb#42', 'Hello from the bot!');

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

    it('warns when JID has no issue number (repo-level)', async () => {
      const { logger: mockLogger } = await import('../logger.js');

      await channel.sendMessage('gh:cmraible/seb', 'Hello');

      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ jid: 'gh:cmraible/seb' }),
        expect.stringContaining('no issue/PR number'),
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
  });
});

// --- extractAuthor ---

describe('extractAuthor', () => {
  it('returns PR author for pull_request events', () => {
    expect(
      extractAuthor('pull_request', {
        pull_request: { user: { login: 'seb-writes-code' } },
      }),
    ).toBe('seb-writes-code');
  });

  it('returns PR author for pull_request_review events', () => {
    expect(
      extractAuthor('pull_request_review', {
        pull_request: { user: { login: 'alice' } },
      }),
    ).toBe('alice');
  });

  it('returns PR author for pull_request_review_comment events', () => {
    expect(
      extractAuthor('pull_request_review_comment', {
        pull_request: { user: { login: 'bob' } },
      }),
    ).toBe('bob');
  });

  it('returns issue author for issues events', () => {
    expect(
      extractAuthor('issues', { issue: { user: { login: 'alice' } } }),
    ).toBe('alice');
  });

  it('returns issue author for issue_comment events', () => {
    expect(
      extractAuthor('issue_comment', { issue: { user: { login: 'bob' } } }),
    ).toBe('bob');
  });

  it('returns null for check_suite events', () => {
    expect(extractAuthor('check_suite', { check_suite: {} })).toBeNull();
  });

  it('returns null for unknown events', () => {
    expect(extractAuthor('push', {})).toBeNull();
  });
});

// --- Bot-authored PR trigger bypass ---

describe('GitHubChannel bot username bypass', () => {
  const SECRET = 'test-webhook-secret';
  let port: number;
  let channel: GitHubChannel;
  let opts: ChannelOpts;

  afterEach(async () => {
    await channel.disconnect();
  });

  it('registers bot-authored PR with requiresTrigger false', async () => {
    opts = createTestOpts();
    channel = new GitHubChannel(
      SECRET,
      0,
      'test-token',
      [],
      opts,
      'seb-writes-code',
    );
    await channel.connect();
    port = (channel as any).server.address().port;

    await sendWebhook(port, {
      event: 'pull_request',
      secret: SECRET,
      payload: {
        action: 'opened',
        repository: { full_name: 'cmraible/seb' },
        pull_request: {
          number: 10,
          title: 'Bot PR',
          html_url: 'https://github.com/cmraible/seb/pull/10',
          merged: false,
          user: { login: 'seb-writes-code' },
        },
        sender: { login: 'seb-writes-code' },
      },
    });

    expect(opts.registerGroup).toHaveBeenCalledWith(
      'gh:cmraible/seb#10',
      expect.objectContaining({
        requiresTrigger: false,
      }),
    );
  });

  it('registers non-bot PR with requiresTrigger true', async () => {
    opts = createTestOpts();
    channel = new GitHubChannel(
      SECRET,
      0,
      'test-token',
      [],
      opts,
      'seb-writes-code',
    );
    await channel.connect();
    port = (channel as any).server.address().port;

    await sendWebhook(port, {
      event: 'pull_request',
      secret: SECRET,
      payload: {
        action: 'opened',
        repository: { full_name: 'cmraible/seb' },
        pull_request: {
          number: 11,
          title: 'Someone else PR',
          html_url: 'https://github.com/cmraible/seb/pull/11',
          merged: false,
          user: { login: 'alice' },
        },
        sender: { login: 'alice' },
      },
    });

    expect(opts.registerGroup).toHaveBeenCalledWith(
      'gh:cmraible/seb#11',
      expect.objectContaining({
        requiresTrigger: true,
      }),
    );
  });

  it('bypasses trigger for bot-authored PR on issue_comment events', async () => {
    opts = createTestOpts();
    channel = new GitHubChannel(
      SECRET,
      0,
      'test-token',
      [],
      opts,
      'seb-writes-code',
    );
    await channel.connect();
    port = (channel as any).server.address().port;

    await sendWebhook(port, {
      event: 'issue_comment',
      secret: SECRET,
      payload: {
        action: 'created',
        repository: { full_name: 'cmraible/seb' },
        issue: {
          number: 10,
          title: 'Bot PR',
          pull_request: { url: 'https://api.github.com/...' },
          user: { login: 'seb-writes-code' },
        },
        comment: {
          user: { login: 'chris' },
          body: 'CI failed, can you fix it?',
          html_url: 'https://github.com/cmraible/seb/pull/10#issuecomment-1',
        },
        sender: { login: 'chris' },
      },
    });

    expect(opts.registerGroup).toHaveBeenCalledWith(
      'gh:cmraible/seb#10',
      expect.objectContaining({
        requiresTrigger: false,
      }),
    );
  });

  it('requires trigger when botUsername is not set', async () => {
    opts = createTestOpts();
    channel = new GitHubChannel(SECRET, 0, 'test-token', [], opts);
    await channel.connect();
    port = (channel as any).server.address().port;

    await sendWebhook(port, {
      event: 'pull_request',
      secret: SECRET,
      payload: {
        action: 'opened',
        repository: { full_name: 'cmraible/seb' },
        pull_request: {
          number: 12,
          title: 'Some PR',
          html_url: 'https://github.com/cmraible/seb/pull/12',
          merged: false,
          user: { login: 'seb-writes-code' },
        },
        sender: { login: 'seb-writes-code' },
      },
    });

    expect(opts.registerGroup).toHaveBeenCalledWith(
      'gh:cmraible/seb#12',
      expect.objectContaining({
        requiresTrigger: true,
      }),
    );
  });
});

// --- Sender allowlist tests (separate describe with its own channel) ---

describe('GitHubChannel sender allowlist', () => {
  const SECRET = 'test-webhook-secret';
  let port: number;
  let channel: GitHubChannel;
  let opts: ChannelOpts;

  afterEach(async () => {
    await channel.disconnect();
  });

  it('delivers events from allowed senders', async () => {
    opts = createTestOpts();
    channel = new GitHubChannel(SECRET, 0, 'test-token', ['alice'], opts);
    await channel.connect();
    port = (channel as any).server.address().port;

    await sendWebhook(port, {
      event: 'issues',
      secret: SECRET,
      payload: {
        action: 'opened',
        repository: { full_name: 'cmraible/seb' },
        issue: {
          number: 1,
          title: 'Test',
          html_url: 'https://github.com/cmraible/seb/issues/1',
        },
        sender: { login: 'alice' },
      },
    });

    expect(opts.onMessage).toHaveBeenCalled();
  });

  it('drops events from non-allowed senders', async () => {
    opts = createTestOpts();
    channel = new GitHubChannel(SECRET, 0, 'test-token', ['alice'], opts);
    await channel.connect();
    port = (channel as any).server.address().port;

    await sendWebhook(port, {
      event: 'issues',
      secret: SECRET,
      payload: {
        action: 'opened',
        repository: { full_name: 'cmraible/seb' },
        issue: {
          number: 1,
          title: 'Test',
          html_url: 'https://github.com/cmraible/seb/issues/1',
        },
        sender: { login: 'stranger' },
      },
    });

    expect(opts.onMessage).not.toHaveBeenCalled();
    expect(opts.onChatMetadata).not.toHaveBeenCalled();
  });

  it('allows all senders when allowlist is empty', async () => {
    opts = createTestOpts();
    channel = new GitHubChannel(SECRET, 0, 'test-token', [], opts);
    await channel.connect();
    port = (channel as any).server.address().port;

    await sendWebhook(port, {
      event: 'issues',
      secret: SECRET,
      payload: {
        action: 'opened',
        repository: { full_name: 'cmraible/seb' },
        issue: {
          number: 1,
          title: 'Test',
          html_url: 'https://github.com/cmraible/seb/issues/1',
        },
        sender: { login: 'anyone' },
      },
    });

    expect(opts.onMessage).toHaveBeenCalled();
  });

  it('supports multiple allowed senders', async () => {
    opts = createTestOpts();
    channel = new GitHubChannel(
      SECRET,
      0,
      'test-token',
      ['alice', 'bob'],
      opts,
    );
    await channel.connect();
    port = (channel as any).server.address().port;

    await sendWebhook(port, {
      event: 'issues',
      secret: SECRET,
      payload: {
        action: 'opened',
        repository: { full_name: 'cmraible/seb' },
        issue: {
          number: 1,
          title: 'Test',
          html_url: 'https://github.com/cmraible/seb/issues/1',
        },
        sender: { login: 'bob' },
      },
    });

    expect(opts.onMessage).toHaveBeenCalled();
  });
});

// --- ack and metadata tests ---

describe('GitHubChannel ack', () => {
  const SECRET = 'test-webhook-secret';
  let port: number;
  let channel: GitHubChannel;
  let opts: ChannelOpts;

  beforeEach(async () => {
    vi.clearAllMocks();
    opts = createTestOpts();
    channel = new GitHubChannel(SECRET, 0, 'test-github-token', [], opts);
    await channel.connect();
    port = (channel as any).server.address().port;
  });

  afterEach(async () => {
    await channel.disconnect();
  });

  it('issue_comment webhook includes metadata with comment ID', async () => {
    await sendWebhook(port, {
      event: 'issue_comment',
      secret: SECRET,
      payload: {
        action: 'created',
        repository: { full_name: 'cmraible/seb' },
        issue: {
          number: 42,
          title: 'Test issue',
          html_url: 'https://github.com/cmraible/seb/issues/42',
        },
        comment: {
          id: 12345,
          body: 'Hello @Andy',
          user: { login: 'chris' },
          html_url:
            'https://github.com/cmraible/seb/issues/42#issuecomment-12345',
        },
        sender: { login: 'chris' },
      },
    });

    expect(opts.onMessage).toHaveBeenCalledWith(
      'gh:cmraible/seb#42',
      expect.objectContaining({
        metadata: {
          github_repo: 'cmraible/seb',
          github_comment_id: '12345',
          github_endpoint: 'issues',
        },
      }),
    );
  });

  it('pull_request_review_comment includes metadata with pulls endpoint', async () => {
    await sendWebhook(port, {
      event: 'pull_request_review_comment',
      secret: SECRET,
      payload: {
        action: 'created',
        repository: { full_name: 'cmraible/seb' },
        pull_request: {
          number: 99,
          title: 'Test PR',
          user: { login: 'chris' },
        },
        comment: {
          id: 67890,
          body: 'Review comment',
          user: { login: 'chris' },
          html_url: 'https://github.com/cmraible/seb/pull/99#discussion_r67890',
        },
        sender: { login: 'chris' },
      },
    });

    expect(opts.onMessage).toHaveBeenCalledWith(
      'gh:cmraible/seb#99',
      expect.objectContaining({
        metadata: {
          github_repo: 'cmraible/seb',
          github_comment_id: '67890',
          github_endpoint: 'pulls',
        },
      }),
    );
  });

  it('ack() calls GitHub Reactions API with eyes emoji', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('{}', { status: 201 }));

    await channel.ack('gh:cmraible/seb#42', {
      github_repo: 'cmraible/seb',
      github_comment_id: '12345',
      github_endpoint: 'issues',
    });

    expect(fetchSpy).toHaveBeenCalledWith(
      'https://api.github.com/repos/cmraible/seb/issues/comments/12345/reactions',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ content: 'eyes' }),
      }),
    );
    fetchSpy.mockRestore();
  });

  it('ack() uses pulls endpoint for PR review comments', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('{}', { status: 201 }));

    await channel.ack('gh:cmraible/seb#99', {
      github_repo: 'cmraible/seb',
      github_comment_id: '67890',
      github_endpoint: 'pulls',
    });

    expect(fetchSpy).toHaveBeenCalledWith(
      'https://api.github.com/repos/cmraible/seb/pulls/comments/67890/reactions',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ content: 'eyes' }),
      }),
    );
    fetchSpy.mockRestore();
  });

  it('ack() does nothing without context', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    await channel.ack('gh:cmraible/seb#42');
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it('ack() does nothing without token', async () => {
    const noTokenChannel = new GitHubChannel(SECRET, 0, '', [], opts);
    await noTokenChannel.connect();
    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    await noTokenChannel.ack('gh:cmraible/seb#42', {
      github_repo: 'cmraible/seb',
      github_comment_id: '12345',
      github_endpoint: 'issues',
    });

    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
    await noTokenChannel.disconnect();
  });
});
