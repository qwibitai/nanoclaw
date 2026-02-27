/**
 * GitHub channel for NanoClaw.
 * Polls GitHub notifications API, auto-registers issues/PRs as groups,
 * and posts comments back via the API.
 */
import { ASSISTANT_NAME, MAIN_GROUP_FOLDER } from '../config.js';
import { getRouterState, setRouterState, storeMessageDirect } from '../db.js';
import { logger } from '../logger.js';
import {
  Channel,
  OnInboundMessage,
  OnChatMetadata,
  RegisteredGroup,
} from '../types.js';

const POLL_INTERVAL_MS = 30_000; // 30 seconds
const JID_SUFFIX = '@github';

export interface GitHubChannelOpts {
  token: string;
  username: string;
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
  registerGroup: (jid: string, group: RegisteredGroup) => void;
}

interface GitHubNotification {
  id: string;
  subject: {
    title: string;
    url: string;
    type: string;
  };
  repository: {
    full_name: string;
  };
  updated_at: string;
  reason: string;
}

interface GitHubComment {
  id: number;
  user: { login: string };
  body: string;
  created_at: string;
}

export class GitHubChannel implements Channel {
  name = 'github';

  private connected = false;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private opts: GitHubChannelOpts;

  // Track last comment cursor per JID (persisted via router state)
  private commentCursors: Record<string, number> = {};

  constructor(opts: GitHubChannelOpts) {
    this.opts = opts;
  }

  async connect(): Promise<void> {
    // Load persisted comment cursors
    const saved = getRouterState('github_comment_cursors');
    if (saved) {
      try {
        this.commentCursors = JSON.parse(saved);
      } catch {
        this.commentCursors = {};
      }
    }

    this.connected = true;

    // Start polling
    this.pollTimer = setInterval(() => {
      this.pollNotifications().catch((err) =>
        logger.error({ err }, 'GitHub poll error'),
      );
    }, POLL_INTERVAL_MS);

    // Initial poll
    this.pollNotifications().catch((err) =>
      logger.error({ err }, 'GitHub initial poll error'),
    );

    logger.info('GitHub channel connected (polling)');
  }

  async sendMessage(
    jid: string,
    text: string,
    _options?: { thread_ts?: string },
  ): Promise<void> {
    // Parse JID to get the issue/PR comment URL
    // JID format: owner/repo#123@github
    const match = jid.replace(JID_SUFFIX, '').match(/^(.+?)#(\d+)$/);
    if (!match) {
      logger.warn({ jid }, 'Cannot parse GitHub JID for sending');
      return;
    }

    const [, repoFullName, number] = match;

    // Prefix with assistant name
    const prefixed = `**${ASSISTANT_NAME}:** ${text}`;

    try {
      const response = await this.githubFetch(
        `https://api.github.com/repos/${repoFullName}/issues/${number}/comments`,
        {
          method: 'POST',
          body: JSON.stringify({ body: prefixed }),
        },
      );

      if (!response.ok) {
        const body = await response.text();
        logger.error(
          { jid, status: response.status, body },
          'Failed to post GitHub comment',
        );
      }
    } catch (err) {
      logger.error({ jid, err }, 'Error posting GitHub comment');
    }
  }

  isConnected(): boolean {
    return this.connected;
  }

  ownsJid(jid: string): boolean {
    return jid.endsWith(JID_SUFFIX);
  }

  async disconnect(): Promise<void> {
    this.connected = false;
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  private async pollNotifications(): Promise<void> {
    try {
      const response = await this.githubFetch(
        'https://api.github.com/notifications?participating=true&all=false',
      );

      if (!response.ok) {
        logger.warn(
          { status: response.status },
          'GitHub notifications API error',
        );
        return;
      }

      const notifications = (await response.json()) as GitHubNotification[];

      for (const notif of notifications) {
        if (
          notif.subject.type !== 'Issue' &&
          notif.subject.type !== 'PullRequest'
        ) {
          continue;
        }

        await this.processNotification(notif);
      }
    } catch (err) {
      logger.error({ err }, 'Error polling GitHub notifications');
    }
  }

  private async processNotification(notif: GitHubNotification): Promise<void> {
    // Extract issue/PR number from the API URL
    const urlParts = notif.subject.url.split('/');
    const number = urlParts[urlParts.length - 1];
    const repoFullName = notif.repository.full_name;
    const chatJid = `${repoFullName}#${number}${JID_SUFFIX}`;

    const groups = this.opts.registeredGroups();

    // Auto-register if not already registered
    if (!groups[chatJid]) {
      this.opts.registerGroup(chatJid, {
        name: `${repoFullName}#${number}: ${notif.subject.title}`,
        folder: MAIN_GROUP_FOLDER, // GitHub issues share the main folder
        trigger: `@${ASSISTANT_NAME}`,
        added_at: new Date().toISOString(),
        requiresTrigger: true,
      });
    }

    // Notify metadata
    this.opts.onChatMetadata(
      chatJid,
      notif.updated_at,
      notif.subject.title,
      'github',
      false,
    );

    // Fetch new comments
    await this.fetchNewComments(
      chatJid,
      repoFullName,
      number,
      notif.subject.type,
    );

    // Mark notification as read
    try {
      await this.githubFetch(
        `https://api.github.com/notifications/threads/${notif.id}`,
        { method: 'PATCH' },
      );
    } catch {
      // ignore
    }
  }

  private async fetchNewComments(
    chatJid: string,
    repoFullName: string,
    number: string,
    subjectType: string,
  ): Promise<void> {
    const lastCursor = this.commentCursors[chatJid] || 0;

    // Fetch issue/PR comments
    const comments = await this.fetchComments(
      `https://api.github.com/repos/${repoFullName}/issues/${number}/comments`,
    );

    // For PRs, also fetch review comments
    let reviewComments: GitHubComment[] = [];
    if (subjectType === 'PullRequest') {
      reviewComments = await this.fetchComments(
        `https://api.github.com/repos/${repoFullName}/pulls/${number}/comments`,
      );
    }

    const allComments = [...comments, ...reviewComments]
      .filter((c) => c.id > lastCursor)
      .filter((c) => c.user.login !== this.opts.username) // Filter own comments
      .sort((a, b) => a.id - b.id);

    if (allComments.length === 0) return;

    // Update cursor
    const maxId = Math.max(...allComments.map((c) => c.id));
    this.commentCursors[chatJid] = maxId;
    this.saveCursors();

    // Store and deliver messages
    for (const comment of allComments) {
      const timestamp = new Date(comment.created_at).toISOString();
      const msg = {
        id: `gh-${comment.id}`,
        chat_jid: chatJid,
        sender: comment.user.login,
        sender_name: comment.user.login,
        content: comment.body,
        timestamp,
        is_from_me: false,
        is_bot_message: false,
      };

      storeMessageDirect(msg);
      this.opts.onMessage(chatJid, msg);
    }

    logger.info(
      { chatJid, newComments: allComments.length },
      'Fetched new GitHub comments',
    );
  }

  private async fetchComments(url: string): Promise<GitHubComment[]> {
    try {
      const response = await this.githubFetch(
        `${url}?per_page=100&sort=created&direction=desc`,
      );
      if (!response.ok) return [];
      return (await response.json()) as GitHubComment[];
    } catch {
      return [];
    }
  }

  private saveCursors(): void {
    setRouterState(
      'github_comment_cursors',
      JSON.stringify(this.commentCursors),
    );
  }

  private async githubFetch(
    url: string,
    init?: RequestInit,
  ): Promise<Response> {
    return fetch(url, {
      ...init,
      headers: {
        Authorization: `Bearer ${this.opts.token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        ...(init?.headers || {}),
      },
    });
  }
}
