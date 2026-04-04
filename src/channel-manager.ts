// Copyright (c) 2026 Botler 360 SAS. All rights reserved.
// See LICENSE.md for license terms.

import './channels/index.js';
import {
  getChannelFactory,
  getRegisteredChannelNames,
} from './channels/registry.js';
import { storeChatMetadata, storeMessage } from './db.js';
import { findChannel } from './router.js';
import {
  isSenderAllowed,
  isTriggerAllowed,
  loadSenderAllowlist,
  shouldDropMessage,
} from './sender-allowlist.js';
import {
  restoreRemoteControl,
  startRemoteControl,
  stopRemoteControl,
} from './remote-control.js';
import { logger } from './logger.js';
import { incCounter } from './metrics.js';
import { Channel, NewMessage } from './types.js';
import { lastGchatReplyTarget, registeredGroups } from './state.js';

export const channels: Channel[] = [];

/**
 * Initialize and connect all registered channels.
 * Each channel self-registers via the barrel import above.
 * Factories return null when credentials are missing, so unconfigured channels are skipped.
 */
export async function initChannels(remoteControlPin: string): Promise<void> {
  restoreRemoteControl();

  // Handle /remote-control and /remote-control-end commands
  async function handleRemoteControl(
    command: string,
    chatJid: string,
    msg: NewMessage,
  ): Promise<void> {
    const group = registeredGroups[chatJid];
    if (!group?.isMain) {
      logger.warn(
        { chatJid, sender: msg.sender },
        'Remote control rejected: not main group',
      );
      return;
    }

    const channel = findChannel(channels, chatJid);
    if (!channel) return;

    // PIN authentication for /remote-control (not required for /remote-control-end)
    if (
      command.startsWith('/remote-control') &&
      command !== '/remote-control-end'
    ) {
      if (!remoteControlPin) {
        await channel.sendMessage(
          chatJid,
          'Remote control is disabled (REMOTE_CONTROL_PIN not configured).',
        );
        return;
      }
      const parts = command.split(/\s+/);
      const suppliedPin = parts[1] || '';
      if (suppliedPin !== remoteControlPin) {
        logger.warn(
          { chatJid, sender: msg.sender },
          'Remote control: access denied (wrong PIN)',
        );
        await channel.sendMessage(chatJid, 'Access denied');
        return;
      }
    }

    if (
      command.startsWith('/remote-control') &&
      command !== '/remote-control-end'
    ) {
      const result = await startRemoteControl(
        msg.sender,
        chatJid,
        process.cwd(),
      );
      if (result.ok) {
        await channel.sendMessage(chatJid, result.url);
      } else {
        await channel.sendMessage(
          chatJid,
          `Remote Control failed: ${result.error}`,
        );
      }
    } else {
      const result = stopRemoteControl();
      if (result.ok) {
        await channel.sendMessage(chatJid, 'Remote Control session ended.');
      } else {
        await channel.sendMessage(chatJid, result.error);
      }
    }
  }

  // Channel callbacks (shared by all channels)
  const channelOpts = {
    onMessage: (chatJid: string, msg: NewMessage) => {
      // Remote control commands — intercept before storage
      const trimmed = msg.content.trim();
      if (trimmed.startsWith('/remote-control')) {
        handleRemoteControl(trimmed, chatJid, msg).catch((err) =>
          logger.error({ err, chatJid }, 'Remote control command error'),
        );
        return;
      }

      // Track received message metric
      const ch = findChannel(channels, chatJid);
      incCounter('nanoclaw_messages_received_total', {
        channel: ch?.name ?? 'unknown',
      });

      // Sender allowlist drop mode: discard messages from denied senders before storing
      if (!msg.is_from_me && !msg.is_bot_message && registeredGroups[chatJid]) {
        const cfg = loadSenderAllowlist();
        if (
          shouldDropMessage(chatJid, cfg) &&
          !isSenderAllowed(chatJid, msg.sender, cfg)
        ) {
          if (cfg.logDenied) {
            logger.debug(
              { chatJid, sender: msg.sender },
              'sender-allowlist: dropping message (drop mode)',
            );
          }
          return;
        }
      }
      // Track Google Chat reply target for cross-posting
      const gchatMatch = msg.content.match(/\[Reply to: (gchat:spaces\/\S+)\]/);
      if (gchatMatch) {
        const group = registeredGroups[chatJid];
        if (group) {
          lastGchatReplyTarget[group.folder] = gchatMatch[1];
        }
      }

      storeMessage(msg);
    },
    onChatMetadata: (
      chatJid: string,
      timestamp: string,
      name?: string,
      channel?: string,
      isGroup?: boolean,
    ) => storeChatMetadata(chatJid, timestamp, name, channel, isGroup),
    registeredGroups: () => registeredGroups,
  };

  // Create and connect all registered channels.
  for (const channelName of getRegisteredChannelNames()) {
    const factory = getChannelFactory(channelName)!;
    const channel = factory(channelOpts);
    if (!channel) {
      logger.warn(
        { channel: channelName },
        'Channel installed but credentials missing — skipping. Check .env or re-run the channel skill.',
      );
      continue;
    }
    channels.push(channel);
    await channel.connect();
  }
  if (channels.length === 0) {
    logger.fatal('No channels connected');
    process.exit(1);
  }
}
