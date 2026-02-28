import { z } from 'zod';
import fs from 'fs';
import path from 'path';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ToolContext } from '../tool-context.js';
import { IPC_DIR } from '../tool-context.js';

const RELAY_OUTBOX_DIR = path.join(IPC_DIR, 'relay-outbox');
const RELAY_INBOX_DIR = path.join(IPC_DIR, 'relay-inbox');
const RELAY_RECEIPTS_DIR = path.join(IPC_DIR, 'relay-receipts');

export function register(server: McpServer, ctx: ToolContext): void {
  server.tool(
    'send_relay',
    `Send a message to another agent. The message goes through the host relay —
the target agent will find it in their inbox next time they check.

Use this for:
\u2022 Asking another agent for clarification on a delegated task
\u2022 Sharing findings with a peer agent
\u2022 Coordinating work across agents (e.g. "I finished part A, you can start part B")

Messages are logged for human observability. The human can monitor all relay traffic.`,
    {
      to: z.string().describe("Target agent's group folder name (e.g. 'research', 'trading')"),
      content: z.string().describe('Message body — include all context the target needs'),
      reply_to: z.string().optional().describe('Optional: ID of a message you\'re replying to'),
    },
    async (args) => {
      fs.mkdirSync(RELAY_OUTBOX_DIR, { recursive: true });
      fs.mkdirSync(RELAY_RECEIPTS_DIR, { recursive: true });

      const relayId = `relay-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

      const msg = {
        id: relayId,
        from: ctx.groupFolder,
        to: args.to,
        content: args.content,
        replyTo: args.reply_to || undefined,
        timestamp: new Date().toISOString(),
      };

      const outboxPath = path.join(RELAY_OUTBOX_DIR, `${relayId}.json`);
      fs.writeFileSync(outboxPath, JSON.stringify(msg, null, 2));

      const receiptPath = path.join(RELAY_RECEIPTS_DIR, `${relayId}.json`);
      const timeout = 30000;
      const interval = 500;
      const start = Date.now();

      while (Date.now() - start < timeout) {
        if (fs.existsSync(receiptPath)) {
          try {
            const receipt = JSON.parse(fs.readFileSync(receiptPath, 'utf-8'));
            try { fs.unlinkSync(receiptPath); } catch { /* ignore */ }

            if (receipt.status === 'delivered') {
              return { content: [{ type: 'text' as const, text: `Message delivered to ${args.to} (id: ${relayId})` }] };
            } else {
              return { content: [{ type: 'text' as const, text: `Message undeliverable: ${receipt.reason || 'unknown error'}` }], isError: true };
            }
          } catch (err) {
            return { content: [{ type: 'text' as const, text: `Failed to read delivery receipt: ${err}` }], isError: true };
          }
        }
        await new Promise((r) => setTimeout(r, interval));
      }

      return { content: [{ type: 'text' as const, text: 'Delivery receipt timeout after 30s — message may still be delivered' }], isError: true };
    },
  );

  server.tool(
    'check_relay',
    `Check your relay inbox for messages from other agents. Returns all pending
messages and removes them from the inbox (read-once).

Use this periodically during long tasks to see if other agents need anything.`,
    {},
    async () => {
      if (!fs.existsSync(RELAY_INBOX_DIR)) {
        return { content: [{ type: 'text' as const, text: 'No messages in relay inbox.' }] };
      }

      let files: string[];
      try {
        files = fs.readdirSync(RELAY_INBOX_DIR).filter((f) => f.endsWith('.json'));
      } catch {
        return { content: [{ type: 'text' as const, text: 'No messages in relay inbox.' }] };
      }

      if (files.length === 0) {
        return { content: [{ type: 'text' as const, text: 'No messages in relay inbox.' }] };
      }

      const messages: Array<{ id: string; from: string; content: string; replyTo?: string; timestamp: string }> = [];

      for (const file of files) {
        const filePath = path.join(RELAY_INBOX_DIR, file);
        try {
          const msg = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
          messages.push({
            id: msg.id,
            from: msg.from,
            content: msg.content,
            replyTo: msg.replyTo,
            timestamp: msg.timestamp,
          });
          try { fs.unlinkSync(filePath); } catch { /* ignore */ }
        } catch {
          try { fs.unlinkSync(filePath); } catch { /* ignore */ }
        }
      }

      if (messages.length === 0) {
        return { content: [{ type: 'text' as const, text: 'No messages in relay inbox.' }] };
      }

      const formatted = messages.map((m) => {
        let text = `**From ${m.from}** (${m.id})\n${m.content}`;
        if (m.replyTo) text = `**From ${m.from}** (reply to ${m.replyTo})\n${m.content}`;
        return text;
      }).join('\n\n---\n\n');

      return { content: [{ type: 'text' as const, text: `\u{1F4E8} ${messages.length} relay message(s):\n\n${formatted}` }] };
    },
  );
}
