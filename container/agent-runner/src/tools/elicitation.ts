import { z } from 'zod';
import fs from 'fs';
import path from 'path';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ToolContext } from '../tool-context.js';
import { IPC_DIR } from '../tool-context.js';

const ELICITATION_REQUESTS_DIR = path.join(IPC_DIR, 'elicitation-requests');
const ELICITATION_RESPONSES_DIR = path.join(IPC_DIR, 'elicitation-responses');

export function register(server: McpServer, ctx: ToolContext): void {
  server.tool(
    'ask_structured',
    `Ask the user a question with predefined options. Instead of free-text questions,
present numbered choices that the user can select by clicking a reaction or typing a number.

Use this when:
\u2022 You need a decision between specific alternatives
\u2022 You want to confirm an action (Yes/No)
\u2022 You're presenting a prioritized list for selection

The user sees numbered options with emoji reactions (1\uFE0F\u20E3 2\uFE0F\u20E3 3\uFE0F\u20E3) in Discord/Slack.
Returns their selection or freetext response if allowed.`,
    {
      question: z.string().describe('The question to ask the user'),
      options: z.array(z.string()).min(2).max(10).describe('Options to present (2-10)'),
      allow_freetext: z.boolean().default(false).describe('Allow a custom typed response beyond the options'),
      timeout_seconds: z.number().default(300).describe('Seconds to wait for response (default 300 = 5 min)'),
    },
    async (args) => {
      fs.mkdirSync(ELICITATION_REQUESTS_DIR, { recursive: true });
      fs.mkdirSync(ELICITATION_RESPONSES_DIR, { recursive: true });

      const elicitId = `elicit-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const requestPath = path.join(ELICITATION_REQUESTS_DIR, `${elicitId}.json`);

      const timeoutSec = Math.min(Math.max(args.timeout_seconds, 30), 600);

      fs.writeFileSync(requestPath, JSON.stringify({
        id: elicitId,
        question: args.question,
        options: args.options,
        allowFreetext: args.allow_freetext,
        timeoutSeconds: timeoutSec,
        sourceGroup: ctx.groupFolder,
        sourceChatJid: ctx.chatJid,
        timestamp: new Date().toISOString(),
      }));

      const responsePath = path.join(ELICITATION_RESPONSES_DIR, `${elicitId}.json`);
      const timeout = timeoutSec * 1000;
      const interval = 1000;
      const start = Date.now();

      while (Date.now() - start < timeout) {
        if (fs.existsSync(responsePath)) {
          try {
            const response = JSON.parse(fs.readFileSync(responsePath, 'utf-8'));
            try { fs.unlinkSync(responsePath); } catch { /* ignore */ }

            if (response.timeout) {
              return { content: [{ type: 'text' as const, text: `User did not respond within ${timeoutSec}s.` }] };
            }

            const result: Record<string, unknown> = {};
            if (response.chosen) result.chosen = response.chosen;
            if (response.freetext) result.freetext = response.freetext;

            return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
          } catch (err) {
            return { content: [{ type: 'text' as const, text: `Failed to parse elicitation response: ${err}` }], isError: true };
          }
        }
        await new Promise((r) => setTimeout(r, interval));
      }

      try { fs.unlinkSync(requestPath); } catch { /* ignore */ }
      return { content: [{ type: 'text' as const, text: `User did not respond within ${timeoutSec}s.` }] };
    },
  );
}
