/**
 * ChannelManager — manages messaging channel lifecycle and message dispatch.
 *
 * Extracted from AgentImpl for single-responsibility. Handles channel
 * registration, connection, message handler construction, outbound
 * message formatting, and remote control commands.
 */

import type {
  ChannelDriverFactory,
  ChannelDriverConfig,
} from '../api/channel-driver.js';
import type { Channel, NewMessage } from '../types.js';
import { logger } from '../logger.js';
import { findChannel, formatOutbound } from '../router.js';
import {
  isSenderAllowed,
  loadSenderAllowlist,
  shouldDropMessage,
} from '../sender-allowlist.js';
import {
  restoreRemoteControl,
  startRemoteControl,
  stopRemoteControl,
} from '../remote-control.js';
import type { AgentContext } from './agent-context.js';

export class ChannelManager {
  constructor(private readonly ctx: AgentContext) {}

  /** Add a channel via factory. Only after start(). */
  async addChannel(key: string, factory: ChannelDriverFactory): Promise<void> {
    if (!this.ctx.started) {
      throw new Error('Call start() before addChannel()');
    }
    if (this.ctx.channels.has(key)) {
      throw new Error(
        `Channel "${key}" already registered on agent "${this.ctx.name}"`,
      );
    }
    const config = this.buildDriverConfig();
    const driver = await factory(config);
    const channel = driver as Channel;
    (channel as { name: string }).name = key;
    this.ctx.channels.set(key, channel);
    await channel.connect();
    logger.info({ channel: key, agent: this.ctx.name }, 'Channel connected');
    this.ctx.emit('channel.connected', { key });
  }

  /** Remove and disconnect a channel. */
  async removeChannel(key: string): Promise<void> {
    const channel = this.ctx.channels.get(key);
    if (!channel) return;
    if (channel.isConnected?.()) {
      await channel.disconnect();
    }
    this.ctx.channels.delete(key);
    this.ctx.emit('channel.disconnected', { key });
  }

  /** Build the config object passed to ChannelDriverFactory. */
  buildDriverConfig(): ChannelDriverConfig {
    const handler = this.buildDefaultChannelHandler();
    return {
      onMessage: handler.onMessage as ChannelDriverConfig['onMessage'],
      onChatMetadata: handler.onChatMetadata,
      registeredGroups: handler.registeredGroups as () => Record<
        string,
        unknown
      >,
    };
  }

  /** Build default channel handler — stores messages, intercepts remote control. */
  private buildDefaultChannelHandler() {
    return {
      onMessage: (chatJid: string, msg: NewMessage) => {
        const trimmed = msg.content.trim();
        if (
          trimmed === '/remote-control' ||
          trimmed === '/remote-control-end'
        ) {
          this.handleRemoteControl(trimmed, chatJid, msg).catch((err) =>
            logger.error({ err, chatJid }, 'Remote control command error'),
          );
          return;
        }

        if (
          !msg.is_from_me &&
          !msg.is_bot_message &&
          this.ctx.registeredGroups[chatJid]
        ) {
          const cfg = loadSenderAllowlist();
          if (
            shouldDropMessage(chatJid, cfg) &&
            !isSenderAllowed(chatJid, msg.sender, cfg)
          ) {
            return;
          }
        }
        this.ctx.db.storeMessage(msg);
        this.ctx.emit('message.in', {
          jid: chatJid,
          sender: msg.sender,
          text: msg.content,
          timestamp: msg.timestamp,
        });
      },
      onChatMetadata: (
        chatJid: string,
        timestamp: string,
        name?: string,
        channel?: string,
        isGroup?: boolean,
      ) => {
        this.ctx.db.storeChatMetadata(
          chatJid,
          timestamp,
          name,
          channel,
          isGroup,
        );
        this.ctx.emit('chat.metadata', {
          jid: chatJid,
          timestamp,
          name,
          channel,
          isGroup,
        });
      },
      registeredGroups: () => this.ctx.registeredGroups,
    };
  }

  /** Get the channel array for router compatibility. */
  get channelArray(): Channel[] {
    return [...this.ctx.channels.values()];
  }

  /** Format and send an outbound message via the appropriate channel. */
  async sendOutboundMessage(
    jid: string,
    rawText: string,
    channel?: Channel,
  ): Promise<boolean> {
    const targetChannel = channel ?? findChannel(this.channelArray, jid);
    if (!targetChannel) {
      logger.warn({ jid }, 'No channel owns JID, cannot send');
      return false;
    }

    const text = formatOutbound(rawText);
    if (!text) return false;

    await targetChannel.sendMessage(jid, text);
    this.ctx.emit('message.out', {
      jid,
      text,
      timestamp: new Date().toISOString(),
    });
    return true;
  }

  /** Restore remote control session from previous run. */
  restoreRemoteControl(): void {
    restoreRemoteControl(this.ctx.config.dataDir);
  }

  /** Handle /remote-control and /remote-control-end commands. */
  private async handleRemoteControl(
    command: string,
    chatJid: string,
    msg: NewMessage,
  ): Promise<void> {
    const group = this.ctx.registeredGroups[chatJid];
    if (!group?.isMain) {
      logger.warn(
        { chatJid, sender: msg.sender },
        'Remote control rejected: not main group',
      );
      return;
    }

    const channel = findChannel(this.channelArray, chatJid);
    if (!channel) return;

    if (command === '/remote-control') {
      const result = await startRemoteControl(
        msg.sender,
        chatJid,
        this.ctx.config.workDir,
        this.ctx.config.dataDir,
      );
      if (result.ok) {
        await this.sendOutboundMessage(chatJid, result.url, channel);
      } else {
        await this.sendOutboundMessage(
          chatJid,
          `Remote Control failed: ${result.error}`,
          channel,
        );
      }
    } else {
      const result = stopRemoteControl(this.ctx.config.dataDir);
      if (result.ok) {
        await this.sendOutboundMessage(
          chatJid,
          'Remote Control session ended.',
          channel,
        );
      } else {
        await this.sendOutboundMessage(chatJid, result.error, channel);
      }
    }
  }
}
