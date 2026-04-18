import fs from 'fs';
import path from 'path';
import { z } from 'zod';

interface ToolDefinition {
  description: string;
  parameters: z.ZodType<any>;
  execute: (args: any, context: any) => Promise<{ success: boolean; error?: string }>;
}

function writeIpcFile(dir: string, data: Record<string, unknown>): void {
  fs.mkdirSync(dir, { recursive: true });
  const filename = `vercel_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.json`;
  fs.writeFileSync(path.join(dir, filename), JSON.stringify(data, null, 2));
}

function log(message: string): void {
  console.error(`[tool-bridge] ${message}`);
}

interface TrustPollingOptions {
  pollIntervalMs?: number;
  maxPollMs?: number;
}

export async function checkTrustWithPolling(
  toolName: string,
  chatJid: string,
  groupId: string,
  description?: string,
  options?: TrustPollingOptions,
): Promise<{ allowed: boolean; error?: string }> {
  const gatewayUrl = process.env.TRUST_GATEWAY_URL ?? 'http://host.docker.internal:10255';
  const pollInterval = options?.pollIntervalMs ?? 3000;
  const maxPoll = options?.maxPollMs ?? 300_000;

  // Step 1: Initial evaluation
  let evaluateResult: { decision?: string; approval_id?: string; error?: string };
  try {
    const res = await fetch(`${gatewayUrl}/trust/evaluate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tool_name: toolName, group_id: groupId, chat_jid: chatJid, description }),
    });
    if (!res.ok) return { allowed: false, error: `Trust gateway returned ${res.status}` };
    evaluateResult = await res.json() as typeof evaluateResult;
  } catch {
    return { allowed: true }; // fail open if gateway unreachable
  }

  if (evaluateResult.decision === 'approved') return { allowed: true };
  if (evaluateResult.decision !== 'pending' || !evaluateResult.approval_id) {
    return { allowed: false, error: evaluateResult.error ?? 'Trust check denied' };
  }

  // Step 2: Poll for resolution
  const approvalId = evaluateResult.approval_id;
  log(`Waiting for approval ${approvalId} (tool: ${toolName})`);
  const startTime = Date.now();
  while (Date.now() - startTime < maxPoll) {
    await new Promise((resolve) => setTimeout(resolve, pollInterval));
    try {
      const pollRes = await fetch(`${gatewayUrl}/trust/approval/${approvalId}`);
      if (!pollRes.ok) return { allowed: false, error: `Poll failed: ${pollRes.status}` };
      const pollResult = (await pollRes.json()) as { decision?: string };
      if (pollResult.decision === 'approved') { log(`Approval ${approvalId} granted`); return { allowed: true }; }
      if (pollResult.decision === 'denied' || pollResult.decision === 'timeout') {
        log(`Approval ${approvalId} ${pollResult.decision}`);
        return { allowed: false, error: `Action ${pollResult.decision} by user` };
      }
    } catch {
      return { allowed: false, error: 'Lost connection to trust gateway during polling' };
    }
  }
  log(`Approval ${approvalId} timed out after ${maxPoll}ms`);
  return { allowed: false, error: 'Approval timed out waiting for user response' };
}

export function buildIpcTools(
  ipcDir: string,
  chatJid: string,
  groupFolder: string,
): Record<string, ToolDefinition> {
  const messagesDir = path.join(ipcDir, 'messages');
  const tasksDir = path.join(ipcDir, 'tasks');
  const groupId = path.basename(groupFolder);

  return {
    send_message: {
      description: 'Send a message to the chat',
      parameters: z.object({
        text: z.string().describe('Message text to send'),
      }),
      execute: async ({ text }: { text: string }) => {
        const trust = await checkTrustWithPolling('send_message', chatJid, groupId, 'Send a chat message');
        if (!trust.allowed) return { success: false, error: trust.error };
        writeIpcFile(messagesDir, {
          type: 'message',
          chatJid,
          text,
          groupFolder,
        });
        return { success: true };
      },
    },

    schedule: {
      description: 'Schedule a task for later execution',
      parameters: z.object({
        when: z.string().describe('When to run (cron expression or relative time)'),
        prompt: z.string().describe('Task prompt'),
        label: z.string().optional().describe('Human-readable label'),
      }),
      execute: async ({ when, prompt, label }: { when: string; prompt: string; label?: string }) => {
        const trust = await checkTrustWithPolling('schedule', chatJid, groupId, `Schedule task: ${label ?? prompt.slice(0, 60)}`);
        if (!trust.allowed) return { success: false, error: trust.error };
        writeIpcFile(tasksDir, {
          type: 'schedule',
          chatJid,
          groupFolder,
          when,
          prompt,
          label,
        });
        return { success: true };
      },
    },

    relay_message: {
      description: 'Relay a message to the main group channel',
      parameters: z.object({
        text: z.string().describe('Message to relay'),
      }),
      execute: async ({ text }: { text: string }) => {
        const trust = await checkTrustWithPolling('relay_message', chatJid, groupId, 'Relay message to main channel');
        if (!trust.allowed) return { success: false, error: trust.error };
        writeIpcFile(messagesDir, {
          type: 'relay_message',
          chatJid,
          text,
          groupFolder,
        });
        return { success: true };
      },
    },

    learn_feedback: {
      description: 'Record a learned rule from this interaction',
      parameters: z.object({
        rule: z.string().describe('The rule or pattern learned'),
        source: z.enum(['user_feedback', 'outcome_pattern', 'agent_reported']),
      }),
      execute: async ({ rule, source }: { rule: string; source: string }) => {
        writeIpcFile(messagesDir, {
          type: 'learn_feedback',
          chatJid,
          groupFolder,
          rule,
          source,
        });
        return { success: true };
      },
    },

    learn_fact: {
      description: 'Store a fact in long-term memory for future recall. Use for important information worth remembering across sessions.',
      parameters: z.object({
        text: z.string().describe('The fact to remember'),
        domain: z.string().optional().describe('Category: preferences, contacts, workflows, general'),
        source: z.string().optional().describe('Where this fact came from'),
      }),
      execute: async ({ text, domain, source }: { text: string; domain?: string; source?: string }) => {
        writeIpcFile(messagesDir, {
          type: 'learn_fact',
          chatJid,
          groupFolder,
          text,
          domain: domain ?? 'general',
          source: source ?? 'agent',
        });
        return { success: true, stored: text.slice(0, 80) };
      },
    },

    search_memory: {
      description: 'Search long-term memory for relevant facts. Uses semantic search when available, falls back to keyword search.',
      parameters: z.object({
        query: z.string().describe('What to search for'),
        domain: z.string().optional().describe('Filter by domain'),
        limit: z.number().optional().describe('Max results (default 5)'),
      }),
      execute: async ({ query, domain, limit }: { query: string; domain?: string; limit?: number }) => {
        writeIpcFile(messagesDir, {
          type: 'search_memory',
          chatJid,
          groupFolder,
          query,
          domain,
          limit: limit ?? 5,
        });
        return { success: true, note: 'Memory search submitted. Results will appear in context if found.' };
      },
    },

    switch_model: {
      description:
        'Switch the LLM model for this group. Use this to escalate to a stronger model for complex tasks, or switch to a cheaper model for simple follow-ups. The change takes effect on the next message.',
      parameters: z.object({
        provider: z
          .enum(['anthropic', 'openai', 'google', 'ollama', 'groq', 'together'])
          .describe('The LLM provider to switch to'),
        model: z
          .string()
          .optional()
          .describe(
            'Model identifier (e.g. "gpt-4o", "gemini-2.5-pro"). If omitted, uses provider default.',
          ),
      }),
      execute: async ({
        provider,
        model,
      }: {
        provider: string;
        model?: string;
      }) => {
        writeIpcFile(messagesDir, {
          type: 'switch_model',
          chatJid,
          groupFolder,
          provider,
          model,
        });
        return { success: true };
      },
    },
  };
}
