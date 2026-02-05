/**
 * Discord Integration - MCP Tool Definitions (Agent/Container Side)
 *
 * These tools run inside the container and communicate with the host via IPC.
 * The host-side implementation is in host.ts.
 *
 * Note: This file is compiled in the container, not on the host.
 * The @ts-ignore is needed because the SDK is only available in the container.
 */

import fs from 'node:fs';
import path from 'node:path';

// @ts-ignore - SDK available in container environment only
import { tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';

const IPC_DIR = '/workspace/ipc';
const TASKS_DIR = path.join(IPC_DIR, 'tasks');
const RESULTS_DIR = path.join(IPC_DIR, 'discord_results');

function writeIpcFile(dir: string, data: object): string {
  fs.mkdirSync(dir, { recursive: true });
  const filename = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`;
  const filepath = path.join(dir, filename);
  const tempPath = `${filepath}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(data, null, 2));
  fs.renameSync(tempPath, filepath);
  return filename;
}

async function waitForResult(
  requestId: string,
  maxWait = 30000,
): Promise<{ success: boolean; message: string; data?: unknown }> {
  const resultFile = path.join(RESULTS_DIR, `${requestId}.json`);
  const pollInterval = 500;
  let elapsed = 0;

  while (elapsed < maxWait) {
    if (fs.existsSync(resultFile)) {
      try {
        const result = JSON.parse(fs.readFileSync(resultFile, 'utf-8'));
        fs.unlinkSync(resultFile);
        return result;
      } catch (err) {
        return { success: false, message: `Failed to read result: ${err}` };
      }
    }
    await new Promise((resolve) => setTimeout(resolve, pollInterval));
    elapsed += pollInterval;
  }

  return { success: false, message: 'Request timed out' };
}

export interface SkillToolsContext {
  groupFolder: string;
  isMain: boolean;
  isScheduledTask?: boolean;
}

function checkPermission(
  isMain: boolean,
  isScheduledTask?: boolean,
): string | null {
  if (!isScheduledTask && !isMain) {
    return 'Only the main group can use Discord tools interactively. Scheduled tasks can use any tool.';
  }
  return null;
}

function validateSnowflake(id: string, fieldName: string): string | null {
  if (!id.match(/^\d+$/)) {
    return `Invalid ${fieldName}. Must be a Discord snowflake ID (numeric string).`;
  }
  return null;
}

export function createDiscordTools(ctx: SkillToolsContext) {
  const { groupFolder, isMain, isScheduledTask } = ctx;

  async function executeIpc(
    type: string,
    payload: Record<string, unknown>,
  ): Promise<{
    content: Array<{ type: string; text: string }>;
    isError?: boolean;
  }> {
    const requestId = `${type}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    writeIpcFile(TASKS_DIR, {
      type,
      requestId,
      ...payload,
      groupFolder,
      timestamp: new Date().toISOString(),
    });

    const result = await waitForResult(requestId);
    const text = result.data
      ? `${result.message}\n\nData:\n${JSON.stringify(result.data, null, 2)}`
      : result.message;

    return {
      content: [{ type: 'text', text }],
      isError: !result.success,
    };
  }

  return [
    // ==================== MESSAGE TOOLS ====================
    tool(
      'discord_send',
      `Send a message to a Discord channel. Messages over 2000 characters will be split automatically.`,
      {
        channel_id: z.string().describe('Discord channel ID (snowflake)'),
        content: z
          .string()
          .max(4000)
          .describe('Message content (max 4000 chars)'),
      },
      async (args: { channel_id: string; content: string }) => {
        const permErr = checkPermission(isMain, isScheduledTask);
        if (permErr)
          return { content: [{ type: 'text', text: permErr }], isError: true };

        const idErr = validateSnowflake(args.channel_id, 'channel_id');
        if (idErr)
          return { content: [{ type: 'text', text: idErr }], isError: true };

        return executeIpc('discord_send', {
          channelId: args.channel_id,
          content: args.content,
        });
      },
    ),

    tool(
      'discord_reply',
      `Reply to a specific Discord message.`,
      {
        channel_id: z.string().describe('Discord channel ID'),
        message_id: z.string().describe('Message ID to reply to'),
        content: z.string().max(4000).describe('Reply content'),
      },
      async (args: {
        channel_id: string;
        message_id: string;
        content: string;
      }) => {
        const permErr = checkPermission(isMain, isScheduledTask);
        if (permErr)
          return { content: [{ type: 'text', text: permErr }], isError: true };

        const chErr = validateSnowflake(args.channel_id, 'channel_id');
        if (chErr)
          return { content: [{ type: 'text', text: chErr }], isError: true };

        const msgErr = validateSnowflake(args.message_id, 'message_id');
        if (msgErr)
          return { content: [{ type: 'text', text: msgErr }], isError: true };

        return executeIpc('discord_reply', {
          channelId: args.channel_id,
          messageId: args.message_id,
          content: args.content,
        });
      },
    ),

    tool(
      'discord_react',
      `Add an emoji reaction to a Discord message.`,
      {
        channel_id: z.string().describe('Discord channel ID'),
        message_id: z.string().describe('Message ID to react to'),
        emoji: z
          .string()
          .describe('Emoji (Unicode like "👍" or custom "<:name:id>")'),
      },
      async (args: {
        channel_id: string;
        message_id: string;
        emoji: string;
      }) => {
        const permErr = checkPermission(isMain, isScheduledTask);
        if (permErr)
          return { content: [{ type: 'text', text: permErr }], isError: true };

        const chErr = validateSnowflake(args.channel_id, 'channel_id');
        if (chErr)
          return { content: [{ type: 'text', text: chErr }], isError: true };

        const msgErr = validateSnowflake(args.message_id, 'message_id');
        if (msgErr)
          return { content: [{ type: 'text', text: msgErr }], isError: true };

        return executeIpc('discord_react', {
          channelId: args.channel_id,
          messageId: args.message_id,
          emoji: args.emoji,
        });
      },
    ),

    tool(
      'discord_edit',
      `Edit a message sent by the bot.`,
      {
        channel_id: z.string().describe('Discord channel ID'),
        message_id: z
          .string()
          .describe('Message ID to edit (must be bot message)'),
        content: z.string().max(4000).describe('New message content'),
      },
      async (args: {
        channel_id: string;
        message_id: string;
        content: string;
      }) => {
        const permErr = checkPermission(isMain, isScheduledTask);
        if (permErr)
          return { content: [{ type: 'text', text: permErr }], isError: true };

        const chErr = validateSnowflake(args.channel_id, 'channel_id');
        if (chErr)
          return { content: [{ type: 'text', text: chErr }], isError: true };

        const msgErr = validateSnowflake(args.message_id, 'message_id');
        if (msgErr)
          return { content: [{ type: 'text', text: msgErr }], isError: true };

        return executeIpc('discord_edit', {
          channelId: args.channel_id,
          messageId: args.message_id,
          content: args.content,
        });
      },
    ),

    tool(
      'discord_delete',
      `Delete a message. Bot can delete its own messages or messages in channels where it has Manage Messages permission.`,
      {
        channel_id: z.string().describe('Discord channel ID'),
        message_id: z.string().describe('Message ID to delete'),
      },
      async (args: { channel_id: string; message_id: string }) => {
        const permErr = checkPermission(isMain, isScheduledTask);
        if (permErr)
          return { content: [{ type: 'text', text: permErr }], isError: true };

        const chErr = validateSnowflake(args.channel_id, 'channel_id');
        if (chErr)
          return { content: [{ type: 'text', text: chErr }], isError: true };

        const msgErr = validateSnowflake(args.message_id, 'message_id');
        if (msgErr)
          return { content: [{ type: 'text', text: msgErr }], isError: true };

        return executeIpc('discord_delete', {
          channelId: args.channel_id,
          messageId: args.message_id,
        });
      },
    ),

    tool(
      'discord_pin',
      `Pin a message in a channel. Requires Manage Messages permission.`,
      {
        channel_id: z.string().describe('Discord channel ID'),
        message_id: z.string().describe('Message ID to pin'),
      },
      async (args: { channel_id: string; message_id: string }) => {
        const permErr = checkPermission(isMain, isScheduledTask);
        if (permErr)
          return { content: [{ type: 'text', text: permErr }], isError: true };

        const chErr = validateSnowflake(args.channel_id, 'channel_id');
        if (chErr)
          return { content: [{ type: 'text', text: chErr }], isError: true };

        const msgErr = validateSnowflake(args.message_id, 'message_id');
        if (msgErr)
          return { content: [{ type: 'text', text: msgErr }], isError: true };

        return executeIpc('discord_pin', {
          channelId: args.channel_id,
          messageId: args.message_id,
        });
      },
    ),

    tool(
      'discord_unpin',
      `Unpin a message from a channel. Requires Manage Messages permission.`,
      {
        channel_id: z.string().describe('Discord channel ID'),
        message_id: z.string().describe('Message ID to unpin'),
      },
      async (args: { channel_id: string; message_id: string }) => {
        const permErr = checkPermission(isMain, isScheduledTask);
        if (permErr)
          return { content: [{ type: 'text', text: permErr }], isError: true };

        const chErr = validateSnowflake(args.channel_id, 'channel_id');
        if (chErr)
          return { content: [{ type: 'text', text: chErr }], isError: true };

        const msgErr = validateSnowflake(args.message_id, 'message_id');
        if (msgErr)
          return { content: [{ type: 'text', text: msgErr }], isError: true };

        return executeIpc('discord_unpin', {
          channelId: args.channel_id,
          messageId: args.message_id,
        });
      },
    ),

    tool(
      'discord_get_messages',
      `Get recent messages from a channel. Returns up to 100 messages.`,
      {
        channel_id: z.string().describe('Discord channel ID'),
        limit: z
          .number()
          .min(1)
          .max(100)
          .default(50)
          .describe('Number of messages to fetch (1-100)'),
        before: z
          .string()
          .optional()
          .describe('Get messages before this message ID'),
      },
      async (args: { channel_id: string; limit: number; before?: string }) => {
        const permErr = checkPermission(isMain, isScheduledTask);
        if (permErr)
          return { content: [{ type: 'text', text: permErr }], isError: true };

        const chErr = validateSnowflake(args.channel_id, 'channel_id');
        if (chErr)
          return { content: [{ type: 'text', text: chErr }], isError: true };

        if (args.before) {
          const beforeErr = validateSnowflake(args.before, 'before');
          if (beforeErr)
            return {
              content: [{ type: 'text', text: beforeErr }],
              isError: true,
            };
        }

        return executeIpc('discord_get_messages', {
          channelId: args.channel_id,
          limit: args.limit,
          before: args.before,
        });
      },
    ),

    // ==================== CHANNEL TOOLS ====================
    tool(
      'discord_create_thread',
      `Create a thread from a message or as a standalone thread in a channel.`,
      {
        channel_id: z.string().describe('Discord channel ID'),
        name: z.string().max(100).describe('Thread name'),
        message_id: z
          .string()
          .optional()
          .describe('Message ID to create thread from (optional)'),
        auto_archive_duration: z
          .enum(['60', '1440', '4320', '10080'])
          .default('1440')
          .describe(
            'Auto-archive after minutes: 60 (1h), 1440 (24h), 4320 (3d), 10080 (7d)',
          ),
      },
      async (args: {
        channel_id: string;
        name: string;
        message_id?: string;
        auto_archive_duration: string;
      }) => {
        const permErr = checkPermission(isMain, isScheduledTask);
        if (permErr)
          return { content: [{ type: 'text', text: permErr }], isError: true };

        const chErr = validateSnowflake(args.channel_id, 'channel_id');
        if (chErr)
          return { content: [{ type: 'text', text: chErr }], isError: true };

        if (args.message_id) {
          const msgErr = validateSnowflake(args.message_id, 'message_id');
          if (msgErr)
            return { content: [{ type: 'text', text: msgErr }], isError: true };
        }

        return executeIpc('discord_create_thread', {
          channelId: args.channel_id,
          name: args.name,
          messageId: args.message_id,
          autoArchiveDuration: parseInt(args.auto_archive_duration, 10),
        });
      },
    ),

    tool(
      'discord_list_channels',
      `List all channels in a server (guild).`,
      {
        guild_id: z.string().describe('Discord server (guild) ID'),
      },
      async (args: { guild_id: string }) => {
        const permErr = checkPermission(isMain, isScheduledTask);
        if (permErr)
          return { content: [{ type: 'text', text: permErr }], isError: true };

        const guildErr = validateSnowflake(args.guild_id, 'guild_id');
        if (guildErr)
          return { content: [{ type: 'text', text: guildErr }], isError: true };

        return executeIpc('discord_list_channels', { guildId: args.guild_id });
      },
    ),

    tool(
      'discord_get_channel_info',
      `Get detailed information about a channel.`,
      {
        channel_id: z.string().describe('Discord channel ID'),
      },
      async (args: { channel_id: string }) => {
        const permErr = checkPermission(isMain, isScheduledTask);
        if (permErr)
          return { content: [{ type: 'text', text: permErr }], isError: true };

        const chErr = validateSnowflake(args.channel_id, 'channel_id');
        if (chErr)
          return { content: [{ type: 'text', text: chErr }], isError: true };

        return executeIpc('discord_get_channel_info', {
          channelId: args.channel_id,
        });
      },
    ),

    // ==================== USER TOOLS ====================
    tool(
      'discord_get_user',
      `Get information about a Discord user.`,
      {
        user_id: z.string().describe('Discord user ID'),
      },
      async (args: { user_id: string }) => {
        const permErr = checkPermission(isMain, isScheduledTask);
        if (permErr)
          return { content: [{ type: 'text', text: permErr }], isError: true };

        const userErr = validateSnowflake(args.user_id, 'user_id');
        if (userErr)
          return { content: [{ type: 'text', text: userErr }], isError: true };

        return executeIpc('discord_get_user', { userId: args.user_id });
      },
    ),

    tool(
      'discord_list_members',
      `List members in a server. Requires Server Members Intent.`,
      {
        guild_id: z.string().describe('Discord server (guild) ID'),
        limit: z
          .number()
          .min(1)
          .max(1000)
          .default(100)
          .describe('Number of members to fetch'),
      },
      async (args: { guild_id: string; limit: number }) => {
        const permErr = checkPermission(isMain, isScheduledTask);
        if (permErr)
          return { content: [{ type: 'text', text: permErr }], isError: true };

        const guildErr = validateSnowflake(args.guild_id, 'guild_id');
        if (guildErr)
          return { content: [{ type: 'text', text: guildErr }], isError: true };

        return executeIpc('discord_list_members', {
          guildId: args.guild_id,
          limit: args.limit,
        });
      },
    ),

    tool(
      'discord_dm',
      `Send a direct message to a user.`,
      {
        user_id: z.string().describe('Discord user ID'),
        content: z.string().max(4000).describe('Message content'),
      },
      async (args: { user_id: string; content: string }) => {
        const permErr = checkPermission(isMain, isScheduledTask);
        if (permErr)
          return { content: [{ type: 'text', text: permErr }], isError: true };

        const userErr = validateSnowflake(args.user_id, 'user_id');
        if (userErr)
          return { content: [{ type: 'text', text: userErr }], isError: true };

        return executeIpc('discord_dm', {
          userId: args.user_id,
          content: args.content,
        });
      },
    ),

    // ==================== SERVER (GUILD) TOOLS ====================
    tool(
      'discord_list_guilds',
      `List all servers (guilds) the bot is in.`,
      {},
      async () => {
        const permErr = checkPermission(isMain, isScheduledTask);
        if (permErr)
          return { content: [{ type: 'text', text: permErr }], isError: true };

        return executeIpc('discord_list_guilds', {});
      },
    ),

    tool(
      'discord_get_guild_info',
      `Get detailed information about a server (guild).`,
      {
        guild_id: z.string().describe('Discord server (guild) ID'),
      },
      async (args: { guild_id: string }) => {
        const permErr = checkPermission(isMain, isScheduledTask);
        if (permErr)
          return { content: [{ type: 'text', text: permErr }], isError: true };

        const guildErr = validateSnowflake(args.guild_id, 'guild_id');
        if (guildErr)
          return { content: [{ type: 'text', text: guildErr }], isError: true };

        return executeIpc('discord_get_guild_info', { guildId: args.guild_id });
      },
    ),

    // ==================== WEBHOOK TOOLS ====================
    tool(
      'discord_webhook_send',
      `Send a message via webhook. Allows custom username and avatar.`,
      {
        webhook_url: z.string().url().describe('Discord webhook URL'),
        content: z.string().max(4000).describe('Message content'),
        username: z
          .string()
          .max(80)
          .optional()
          .describe('Override webhook username'),
        avatar_url: z
          .string()
          .url()
          .optional()
          .describe('Override webhook avatar URL'),
      },
      async (args: {
        webhook_url: string;
        content: string;
        username?: string;
        avatar_url?: string;
      }) => {
        const permErr = checkPermission(isMain, isScheduledTask);
        if (permErr)
          return { content: [{ type: 'text', text: permErr }], isError: true };

        return executeIpc('discord_webhook_send', {
          webhookUrl: args.webhook_url,
          content: args.content,
          username: args.username,
          avatarUrl: args.avatar_url,
        });
      },
    ),
  ];
}
