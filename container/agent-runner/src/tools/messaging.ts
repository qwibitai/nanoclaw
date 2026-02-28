import { z } from 'zod';
import path from 'path';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ToolContext } from '../tool-context.js';
import { IPC_DIR } from '../tool-context.js';

const MESSAGES_DIR = path.join(IPC_DIR, 'messages');

export function register(server: McpServer, ctx: ToolContext): void {
  server.tool(
    'send_message',
    "Send a message to the user or group immediately while you're still running. Use this for progress updates or to send multiple messages. You can call this multiple times. Note: when running as a scheduled task, your final output is NOT sent to the user — use this tool if you need to communicate with the user or group.",
    {
      text: z.string().describe('The message text to send'),
      sender: z.string().optional().describe('Your role/identity name (e.g. "Researcher"). When set, messages appear from a dedicated bot in Telegram.'),
    },
    async (args) => {
      const data: Record<string, string | undefined> = {
        type: 'message',
        chatJid: ctx.chatJid,
        text: args.text,
        sender: args.sender || undefined,
        groupFolder: ctx.groupFolder,
        timestamp: new Date().toISOString(),
      };

      ctx.writeIpcFile(MESSAGES_DIR, data);

      return { content: [{ type: 'text' as const, text: 'Message sent.' }] };
    },
  );
}
