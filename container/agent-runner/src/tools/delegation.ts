import { z } from 'zod';
import fs from 'fs';
import path from 'path';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ToolContext } from '../tool-context.js';
import { IPC_DIR } from '../tool-context.js';

const DELEGATE_REQUESTS_DIR = path.join(IPC_DIR, 'delegate-requests');
const DELEGATE_RESPONSES_DIR = path.join(IPC_DIR, 'delegate-responses');

export function register(server: McpServer, ctx: ToolContext): void {
  server.tool(
    'delegate_task',
    `Delegate a task to a worker agent. The worker runs in its own container with its own context — it cannot see your conversation. Use this for:
\u2022 Research tasks: "Search the web for X and summarize findings"
\u2022 Grunt work: "Format this data as a CSV"
\u2022 Parallel work: "Draft an email while I work on something else"

The worker gets the global Agent OS (tools, memory access) but NO conversation history.
You get back the worker's final output as text.

Tips:
\u2022 Use a cheap model (minimax/minimax-m2.5) for simple tasks
\u2022 Be specific in your prompt — the worker has zero context about your conversation
\u2022 Workers can use send_message, recall, remember, and other tools
\u2022 Default timeout is 5 minutes — set higher for complex tasks`,
    {
      prompt: z.string().describe('What the worker should do. Include ALL context — the worker cannot see your conversation.'),
      model: z.string().optional().describe('Model for the worker (e.g. minimax/minimax-m2.5 for cheap grunt work). Defaults to your model.'),
      timeout_seconds: z.number().default(300).describe('Max seconds to wait for result (default 300 = 5 min, max 600 = 10 min)'),
    },
    async (args) => {
      fs.mkdirSync(DELEGATE_REQUESTS_DIR, { recursive: true });
      fs.mkdirSync(DELEGATE_RESPONSES_DIR, { recursive: true });

      const delegateId = `delegate-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const requestPath = path.join(DELEGATE_REQUESTS_DIR, `${delegateId}.json`);

      const timeoutSec = Math.min(Math.max(args.timeout_seconds, 30), 600);

      fs.writeFileSync(requestPath, JSON.stringify({
        id: delegateId,
        prompt: args.prompt,
        model: args.model || null,
        timeout_seconds: timeoutSec,
        source_group: ctx.groupFolder,
        source_chat_jid: ctx.chatJid,
        timestamp: new Date().toISOString(),
      }));

      const responsePath = path.join(DELEGATE_RESPONSES_DIR, `${delegateId}.json`);
      const timeout = timeoutSec * 1000;
      const interval = 1000;
      const start = Date.now();

      while (Date.now() - start < timeout) {
        if (fs.existsSync(responsePath)) {
          try {
            const response = JSON.parse(fs.readFileSync(responsePath, 'utf-8'));
            try { fs.unlinkSync(responsePath); } catch { /* ignore */ }

            if (response.error) {
              return { content: [{ type: 'text' as const, text: `Worker failed: ${response.error}` }], isError: true };
            }

            const elapsed = Math.round((Date.now() - start) / 1000);
            let summary = `**Worker completed** (${elapsed}s, model: ${response.model || 'default'})\n\n`;
            summary += response.result || '(no output)';

            return { content: [{ type: 'text' as const, text: summary }] };
          } catch (err) {
            return { content: [{ type: 'text' as const, text: `Failed to parse worker response: ${err}` }], isError: true };
          }
        }
        await new Promise((r) => setTimeout(r, interval));
      }

      try { fs.unlinkSync(requestPath); } catch { /* ignore */ }
      return { content: [{ type: 'text' as const, text: `Worker timed out after ${timeoutSec}s. The task may still be running — check back later.` }], isError: true };
    },
  );
}
