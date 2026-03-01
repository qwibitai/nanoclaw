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

  // --- Agent Swarm tool (v2.5) ---

  const SWARM_REQUESTS_DIR = path.join(IPC_DIR, 'swarm-requests');
  const SWARM_RESULTS_DIR = path.join(IPC_DIR, 'swarm-results');

  server.tool(
    'delegate_swarm',
    `Decompose a complex task into 2-3 parallel subtasks and run them simultaneously.

Use this when a task can be broken into independent pieces that don't depend on each other.
The swarm will:
1. Break the task into subtasks (you provide the decomposition)
2. Run each subtask as a separate worker (parallel)
3. Collect all results
4. Return a synthesis of all worker outputs

Respects the global MAX_CONCURRENT_WORKERS=3 cap.

Example: "Research competitor A, B, and C pricing" → 3 parallel research workers.

Tips:
• Each subtask runs in isolation — workers cannot see each other
• Provide ALL context in each subtask prompt — workers have no conversation history
• If the task can't be meaningfully decomposed, use delegate_task instead
• Maximum 3 subtasks per swarm`,
    {
      subtasks: z.array(z.object({
        prompt: z.string().describe('Complete prompt for this subtask. Include ALL context — the worker has no conversation history.'),
        model: z.string().optional().describe('Model for this subtask (default: auto-selected)'),
      })).min(2).max(3).describe('The subtasks to run in parallel (2-3 items)'),
      synthesis_prompt: z.string().optional().describe('Optional prompt for how to combine the results. Default: summarize all worker outputs.'),
      timeout_seconds: z.number().default(600).describe('Max seconds to wait for all results (default 600 = 10 min)'),
    },
    async (args) => {
      fs.mkdirSync(SWARM_REQUESTS_DIR, { recursive: true });
      fs.mkdirSync(SWARM_RESULTS_DIR, { recursive: true });

      const swarmId = `swarm-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const requestPath = path.join(SWARM_REQUESTS_DIR, `${swarmId}.json`);
      const timeoutSec = Math.min(Math.max(args.timeout_seconds, 60), 900);

      fs.writeFileSync(requestPath, JSON.stringify({
        id: swarmId,
        subtasks: args.subtasks,
        synthesis_prompt: args.synthesis_prompt || null,
        timeout_seconds: timeoutSec,
        source_group: ctx.groupFolder,
        source_chat_jid: ctx.chatJid,
        timestamp: new Date().toISOString(),
      }));

      // Wait for swarm result
      const resultPath = path.join(SWARM_RESULTS_DIR, `${swarmId}.json`);
      const timeout = timeoutSec * 1000;
      const interval = 2000;
      const start = Date.now();

      while (Date.now() - start < timeout) {
        if (fs.existsSync(resultPath)) {
          try {
            const result = JSON.parse(fs.readFileSync(resultPath, 'utf-8'));
            try { fs.unlinkSync(resultPath); } catch { /* ignore */ }

            if (result.error) {
              return { content: [{ type: 'text' as const, text: `Swarm failed: ${result.error}` }], isError: true };
            }

            const elapsed = Math.round((Date.now() - start) / 1000);
            let output = `**Swarm completed** (${elapsed}s, ${result.completed_count}/${result.total_count} subtasks)\n\n`;

            if (result.synthesis) {
              output += `## Synthesis\n${result.synthesis}\n\n`;
            }

            output += `## Individual Results\n`;
            for (let i = 0; i < (result.worker_results || []).length; i++) {
              const wr = result.worker_results[i];
              output += `\n### Subtask ${i + 1}\n`;
              output += wr.error
                ? `Error: ${wr.error}\n`
                : `${wr.result || '(no output)'}\n`;
            }

            return { content: [{ type: 'text' as const, text: output }] };
          } catch (err) {
            return { content: [{ type: 'text' as const, text: `Failed to parse swarm result: ${err}` }], isError: true };
          }
        }
        await new Promise((r) => setTimeout(r, interval));
      }

      try { fs.unlinkSync(requestPath); } catch { /* ignore */ }
      return {
        content: [{ type: 'text' as const, text: `Swarm timed out after ${timeoutSec}s. Some subtasks may still be running.` }],
        isError: true,
      };
    },
  );
}
