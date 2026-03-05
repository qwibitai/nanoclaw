import crypto from 'crypto';
import express from 'express';
import http from 'http';

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

/** Format a GitHub webhook event into a human-readable message */
function formatEvent(event: string, payload: any): string | null {
  const repo = payload.repository?.full_name || 'unknown';

  switch (event) {
    case 'issues': {
      const { action, issue } = payload;
      if (action === 'opened' || action === 'closed' || action === 'reopened') {
        return `[GitHub] Issue ${action}: #${issue.number} "${issue.title}" in ${repo}\n${issue.html_url}`;
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
        return `[GitHub] PR ${merged}: #${pr.number} "${pr.title}" in ${repo}\n${pr.html_url}`;
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
        return `[GitHub] New comment on ${type} #${issue.number} "${issue.title}" by ${comment.user.login}:\n${body}\n${comment.html_url}`;
      }
      return null;
    }

    case 'pull_request_review': {
      const { action, review, pull_request: pr } = payload;
      if (action === 'submitted' && review.state !== 'commented') {
        return `[GitHub] PR #${pr.number} "${pr.title}" review: ${review.state} by ${review.user.login}\n${review.html_url}`;
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
        return `[GitHub] Review comment on PR #${pr.number} "${pr.title}" by ${comment.user.login}:\n${body}\n${comment.html_url}`;
      }
      return null;
    }

    case 'check_suite': {
      const { action, check_suite: suite } = payload;
      if (action === 'completed' && suite.conclusion !== 'success') {
        const branch = suite.head_branch || 'unknown';
        return `[GitHub] Check suite ${suite.conclusion} on ${branch} in ${repo}\n${suite.url}`;
      }
      return null;
    }

    default:
      return null;
  }
}

/** Extract the issue or PR number from a webhook payload */
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
  /** Tracks the most recent issue/PR number per JID for reply routing */
  private replyTargets = new Map<string, number>();

  constructor(
    webhookSecret: string,
    port: number,
    token: string,
    allowedSenders: string[],
    opts: ChannelOpts,
  ) {
    this.webhookSecret = webhookSecret;
    this.port = port;
    this.token = token;
    this.allowedSenders =
      allowedSenders.length > 0 ? new Set(allowedSenders) : null;
    this.opts = opts;
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

      const chatJid = `gh:${repo}`;
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

      // Store chat metadata for discovery
      this.opts.onChatMetadata(chatJid, timestamp, repo, 'github', false);

      // Track the issue/PR number so sendMessage can reply to it
      const issueNumber = extractIssueNumber(event, payload);
      if (issueNumber !== null) {
        this.replyTargets.set(chatJid, issueNumber);
      }

      // Format the event into a human-readable message
      const text = formatEvent(event, payload);
      if (!text) return;

      // Deliver message
      this.opts.onMessage(chatJid, {
        id: deliveryId || crypto.randomUUID(),
        chat_jid: chatJid,
        sender: senderName,
        sender_name: senderName,
        content: text,
        timestamp,
        is_from_me: false,
      });

      logger.info(
        { event, repo, deliveryId },
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
    const match = jid.match(/^gh:(.+)$/);
    if (!match) {
      logger.error({ jid }, 'Invalid GitHub JID format');
      return;
    }
    const repo = match[1]; // e.g. "owner/repo"

    const issueNumber = this.replyTargets.get(jid);
    if (!issueNumber) {
      logger.warn(
        { jid },
        'No reply target for GitHub JID — no issue/PR to comment on',
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

  if (allowedSenders.length > 0) {
    logger.info({ allowedSenders }, 'GitHub: sender allowlist active');
  }

  return new GitHubChannel(secret, port, token, allowedSenders, opts);
});
