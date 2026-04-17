import { z } from 'zod';

import type { ToolContext } from '../context.js';

import { textResponse, type ToolDefinition } from './types.js';

interface SendMessageArgs {
  text: string;
  sender?: string;
}

export function buildSendMessageTool(
  ctx: ToolContext,
): ToolDefinition<SendMessageArgs, ReturnType<typeof textResponse>> {
  return {
    name: 'send_message',
    description:
      "Send a message to the user or group immediately while you're still running. Use this for progress updates or to send multiple messages. You can call this multiple times.",
    schema: {
      text: z.string().describe('The message text to send'),
      sender: z
        .string()
        .optional()
        .describe(
          'Your role/identity name (e.g. "Researcher"). When set, messages appear from a dedicated bot in Telegram.',
        ),
    },
    handler: async (args) => {
      ctx.writeIpcFile(ctx.messagesDir, {
        type: 'message',
        chatJid: ctx.chatJid,
        text: args.text,
        sender: args.sender || undefined,
        groupFolder: ctx.groupFolder,
        timestamp: new Date().toISOString(),
      });
      return textResponse('Message sent.');
    },
  };
}
