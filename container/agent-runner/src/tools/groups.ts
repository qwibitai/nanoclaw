import { z } from 'zod';
import path from 'path';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ToolContext } from '../tool-context.js';
import { IPC_DIR } from '../tool-context.js';

const TASKS_DIR = path.join(IPC_DIR, 'tasks');

export function register(server: McpServer, ctx: ToolContext): void {
  server.tool(
    'register_group',
    `Register a new WhatsApp group so the agent can respond to messages there. Main group only.

Use available_groups.json to find the JID for a group. The folder name should be lowercase with hyphens (e.g., "family-chat").`,
    {
      jid: z.string().describe('The WhatsApp JID (e.g., "120363336345536173@g.us")'),
      name: z.string().describe('Display name for the group'),
      folder: z.string().describe('Folder name for group files (lowercase, hyphens, e.g., "family-chat")'),
      trigger: z.string().describe('Trigger word (e.g., "@Andy")'),
    },
    async (args) => {
      if (!ctx.isMain) {
        return {
          content: [{ type: 'text' as const, text: 'Only the main group can register new groups.' }],
          isError: true,
        };
      }

      const data = {
        type: 'register_group',
        jid: args.jid,
        name: args.name,
        folder: args.folder,
        trigger: args.trigger,
        timestamp: new Date().toISOString(),
      };

      ctx.writeIpcFile(TASKS_DIR, data);

      return {
        content: [{ type: 'text' as const, text: `Group "${args.name}" registered. It will start receiving messages immediately.` }],
      };
    },
  );
}
