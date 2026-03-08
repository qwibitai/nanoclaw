import { logger } from '../logger.js';
import {
  Channel,
  OnChatMetadata,
  OnInboundMessage,
  RegisteredGroup,
} from '../types.js';
import { MATTERMOST_BOT_TOKEN, MATTERMOST_URL, TRIGGER_PATTERN } from '../config.js';

export interface MattermostChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
}

interface MattermostPost {
  id: string;
  channel_id: string;
  user_id: string;
  message: string;
  create_at: number;
  update_at: number;
  metadata?: {
    embeds?: Array<{
      type: string;
      data?: Record<string, unknown>;
    }>;
  };
}

interface MattermostUser {
  id: string;
  username: string;
  first_name?: string;
  last_name?: string;
}

interface MattermostChannelInfo {
  id: string;
  display_name: string;
  name: string;
  type: string;
}

export class MattermostChannel implements Channel {
  name = 'mattermost';

  private opts: MattermostChannelOpts;
  private baseUrl: string;
  private botToken: string;
  private lastPostTimes: Map<string, number> = new Map();
  private pollInterval: ReturnType<typeof setInterval> | null = null;
  private botUserId: string | null = null;

  constructor(baseUrl: string, botToken: string, opts: MattermostChannelOpts) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.botToken = botToken;
    this.opts = opts;
  }

  private async apiCall<T>(endpoint: string, options: RequestInit = {}): Promise<T> {
    const response = await fetch(`${this.baseUrl}/api/v4${endpoint}`, {
      ...options,
      headers: {
        'Authorization': `Bearer ${this.botToken}`,
        'Content-Type': 'application/json',
        ...options.headers,
      },
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Mattermost API error: ${response.status} ${error}`);
    }

    return response.json() as T;
  }

  async connect(): Promise<void> {
    try {
      // Get bot user info
      const me = await this.apiCall<MattermostUser>('/users/me');
      this.botUserId = me.id;
      logger.info({ username: me.username, userId: me.id }, 'Mattermost bot connected');

      // Start polling for new messages
      this.pollInterval = setInterval(() => this.pollMessages(), 2000);

      console.log(`\n  Mattermost bot: @${me.username}`);
      console.log(`  Send a direct message or mention in a channel\n`);
    } catch (err) {
      logger.error({ err }, 'Failed to connect to Mattermost');
      throw err;
    }
  }

  private async pollMessages(): Promise<void> {
    if (!this.botUserId) return;

    try {
      // Get posts in channels the bot is a member of
      const channels = await this.apiCall<MattermostChannelInfo[]>('/channels/members/' + this.botUserId + '/channels');

      for (const channel of channels) {
        // Get posts since last check
        const lastPostTime = this.lastPostTimes.get(channel.id) || 0;
        
        const posts = await this.apiCall<{ posts: Record<string, MattermostPost> }>(
          `/channels/${channel.id}/posts?since=${lastPostTime}`
        );

        for (const post of Object.values(posts.posts)) {
          // Skip our own messages
          if (post.user_id === this.botUserId) continue;

          // Skip system messages
          if (post.message.startsWith('<')) continue;

          const chatJid = `mm:${channel.id}`;
          const timestamp = new Date(post.create_at).toISOString();

          // Get sender info
          let senderName = 'Unknown';
          try {
            const user = await this.apiCall<MattermostUser>(`/users/${post.user_id}`);
            senderName = user.first_name || user.username || 'Unknown';
          } catch {
            // Use default if user lookup fails
          }

          // Determine if this is a group channel
          const isGroup = channel.type === 'P' || channel.type === 'G';

          // Store chat metadata
          this.opts.onChatMetadata(chatJid, timestamp, channel.display_name, 'mattermost', isGroup);

          // Check if channel is registered
          const group = this.opts.registeredGroups()[chatJid];
          if (!group) {
            logger.debug({ chatJid, channelName: channel.display_name }, 'Message from unregistered Mattermost channel');
            continue;
          }

          // Check if trigger is required
          let content = post.message;
          const isMainGroup = group.folder === 'main';
          if (!isMainGroup && group.requiresTrigger !== false) {
            if (!TRIGGER_PATTERN.test(content.trim())) {
              continue;
            }
            // Remove trigger from content
            content = content.replace(TRIGGER_PATTERN, '').trim();
          }

          // Deliver message
          this.opts.onMessage(chatJid, {
            id: post.id,
            chat_jid: chatJid,
            sender: post.user_id,
            sender_name: senderName,
            content,
            timestamp,
            is_from_me: false,
          });

          logger.info({ chatJid, channelName: channel.display_name, sender: senderName }, 'Mattermost message received');
        }

        // Update last post time
        const postsArray = Object.values(posts.posts);
        if (postsArray.length > 0) {
          const latestTime = Math.max(...postsArray.map(p => p.create_at));
          this.lastPostTimes.set(channel.id, latestTime);
        }
      }
    } catch (err) {
      logger.error({ err }, 'Error polling Mattermost messages');
    }
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    try {
      const channelId = jid.replace(/^mm:/, '');

      // Mattermost has a 16383 character limit per message — split if needed
      const MAX_LENGTH = 16383;
      if (text.length <= MAX_LENGTH) {
        await this.apiCall('/posts', {
          method: 'POST',
          body: JSON.stringify({
            channel_id: channelId,
            message: text,
          }),
        });
      } else {
        for (let i = 0; i < text.length; i += MAX_LENGTH) {
          await this.apiCall('/posts', {
            method: 'POST',
            body: JSON.stringify({
              channel_id: channelId,
              message: text.slice(i, i + MAX_LENGTH),
            }),
          });
        }
      }

      logger.info({ jid, length: text.length }, 'Mattermost message sent');
    } catch (err) {
      logger.error({ jid, err }, 'Failed to send Mattermost message');
    }
  }

  isConnected(): boolean {
    return this.botUserId !== null;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('mm:');
  }

  async disconnect(): Promise<void> {
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = null;
    }
    this.botUserId = null;
    logger.info('Mattermost bot stopped');
  }

  async setTyping(jid: string, isTyping: boolean): Promise<void> {
    // Mattermost doesn't have a typing indicator API for bots
    // This is a no-op
  }
}
