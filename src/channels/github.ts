/**
 * GitHub Channel
 * Implements the Channel interface for GitHub (issues, PRs, comments, reviews).
 */
import { Octokit } from '@octokit/rest';

import { GitHubTokenManager } from '../github/auth.js';
import { parseRepoFromJid } from '../github/event-mapper.js';
import { logger } from '../logger.js';
import { Channel, OnInboundMessage, OnChatMetadata, RegisteredGroup } from '../types.js';

export interface GitHubResponseTarget {
  type: 'issue_comment' | 'pr_comment' | 'pr_review' | 'new_pr';
  issueNumber?: number;
  prNumber?: number;
  reviewAction?: 'APPROVE' | 'REQUEST_CHANGES' | 'COMMENT';
  reviewComments?: Array<{ path: string; line: number; body: string }>;
  head?: string;
  base?: string;
  title?: string;
}

export interface GitHubChannelOpts {
  tokenManager: GitHubTokenManager;
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
}

export class GitHubChannel implements Channel {
  name = 'github';

  private tokenManager: GitHubTokenManager;
  private connected = false;
  private opts: GitHubChannelOpts;

  constructor(opts: GitHubChannelOpts) {
    this.opts = opts;
    this.tokenManager = opts.tokenManager;
  }

  async connect(): Promise<void> {
    // Validate credentials by fetching app info
    try {
      await this.tokenManager.getAppSlug();
      this.connected = true;
      logger.info('GitHub channel connected');
    } catch (err) {
      logger.error({ err }, 'Failed to connect GitHub channel');
      throw err;
    }
  }

  /**
   * Send a message (comment) to a GitHub thread.
   * JID format: 'gh:owner/repo#issue:42' or 'gh:owner/repo#pr:17'
   */
  async sendMessage(jid: string, text: string): Promise<void> {
    const { owner, repo } = parseRepoFromJid(jid);
    const threadPart = jid.split('#')[1];
    if (!threadPart) {
      logger.warn({ jid }, 'Cannot send message: no thread specified');
      return;
    }

    const octokit = await this.tokenManager.getOctokitForRepo(owner, repo);
    const [type, numberStr] = threadPart.split(':');
    const number = parseInt(numberStr, 10);

    if (isNaN(number)) {
      logger.warn({ jid, threadPart }, 'Invalid thread number');
      return;
    }

    // Both issues and PRs use the issues API for comments
    await octokit.issues.createComment({
      owner,
      repo,
      issue_number: number,
      body: text,
    });

    logger.info({ jid, type, number, length: text.length }, 'GitHub comment posted');
  }

  /**
   * Send a structured response (review, new PR, etc.).
   */
  async sendStructuredMessage(jid: string, text: string, target: GitHubResponseTarget): Promise<void> {
    const { owner, repo } = parseRepoFromJid(jid);
    const octokit = await this.tokenManager.getOctokitForRepo(owner, repo);

    switch (target.type) {
      case 'issue_comment':
        await octokit.issues.createComment({
          owner,
          repo,
          issue_number: target.issueNumber!,
          body: text,
        });
        break;

      case 'pr_comment':
        await octokit.issues.createComment({
          owner,
          repo,
          issue_number: target.prNumber!,
          body: text,
        });
        break;

      case 'pr_review':
        await octokit.pulls.createReview({
          owner,
          repo,
          pull_number: target.prNumber!,
          body: text,
          event: target.reviewAction || 'COMMENT',
          comments: target.reviewComments?.map(c => ({
            path: c.path,
            line: c.line,
            body: c.body,
          })),
        });
        break;

      case 'new_pr':
        await octokit.pulls.create({
          owner,
          repo,
          title: target.title || 'New PR',
          body: text,
          head: target.head!,
          base: target.base || 'main',
        });
        break;
    }

    logger.info({ jid, targetType: target.type }, 'GitHub structured message sent');
  }

  isConnected(): boolean {
    return this.connected;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('gh:');
  }

  async disconnect(): Promise<void> {
    this.connected = false;
  }

  /**
   * Typing indicator: create/update a check run on the PR's head commit.
   * This shows a yellow status dot indicating the bot is working.
   */
  async setTyping(jid: string, isTyping: boolean): Promise<void> {
    // Only supported for PR threads
    const threadPart = jid.split('#')[1];
    if (!threadPart || !threadPart.startsWith('pr:')) return;

    // Typing indicators on GitHub are best-effort, don't fail on errors
    try {
      const { owner, repo } = parseRepoFromJid(jid);
      const octokit = await this.tokenManager.getOctokitForRepo(owner, repo);

      if (isTyping) {
        // We'd need the head SHA to create a check run.
        // For now, this is a no-op since we'd need to look up the PR.
        // TODO: implement check-run based status indicator
        logger.debug({ jid }, 'Typing indicator (GitHub check runs) not yet implemented');
      }
    } catch (err) {
      logger.debug({ jid, err }, 'Failed to update typing status');
    }
  }
}
