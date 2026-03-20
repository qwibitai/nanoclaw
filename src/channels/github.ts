import crypto from 'crypto';
import express from 'express';
import http from 'http';

import { ASSISTANT_NAME } from '../config.js';
import { readEnvFile } from '../env.js';
import { logger } from '../logger.js';
import { registerChannel, ChannelOpts } from './registry.js';
import { Channel } from '../types.js';

/** GitHub event types we handle */
const SUPPORTED_EVENTS = new Set([
  'issues',
  'pull_request',
  'issue_comment',
  'pull_request_review',
  'pull_request_review_comment',
  'check_suite',
]);

/** Verify the webhook payload signature using HMAC-SHA256 */
function verifySignature(
  secret: string,
  payload: string,
  signature: string,
): boolean {
  const expected =
    'sha256=' +
    crypto.createHmac('sha256', secret).update(payload).digest('hex');
  try {
    return crypto.timingSafeEqual(
      Buffer.from(expected),
      Buffer.from(signature),
    );
  } catch {
    return false;
  }
}

/**
 * Build a group folder name from a GitHub repo and issue/PR number.
 * Format: github_{owner}-{repo}-{number}
 * Truncates the repo portion if the result would exceed 64 chars.
 */
export function makeGitHubFolder(repo: string, number: number): string {
  const prefix = 'github_';
  const suffix = `-${number}`;
  const maxRepoLen = 64 - prefix.length - suffix.length;
  const sanitized = repo
    .replace(/\//g, '-')
    .replace(/[^A-Za-z0-9-]/g, '')
    .slice(0, maxRepoLen);
  return `${prefix}${sanitized}${suffix}`;
}

/**
 * Extract the issue/PR number from a webhook payload.
 * For check_suite events, uses the first associated pull request.
 * Returns null if no number can be determined.
 */
function extractIssueNumber(event: string, payload: any): number | null {
  switch (event) {
    case 'issues':
      return payload.issue?.number ?? null;
    case 'issue_comment':
      return payload.issue?.number ?? null;
    case 'pull_request':
      return payload.pull_request?.number ?? null;
    case 'pull_request_review':
      return payload.pull_request?.number ?? null;
    case 'pull_request_review_comment':
      return payload.pull_request?.number ?? null;
    case 'check_suite':
      return payload.check_suite?.pull_requests?.[0]?.number ?? null;
    default:
      return null;
  }
}

/**
 * Determine the GitHub group type from a webhook event.
 * Returns 'pull_request', 'issue', or 'repo'.
 */
function extractGroupType(
  event: string,
  payload: any,
): 'pull_request' | 'issue' | 'repo' {
  switch (event) {
    case 'pull_request':
    case 'pull_request_review':
    case 'pull_request_review_comment':
      return 'pull_request';
    case 'issues':
      return 'issue';
    case 'issue_comment':
      // issue_comment fires for both issues and PRs; check for PR indicator
      return payload.issue?.pull_request ? 'pull_request' : 'issue';
    case 'check_suite':
      return payload.check_suite?.pull_requests?.length
        ? 'pull_request'
        : 'repo';
    default:
      return 'repo';
  }
}

/** Extract the title from a webhook payload (PR title or issue title). */
function extractTitle(event: string, payload: any): string | undefined {
  switch (event) {
    case 'pull_request':
    case 'pull_request_review':
    case 'pull_request_review_comment':
      return payload.pull_request?.title;
    case 'issues':
    case 'issue_comment':
      return payload.issue?.title;
    default:
      return undefined;
  }
}

/**
 * Extract the author (opener) of the issue or PR from a webhook payload.
 * Returns null when the author cannot be determined (e.g. check_suite).
 */
export function extractAuthor(event: string, payload: any): string | null {
  switch (event) {
    case 'pull_request':
    case 'pull_request_review':
    case 'pull_request_review_comment':
      return payload.pull_request?.user?.login ?? null;
    case 'issues':
    case 'issue_comment':
      return payload.issue?.user?.login ?? null;
    default:
      return null;
  }
}

interface FormattedEvent {
  text: string;
  metadata?: Record<string, string>;
}

/** Format a GitHub webhook event into a human-readable message */
function formatEvent(event: string, payload: any): FormattedEvent | null {
  const repo = payload.repository?.full_name || 'unknown';

  switch (event) {
    case 'issues': {
      const { action, issue } = payload;
      if (action === 'opened' || action === 'closed' || action === 'reopened') {
        return {
          text: `[GitHub] Issue ${action}: #${issue.number} "${issue.title}" in ${repo}\n${issue.html_url}`,
        };
      }
      return null;
    }

    case 'pull_request': {
      const { action, pull_request: pr } = payload;
      if (
        action === 'opened' ||
        action === 'closed' ||
        action === 'reopened' ||
        action === 'ready_for_review'
      ) {
        const merged = action === 'closed' && pr.merged ? 'merged' : action;
        return {
          text: `[GitHub] PR ${merged}: #${pr.number} "${pr.title}" in ${repo}\n${pr.html_url}`,
        };
      }
      return null;
    }

    case 'issue_comment': {
      const { action, comment, issue } = payload;
      if (action === 'created') {
        const type = issue.pull_request ? 'PR' : 'Issue';
        const body =
          comment.body.length > 200
            ? comment.body.slice(0, 200) + '...'
            : comment.body;
        return {
          text: `[GitHub] New comment on ${type} #${issue.number} "${issue.title}" by ${comment.user.login}:\n${body}\n${comment.html_url}`,
          metadata: {
            github_repo: repo,
            github_comment_id: String(comment.id),
            github_endpoint: 'issues',
          },
        };
      }
      return null;
    }

    case 'pull_request_review': {
      const { action, review, pull_request: pr } = payload;
      if (action === 'submitted' && review.state !== 'commented') {
        return {
          text: `[GitHub] PR #${pr.number} "${pr.title}" review: ${review.state} by ${review.user.login}\n${review.html_url}`,
        };
      }
      return null;
    }

    case 'pull_request_review_comment': {
      const { action, comment, pull_request: pr } = payload;
      if (action === 'created') {
        const body =
          comment.body.length > 200
            ? comment.body.slice(0, 200) + '...'
            : comment.body;
        return {
          text: `[GitHub] Review comment on PR #${pr.number} "${pr.title}" by ${comment.user.login}:\n${body}\n${comment.html_url}`,
          metadata: {
            github_repo: repo,
            github_comment_id: String(comment.id),
            github_endpoint: 'pulls',
          },
        };
      }
      return null;
    }

    case 'check_suite': {
      const { action, check_suite: suite } = payload;
      if (action === 'completed' && suite.conclusion !== 'success') {
        const branch = suite.head_branch || 'unknown';
        return {
          text: `[GitHub] Check suite ${suite.conclusion} on ${branch} in ${repo}\n${suite.url}`,
        };
      }
      return null;
    }

    default:
      return null;
  }
}

export class GitHubChannel implements Channel {
  name = 'github';

  private server: http.Server | null = null;
  private opts: ChannelOpts;
  private webhookSecret: string;
  private port: number;
  private token: string;
  /** If set, only process events from these GitHub usernames */
  private allowedSenders: Set<string> | null;
  /** GitHub username of the bot — PRs opened by this user skip the trigger */
  private botUsername: string;

  constructor(
    webhookSecret: string,
    port: number,
    token: string,
    allowedSenders: string[],
    opts: ChannelOpts,
    botUsername: string = '',
  ) {
    this.webhookSecret = webhookSecret;
    this.port = port;
    this.token = token;
    this.allowedSenders =
      allowedSenders.length > 0 ? new Set(allowedSenders) : null;
    this.opts = opts;
    this.botUsername = botUsername;
  }

  async connect(): Promise<void> {
    const app = express();

    // Parse raw body for signature verification
    app.use(express.json({ limit: '1mb' }));

    app.post('/webhook', (req, res) => {
      const signature = req.headers['x-hub-signature-256'] as string;
      const event = req.headers['x-github-event'] as string;
      const deliveryId = req.headers['x-github-delivery'] as string;

      if (!signature || !event) {
        res.status(400).json({ error: 'Missing required headers' });
        return;
      }

      // Verify HMAC signature
      const rawBody = JSON.stringify(req.body);
      if (!verifySignature(this.webhookSecret, rawBody, signature)) {
        logger.warn({ deliveryId }, 'GitHub webhook signature mismatch');
        res.status(401).json({ error: 'Invalid signature' });
        return;
      }

      // Acknowledge immediately
      res.status(200).json({ ok: true });

      // Skip unsupported events
      if (!SUPPORTED_EVENTS.has(event)) {
        logger.debug({ event }, 'Skipping unsupported GitHub event');
        return;
      }

      const payload = req.body;
      const repo = payload.repository?.full_name;
      if (!repo) {
        logger.warn({ event }, 'GitHub webhook missing repository');
        return;
      }

      const timestamp = new Date().toISOString();
      const senderName =
        payload.sender?.login || payload.sender?.id?.toString() || 'github';

      // Filter by allowed senders if configured
      if (this.allowedSenders && !this.allowedSenders.has(senderName)) {
        logger.debug(
          { sender: senderName, event },
          'GitHub event from non-allowed sender, skipping',
        );
        return;
      }

      // Determine the JID: per-issue/PR if possible, otherwise repo-level
      const issueNumber = extractIssueNumber(event, payload);
      const chatJid = issueNumber ? `gh:${repo}#${issueNumber}` : `gh:${repo}`;

      // Store chat metadata for discovery
      const chatName = issueNumber ? `${repo}#${issueNumber}` : repo;
      this.opts.onChatMetadata(chatJid, timestamp, chatName, 'github', false);

      // Auto-register group if not already registered
      if (this.opts.registerGroup) {
        const registered = this.opts.registeredGroups();
        if (!registered[chatJid]) {
          const folder = issueNumber
            ? makeGitHubFolder(repo, issueNumber)
            : `github_${repo
                .replace(/\//g, '-')
                .replace(/[^A-Za-z0-9-]/g, '')
                .slice(0, 57)}`;
          const groupType = extractGroupType(event, payload);
          const title = extractTitle(event, payload);
          const metadata: Record<string, string> = { type: groupType };
          if (title) metadata.title = title;

          // Skip trigger for PRs/issues opened by the bot itself
          const author = extractAuthor(event, payload);
          const isBotAuthor = !!this.botUsername && author === this.botUsername;
          this.opts.registerGroup(chatJid, {
            name: chatName,
            folder,
            trigger: `@${ASSISTANT_NAME}`,
            added_at: timestamp,
            requiresTrigger: !isBotAuthor,
            metadata,
          });
          logger.info({ chatJid, folder }, 'Auto-registered GitHub group');
        }
      }

      // Format the event into a human-readable message
      const formatted = formatEvent(event, payload);
      if (!formatted) return;

      // Deliver message
      this.opts.onMessage(chatJid, {
        id: deliveryId || crypto.randomUUID(),
        chat_jid: chatJid,
        sender: senderName,
        sender_name: senderName,
        content: formatted.text,
        timestamp,
        is_from_me: false,
        metadata: formatted.metadata,
      });

      logger.info(
        { event, repo, chatJid, deliveryId },
        'GitHub webhook event processed',
      );
    });

    // Health check
    app.get('/health', (_req, res) => {
      res.json({ status: 'ok', channel: 'github' });
    });

    return new Promise<void>((resolve, reject) => {
      this.server = app.listen(this.port, () => {
        logger.info({ port: this.port }, 'GitHub webhook server listening');
        console.log(
          `\n  GitHub webhooks: http://localhost:${this.port}/webhook`,
        );
        resolve();
      });
      this.server.on('error', reject);
    });
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    // Parse JID: gh:owner/repo#123 or gh:owner/repo
    const match = jid.match(/^gh:(.+?)(?:#(\d+))?$/);
    if (!match) {
      logger.error({ jid }, 'Invalid GitHub JID format');
      return;
    }
    const repo = match[1];
    const issueNumber = match[2] ? parseInt(match[2], 10) : null;

    if (!issueNumber) {
      logger.warn(
        { jid },
        'GitHub JID has no issue/PR number — cannot post comment',
      );
      return;
    }

    const url = `https://api.github.com/repos/${repo}/issues/${issueNumber}/comments`;
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.token}`,
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ body: text }),
      });

      if (!res.ok) {
        const body = await res.text();
        logger.error(
          { jid, issueNumber, status: res.status, body },
          'GitHub API error posting comment',
        );
        return;
      }

      logger.info(
        { jid, issueNumber, length: text.length },
        'GitHub comment posted',
      );
    } catch (err) {
      logger.error({ jid, issueNumber, err }, 'Failed to post GitHub comment');
    }
  }

  async ack(jid: string, context?: Record<string, string>): Promise<void> {
    if (!this.token || !context) return;
    const repo = context.github_repo;
    const commentId = context.github_comment_id;
    const endpoint = context.github_endpoint as 'issues' | 'pulls' | undefined;
    if (!repo || !commentId || !endpoint) return;
    await this.addReaction(repo, parseInt(commentId, 10), 'eyes', endpoint);
  }

  private async addReaction(
    repo: string,
    commentId: number,
    reaction: string,
    endpoint: 'issues' | 'pulls',
  ): Promise<void> {
    const apiPath =
      endpoint === 'pulls'
        ? `repos/${repo}/pulls/comments/${commentId}/reactions`
        : `repos/${repo}/issues/comments/${commentId}/reactions`;
    const url = `https://api.github.com/${apiPath}`;
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.token}`,
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ content: reaction }),
      });
      if (!res.ok) {
        const body = await res.text();
        logger.warn(
          { repo, commentId, reaction, status: res.status, body },
          'GitHub API error adding reaction',
        );
      }
    } catch (err) {
      logger.warn(
        { repo, commentId, reaction, err },
        'Failed to add GitHub reaction',
      );
    }
  }

  isConnected(): boolean {
    return this.server !== null && this.server.listening;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('gh:');
  }

  async disconnect(): Promise<void> {
    if (this.server) {
      await new Promise<void>((resolve) => {
        this.server!.close(() => resolve());
      });
      this.server = null;
      logger.info('GitHub webhook server stopped');
    }
  }
}

registerChannel('github', (opts: ChannelOpts) => {
  const envVars = readEnvFile([
    'GITHUB_WEBHOOK_SECRET',
    'GITHUB_WEBHOOK_PORT',
    'GITHUB_TOKEN',
    'GITHUB_ALLOWED_SENDERS',
    'GITHUB_BOT_USERNAME',
  ]);
  const secret =
    process.env.GITHUB_WEBHOOK_SECRET || envVars.GITHUB_WEBHOOK_SECRET || '';
  const port = parseInt(
    process.env.GITHUB_WEBHOOK_PORT || envVars.GITHUB_WEBHOOK_PORT || '0',
    10,
  );
  const token = process.env.GITHUB_TOKEN || envVars.GITHUB_TOKEN || '';
  const allowedSendersRaw =
    process.env.GITHUB_ALLOWED_SENDERS || envVars.GITHUB_ALLOWED_SENDERS || '';
  const allowedSenders = allowedSendersRaw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  if (!secret || !port) {
    logger.warn('GitHub: GITHUB_WEBHOOK_SECRET or GITHUB_WEBHOOK_PORT not set');
    return null;
  }

  if (!token) {
    logger.warn(
      'GitHub: GITHUB_TOKEN not set — webhook events will be received but replies will not be posted',
    );
  }

  const botUsername =
    process.env.GITHUB_BOT_USERNAME || envVars.GITHUB_BOT_USERNAME || '';

  if (allowedSenders.length > 0) {
    logger.info({ allowedSenders }, 'GitHub: sender allowlist active');
  }

  if (botUsername) {
    logger.info(
      { botUsername },
      'GitHub: bot username configured — own PRs will skip trigger',
    );
  }

  return new GitHubChannel(
    secret,
    port,
    token,
    allowedSenders,
    opts,
    botUsername,
  );
});
