/**
 * GitHub Channel for NanoClaw
 *
 * Receives GitHub webhook events (issues, PRs, comments) via HTTP and
 * routes them through the standard NanoClaw message pipeline so agents
 * can respond automatically.
 *
 * Supported events:
 *   - issues / assigned          → agent assigned to an issue
 *   - pull_request / review_requested → agent requested as reviewer
 *   - issue_comment / created    → @mention in issue comment
 *   - pull_request_review_comment / created → @mention in PR review comment
 *
 * JID format: github:{owner}/{repo}#{number}
 * sendMessage posts an issue/PR comment via the REST API.
 */
import crypto from 'crypto';
import http from 'http';

import { Octokit } from '@octokit/rest';

import { readEnvFile } from '../env.js';
import { logger } from '../logger.js';
import { Channel, NewMessage } from '../types.js';
import { ChannelOpts, registerChannel } from './registry.js';

// Maximum comment length before chunking (GitHub API limit is ~65536 bytes but we keep it readable)
const MAX_COMMENT_LENGTH = 4000;

// Parse a GitHub JID into its components
function parseGithubJid(
  jid: string,
): { owner: string; repo: string; number: number } | null {
  const match = jid.match(/^github:([^/]+)\/([^#]+)#(\d+)$/);
  if (!match) return null;
  return { owner: match[1], repo: match[2], number: parseInt(match[3], 10) };
}

function buildJid(repoFullName: string, number: number): string {
  return `github:${repoFullName}#${number}`;
}

// Split long text into chunks at newline boundaries
function chunkText(text: string, maxLen: number): string[] {
  if (text.length <= maxLen) return [text];
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > maxLen) {
    let splitAt = remaining.lastIndexOf('\n', maxLen);
    if (splitAt <= 0) splitAt = maxLen;
    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt).trimStart();
  }
  if (remaining.length > 0) chunks.push(remaining);
  return chunks;
}

export interface GitHubChannelOpts extends ChannelOpts {
  token: string;
  webhookSecret: string;
  botUsername: string;
  port: number;
}

export class GitHubChannel implements Channel {
  name = 'github';
  private connected = false;
  private server: http.Server | null = null;
  private octokit: Octokit;
  private opts: GitHubChannelOpts;

  constructor(opts: GitHubChannelOpts) {
    this.opts = opts;
    this.octokit = new Octokit({ auth: opts.token });
  }

  async connect(): Promise<void> {
    this.server = http.createServer((req, res) => {
      if (req.method === 'POST' && req.url === '/github/webhook') {
        this.handleWebhookRequest(req, res);
      } else {
        res.writeHead(404);
        res.end();
      }
    });

    await new Promise<void>((resolve, reject) => {
      this.server!.listen(this.opts.port, () => {
        logger.info(`GitHub webhook listening on port ${this.opts.port}`);
        resolve();
      });
      this.server!.on('error', reject);
    });

    this.connected = true;
  }

  isConnected(): boolean {
    return this.connected;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('github:');
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    const parsed = parseGithubJid(jid);
    if (!parsed) {
      logger.error({ jid }, 'GitHub sendMessage: invalid JID format');
      return;
    }
    const chunks = chunkText(text, MAX_COMMENT_LENGTH);
    for (const chunk of chunks) {
      await this.octokit.rest.issues.createComment({
        owner: parsed.owner,
        repo: parsed.repo,
        issue_number: parsed.number,
        body: chunk,
      });
    }
  }

  async disconnect(): Promise<void> {
    if (this.server) {
      await new Promise<void>((resolve) => this.server!.close(() => resolve()));
      this.server = null;
    }
    this.connected = false;
  }

  // ---- Webhook handling ----

  private handleWebhookRequest(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): void {
    const chunks: Buffer[] = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      const signature = req.headers['x-hub-signature-256'] as
        | string
        | undefined;
      const event = req.headers['x-github-event'] as string | undefined;

      if (!this.verifySignature(body, signature)) {
        logger.warn('GitHub webhook: invalid signature');
        res.writeHead(401);
        res.end('Unauthorized');
        return;
      }

      res.writeHead(200);
      res.end('OK');

      try {
        const payload = JSON.parse(body.toString('utf8'));
        this.dispatchEvent(event ?? '', payload);
      } catch (err) {
        logger.error({ err }, 'GitHub webhook: failed to parse payload');
      }
    });
  }

  private verifySignature(
    body: Buffer,
    signature: string | undefined,
  ): boolean {
    if (!signature) return false;
    const hmac = crypto.createHmac('sha256', this.opts.webhookSecret);
    hmac.update(body);
    const expected = `sha256=${hmac.digest('hex')}`;
    try {
      return crypto.timingSafeEqual(
        Buffer.from(expected),
        Buffer.from(signature),
      );
    } catch {
      return false;
    }
  }

  private dispatchEvent(event: string, payload: Record<string, unknown>): void {
    const action = payload.action as string | undefined;

    if (event === 'issues' && action === 'assigned') {
      this.handleIssueAssigned(payload);
    } else if (event === 'pull_request' && action === 'review_requested') {
      this.handlePrReviewRequested(payload);
    } else if (event === 'issue_comment' && action === 'created') {
      this.handleIssueComment(payload);
    } else if (
      event === 'pull_request_review_comment' &&
      action === 'created'
    ) {
      this.handlePrReviewComment(payload);
    }
  }

  private handleIssueAssigned(payload: Record<string, unknown>): void {
    const assignee = (payload.assignee as Record<string, unknown> | undefined)
      ?.login as string | undefined;
    if (assignee !== this.opts.botUsername) return;

    const issue = payload.issue as Record<string, unknown>;
    const repo = payload.repository as Record<string, unknown>;
    const number = issue.number as number;
    const jid = buildJid(repo.full_name as string, number);
    const content = `[issue assigned] ${issue.title as string}\n\n${(issue.body as string) ?? ''}`;

    this.deliver(
      jid,
      `github-issue-assigned-${issue.id as number}`,
      assignee,
      content,
      repo,
    );
  }

  private handlePrReviewRequested(payload: Record<string, unknown>): void {
    const requestedReviewer = payload.requested_reviewer as
      | Record<string, unknown>
      | undefined;
    if (
      !requestedReviewer ||
      (requestedReviewer.login as string) !== this.opts.botUsername
    )
      return;

    const pr = payload.pull_request as Record<string, unknown>;
    const repo = payload.repository as Record<string, unknown>;
    const number = pr.number as number;
    const jid = buildJid(repo.full_name as string, number);
    const content = `[PR review requested] ${pr.title as string}\n\n${(pr.body as string) ?? ''}`;

    this.deliver(
      jid,
      `github-pr-review-${pr.id as number}`,
      requestedReviewer.login as string,
      content,
      repo,
    );
  }

  private handleIssueComment(payload: Record<string, unknown>): void {
    const comment = payload.comment as Record<string, unknown>;
    const sender = payload.sender as Record<string, unknown>;
    // Ignore bot's own comments to prevent loops
    if ((sender.login as string) === this.opts.botUsername) return;
    const body = comment.body as string;
    if (!body.includes(`@${this.opts.botUsername}`)) return;

    const issue = payload.issue as Record<string, unknown>;
    const repo = payload.repository as Record<string, unknown>;
    const jid = buildJid(repo.full_name as string, issue.number as number);

    this.deliver(
      jid,
      `github-issue-comment-${comment.id as number}`,
      sender.login as string,
      body,
      repo,
    );
  }

  private handlePrReviewComment(payload: Record<string, unknown>): void {
    const comment = payload.comment as Record<string, unknown>;
    const sender = payload.sender as Record<string, unknown>;
    if ((sender.login as string) === this.opts.botUsername) return;
    const body = comment.body as string;
    if (!body.includes(`@${this.opts.botUsername}`)) return;

    const pr = payload.pull_request as Record<string, unknown>;
    const repo = payload.repository as Record<string, unknown>;
    const jid = buildJid(repo.full_name as string, pr.number as number);

    this.deliver(
      jid,
      `github-pr-comment-${comment.id as number}`,
      sender.login as string,
      body,
      repo,
    );
  }

  private deliver(
    jid: string,
    id: string,
    senderLogin: string,
    content: string,
    repo: Record<string, unknown>,
  ): void {
    const timestamp = new Date().toISOString();
    const repoName = repo.full_name as string;

    const msg: NewMessage = {
      id,
      chat_jid: jid,
      sender: senderLogin,
      sender_name: senderLogin,
      content,
      timestamp,
    };

    this.opts.onChatMetadata(jid, timestamp, repoName, 'github', true);
    this.opts.onMessage(jid, msg);
    logger.debug({ jid, id }, 'GitHub: delivered message');
  }
}

registerChannel('github', (opts: ChannelOpts) => {
  const env = readEnvFile([
    'GITHUB_TOKEN',
    'GITHUB_WEBHOOK_SECRET',
    'GITHUB_BOT_USERNAME',
    'GITHUB_WEBHOOK_PORT',
  ]);

  if (!env.GITHUB_TOKEN) {
    logger.debug('GitHub channel: GITHUB_TOKEN not set, skipping');
    return null;
  }
  if (!env.GITHUB_WEBHOOK_SECRET) {
    logger.debug('GitHub channel: GITHUB_WEBHOOK_SECRET not set, skipping');
    return null;
  }
  if (!env.GITHUB_BOT_USERNAME) {
    logger.debug('GitHub channel: GITHUB_BOT_USERNAME not set, skipping');
    return null;
  }

  const port = parseInt(env.GITHUB_WEBHOOK_PORT ?? '3002', 10);

  return new GitHubChannel({
    ...opts,
    token: env.GITHUB_TOKEN,
    webhookSecret: env.GITHUB_WEBHOOK_SECRET,
    botUsername: env.GITHUB_BOT_USERNAME,
    port,
  });
});
