/**
 * Agent management MCP tools: create_agent.
 *
 * send_to_agent was removed — sending to another agent is now just
 * send_message(to="agent-name") since agents and channels share the
 * unified destinations namespace.
 *
 * create_agent is admin-only. Non-admin containers never see this tool
 * (see mcp-tools/index.ts). The host re-checks permission on receive.
 */
import { writeMessageOut } from '../db/messages-out.js';
import { registerTools } from './server.js';
import type { McpToolDefinition } from './types.js';

function log(msg: string): void {
  console.error(`[mcp-tools] ${msg}`);
}

function generateId(): string {
  return `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function ok(text: string) {
  return { content: [{ type: 'text' as const, text }] };
}

function err(text: string) {
  return { content: [{ type: 'text' as const, text: `Error: ${text}` }], isError: true };
}

export const createAgent: McpToolDefinition = {
  tool: {
    name: 'create_agent',
    description:
      'Create a long-lived companion sub-agent (research assistant, task manager, specialist) — the name becomes your destination for it. Admin-only. Fire-and-forget.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        name: { type: 'string', description: 'Human-readable name (also becomes your destination name for this agent)' },
        instructions: { type: 'string', description: 'CLAUDE.md content for the new agent (personality, role, instructions)' },
        agent_provider: {
          type: 'string',
          description:
            'Optional agent provider for the new sub-agent (e.g. "claude", "codex", "opencode", "mock"). Omit to inherit the default (claude). Case-insensitive.',
        },
        model: {
          type: 'string',
          description:
            'Optional model override for the new sub-agent (opaque string, SDK-specific — e.g. "sonnet[1m]", "opus[1m]", "haiku" for Claude, "gpt-5.4-mini" for Codex). Omit to let the provider pick its default. Case preserved.',
        },
      },
      required: ['name'],
    },
  },
  async handler(args) {
    const name = args.name as string;
    if (!name) return err('name is required');

    const rawProvider = args.agent_provider as string | undefined;
    const agentProvider = typeof rawProvider === 'string' && rawProvider.trim() ? rawProvider.trim().toLowerCase() : null;

    const rawModel = args.model as string | undefined;
    const model = typeof rawModel === 'string' && rawModel.trim() ? rawModel.trim() : null;

    const requestId = generateId();
    writeMessageOut({
      id: requestId,
      kind: 'system',
      content: JSON.stringify({
        action: 'create_agent',
        requestId,
        name,
        instructions: (args.instructions as string) || null,
        agent_provider: agentProvider,
        model,
      }),
    });

    const parts: string[] = [];
    if (agentProvider) parts.push(`provider=${agentProvider}`);
    if (model) parts.push(`model=${model}`);
    const suffix = parts.length ? ` (${parts.join(', ')})` : '';
    log(`create_agent: ${requestId} → "${name}"${suffix}`);
    return ok(`Creating agent "${name}"${suffix}. You will be notified when it is ready.`);
  },
};

export const updateAgent: McpToolDefinition = {
  tool: {
    name: 'update_agent',
    description:
      'Update the configuration of a previously-created sub-agent by destination name. Currently supports changing `agent_provider` and/or `model`. At least one of the two must be provided. Takes effect on the sub-agent\'s next spawn — any running container for the target is stopped so the next message to it picks up the new config. Admin-only; fire-and-forget.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        target: {
          type: 'string',
          description: 'Destination name of the sub-agent to update (the name you message it as via <message to="…">).',
        },
        agent_provider: {
          type: 'string',
          description: 'New agent provider (e.g. "claude", "codex"). Omit to leave unchanged. Case-insensitive.',
        },
        model: {
          type: 'string',
          description: 'New model override (e.g. "sonnet[1m]", "opus[1m]", "haiku", "gpt-5.4-mini"). Omit to leave unchanged. Case preserved. Pass an empty string to clear the override (fall through to provider default).',
        },
      },
      required: ['target'],
    },
  },
  async handler(args) {
    const target = args.target as string;
    if (!target) return err('target is required');

    const hasProvider = args.agent_provider !== undefined;
    const hasModel = args.model !== undefined;
    if (!hasProvider && !hasModel) {
      return err('at least one of agent_provider or model must be provided');
    }

    const rawProvider = args.agent_provider as string | undefined;
    const agentProvider = hasProvider
      ? (typeof rawProvider === 'string' && rawProvider.trim() ? rawProvider.trim().toLowerCase() : null)
      : undefined;

    const rawModel = args.model as string | undefined;
    // Empty string = intentional clear. Undefined = don't touch.
    const model = hasModel ? (typeof rawModel === 'string' && rawModel.trim() ? rawModel.trim() : null) : undefined;

    const requestId = generateId();
    writeMessageOut({
      id: requestId,
      kind: 'system',
      content: JSON.stringify({
        action: 'update_agent',
        requestId,
        target,
        ...(agentProvider !== undefined ? { agent_provider: agentProvider } : {}),
        ...(model !== undefined ? { model } : {}),
      }),
    });

    const parts: string[] = [];
    if (agentProvider !== undefined) parts.push(`provider=${agentProvider ?? '<cleared>'}`);
    if (model !== undefined) parts.push(`model=${model ?? '<cleared>'}`);
    log(`update_agent: ${requestId} → "${target}" (${parts.join(', ')})`);
    return ok(`Updating agent "${target}" (${parts.join(', ')}). You will be notified when it takes effect.`);
  },
};

registerTools([createAgent, updateAgent]);
