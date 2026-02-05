import fs from 'node:fs';
import path from 'node:path';

import { logger } from './lib/logger.js';
import type { SkillResult } from './lib/types.js';

import { createDiscordThread } from './scripts/create_thread.js';
import { deleteDiscordMessage } from './scripts/delete.js';
import { sendDiscordDM } from './scripts/dm.js';
import { editDiscordMessage } from './scripts/edit.js';
import { getDiscordChannelInfo } from './scripts/get_channel_info.js';
import { getDiscordGuildInfo } from './scripts/get_guild_info.js';
import { getDiscordMessages } from './scripts/get_messages.js';
import { getDiscordUser } from './scripts/get_user.js';
import { listDiscordChannels } from './scripts/list_channels.js';
import { listDiscordGuilds } from './scripts/list_guilds.js';
import { listDiscordMembers } from './scripts/list_members.js';
import { pinDiscordMessage } from './scripts/pin.js';
import { addDiscordReaction } from './scripts/react.js';
import { sendDiscordReply } from './scripts/reply.js';
import { sendDiscordMessage } from './scripts/send.js';
import { unpinDiscordMessage } from './scripts/unpin.js';
import { sendDiscordWebhook } from './scripts/webhook_send.js';

export {
  destroyDiscordClient,
  ensureConnected,
  getDiscordClient,
  initDiscordClient,
  isDiscordReady,
} from './lib/discord-client.js';

function writeResult(
  dataDir: string,
  sourceGroup: string,
  requestId: string,
  result: SkillResult,
): void {
  const resultsDir = path.join(dataDir, 'ipc', sourceGroup, 'discord_results');
  fs.mkdirSync(resultsDir, { recursive: true });
  fs.writeFileSync(
    path.join(resultsDir, `${requestId}.json`),
    JSON.stringify(result),
  );
}

export async function handleDiscordIpc(
  data: Record<string, unknown>,
  sourceGroup: string,
  _isMain: boolean,
  dataDir: string,
): Promise<boolean> {
  const type = data.type as string;

  if (!type?.startsWith('discord_')) {
    return false;
  }

  const requestId = data.requestId as string;
  if (!requestId) {
    logger.warn({ type }, 'Discord IPC blocked: missing requestId');
    return true;
  }

  logger.info({ type, requestId, sourceGroup }, 'Processing Discord request');

  let result: SkillResult;

  switch (type) {
    case 'discord_send':
      if (!data.channelId || !data.content) {
        result = { success: false, message: 'Missing channelId or content' };
        break;
      }
      result = await sendDiscordMessage({
        channelId: data.channelId as string,
        content: data.content as string,
      });
      break;

    case 'discord_reply':
      if (!data.channelId || !data.messageId || !data.content) {
        result = {
          success: false,
          message: 'Missing channelId, messageId, or content',
        };
        break;
      }
      result = await sendDiscordReply({
        channelId: data.channelId as string,
        messageId: data.messageId as string,
        content: data.content as string,
      });
      break;

    case 'discord_react':
      if (!data.channelId || !data.messageId || !data.emoji) {
        result = {
          success: false,
          message: 'Missing channelId, messageId, or emoji',
        };
        break;
      }
      result = await addDiscordReaction({
        channelId: data.channelId as string,
        messageId: data.messageId as string,
        emoji: data.emoji as string,
      });
      break;

    case 'discord_edit':
      if (!data.channelId || !data.messageId || !data.content) {
        result = {
          success: false,
          message: 'Missing channelId, messageId, or content',
        };
        break;
      }
      result = await editDiscordMessage({
        channelId: data.channelId as string,
        messageId: data.messageId as string,
        content: data.content as string,
      });
      break;

    case 'discord_delete':
      if (!data.channelId || !data.messageId) {
        result = {
          success: false,
          message: 'Missing channelId or messageId',
        };
        break;
      }
      result = await deleteDiscordMessage({
        channelId: data.channelId as string,
        messageId: data.messageId as string,
      });
      break;

    case 'discord_pin':
      if (!data.channelId || !data.messageId) {
        result = { success: false, message: 'Missing channelId or messageId' };
        break;
      }
      result = await pinDiscordMessage({
        channelId: data.channelId as string,
        messageId: data.messageId as string,
      });
      break;

    case 'discord_unpin':
      if (!data.channelId || !data.messageId) {
        result = { success: false, message: 'Missing channelId or messageId' };
        break;
      }
      result = await unpinDiscordMessage({
        channelId: data.channelId as string,
        messageId: data.messageId as string,
      });
      break;

    case 'discord_get_messages':
      if (!data.channelId) {
        result = { success: false, message: 'Missing channelId' };
        break;
      }
      result = await getDiscordMessages({
        channelId: data.channelId as string,
        limit: (data.limit as number) || 50,
        before: data.before as string | undefined,
      });
      break;

    case 'discord_create_thread':
      if (!data.channelId || !data.name) {
        result = { success: false, message: 'Missing channelId or name' };
        break;
      }
      result = await createDiscordThread({
        channelId: data.channelId as string,
        name: data.name as string,
        messageId: data.messageId as string | undefined,
        autoArchiveDuration:
          (data.autoArchiveDuration as 60 | 1440 | 4320 | 10080) || 1440,
      });
      break;

    case 'discord_list_channels':
      if (!data.guildId) {
        result = { success: false, message: 'Missing guildId' };
        break;
      }
      result = await listDiscordChannels({ guildId: data.guildId as string });
      break;

    case 'discord_get_channel_info':
      if (!data.channelId) {
        result = { success: false, message: 'Missing channelId' };
        break;
      }
      result = await getDiscordChannelInfo({
        channelId: data.channelId as string,
      });
      break;

    case 'discord_get_user':
      if (!data.userId) {
        result = { success: false, message: 'Missing userId' };
        break;
      }
      result = await getDiscordUser({ userId: data.userId as string });
      break;

    case 'discord_list_members':
      if (!data.guildId) {
        result = { success: false, message: 'Missing guildId' };
        break;
      }
      result = await listDiscordMembers({
        guildId: data.guildId as string,
        limit: (data.limit as number) || 100,
      });
      break;

    case 'discord_dm':
      if (!data.userId || !data.content) {
        result = { success: false, message: 'Missing userId or content' };
        break;
      }
      result = await sendDiscordDM({
        userId: data.userId as string,
        content: data.content as string,
      });
      break;

    case 'discord_list_guilds':
      result = await listDiscordGuilds();
      break;

    case 'discord_get_guild_info':
      if (!data.guildId) {
        result = { success: false, message: 'Missing guildId' };
        break;
      }
      result = await getDiscordGuildInfo({ guildId: data.guildId as string });
      break;

    case 'discord_webhook_send':
      if (!data.webhookUrl || !data.content) {
        result = { success: false, message: 'Missing webhookUrl or content' };
        break;
      }
      result = await sendDiscordWebhook({
        webhookUrl: data.webhookUrl as string,
        content: data.content as string,
        username: data.username as string | undefined,
        avatarUrl: data.avatarUrl as string | undefined,
      });
      break;

    default:
      return false;
  }

  writeResult(dataDir, sourceGroup, requestId, result);

  if (result.success) {
    logger.info({ type, requestId }, 'Discord request completed');
  } else {
    logger.error(
      { type, requestId, message: result.message },
      'Discord request failed',
    );
  }

  return true;
}
