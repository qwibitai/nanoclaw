/**
 * Child-only MCP tools: spawn_progress, spawn_complete, spawn_failed.
 *
 * Mounted ONLY when getSessionSpawnTaskId() !== null — i.e., this container
 * is running as a child of an orchestrator's spawn.
 *
 * All three tools write kind='system' outbound rows. task_id is auto-filled
 * from session metadata (getSessionSpawnTaskId) so the agent doesn't need
 * to pass it explicitly — the tool injection layer fills it in.
 */
import { writeMessageOut } from '../db/messages-out.js';
import { getSessionSpawnTaskId } from '../db/session-routing.js';
import type { McpToolDefinition } from './types.js';

function log(msg: string): void {
  console.error(`[spawn-child] ${msg}`);
}

function ok(text: string) {
  return { content: [{ type: 'text' as const, text }] };
}

function err(text: string) {
  return { content: [{ type: 'text' as const, text: `Error: ${text}` }], isError: true as const };
}

function sysId(): string {
  return `spawn-child-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export const spawnProgress: McpToolDefinition = {
  tool: {
    name: 'spawn_progress',
    description:
      'Report progress on this spawned task to the parent orchestrator. Fire-and-forget — the parent sees this on its next turn.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        message: {
          type: 'string',
          description: 'Progress update message for the orchestrator.',
        },
        task_id: {
          type: 'string',
          description: 'Task ID (optional — auto-filled from session metadata).',
        },
      },
      required: ['message'],
    },
  },
  async handler(args) {
    const message = args.message as string | undefined;
    if (!message) return err('message is required');

    const taskId = (args.task_id as string | undefined) ?? getSessionSpawnTaskId();
    if (!taskId) return err('task_id could not be determined — not running as a spawned child');

    writeMessageOut({
      id: sysId(),
      kind: 'system',
      content: JSON.stringify({ action: 'spawn_progress', task_id: taskId, message }),
    });

    log(`spawn_progress: ${taskId} — ${message}`);
    return ok(`Progress reported: ${message}`);
  },
};

export const spawnComplete: McpToolDefinition = {
  tool: {
    name: 'spawn_complete',
    description:
      'Mark this spawned task as successfully completed. Terminal state — the parent receives the summary on its next turn.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        summary: {
          type: 'string',
          description: 'Summary of work completed for the parent orchestrator.',
        },
        task_id: {
          type: 'string',
          description: 'Task ID (optional — auto-filled from session metadata).',
        },
      },
      required: ['summary'],
    },
  },
  async handler(args) {
    const summary = args.summary as string | undefined;
    if (!summary) return err('summary is required');

    const taskId = (args.task_id as string | undefined) ?? getSessionSpawnTaskId();
    if (!taskId) return err('task_id could not be determined — not running as a spawned child');

    writeMessageOut({
      id: sysId(),
      kind: 'system',
      content: JSON.stringify({ action: 'spawn_complete', task_id: taskId, summary }),
    });

    log(`spawn_complete: ${taskId}`);
    return ok(`Task completed. Summary sent to orchestrator.`);
  },
};

export const spawnFailed: McpToolDefinition = {
  tool: {
    name: 'spawn_failed',
    description:
      'Mark this spawned task as failed. Terminal state — the parent receives the failure details on its next turn.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        summary: {
          type: 'string',
          description: 'Summary of what went wrong for the parent orchestrator.',
        },
        fail_reason: {
          type: 'string',
          description: 'Short machine-readable failure category (e.g., "agent_error", "deadline_exceeded").',
        },
        task_id: {
          type: 'string',
          description: 'Task ID (optional — auto-filled from session metadata).',
        },
      },
      required: ['summary'],
    },
  },
  async handler(args) {
    const summary = args.summary as string | undefined;
    if (!summary) return err('summary is required');

    const taskId = (args.task_id as string | undefined) ?? getSessionSpawnTaskId();
    if (!taskId) return err('task_id could not be determined — not running as a spawned child');

    const content: Record<string, unknown> = { action: 'spawn_failed', task_id: taskId, summary };
    if (args.fail_reason !== undefined) content.fail_reason = args.fail_reason;

    writeMessageOut({
      id: sysId(),
      kind: 'system',
      content: JSON.stringify(content),
    });

    log(`spawn_failed: ${taskId}${args.fail_reason ? ` (${args.fail_reason})` : ''}`);
    return ok(`Task failure reported to orchestrator.`);
  },
};
