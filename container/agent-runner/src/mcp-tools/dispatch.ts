/**
 * Orchestrator-only MCP tools: spawn_task, list_spawned_tasks, spawn_cancel.
 *
 * Mounted ONLY when:
 * 1. getSessionSpawnTaskId() === null (this is not a child/spawned session)
 * 2. This agent's group has agent_group_capabilities.role = 'orchestrator'
 *    in the per-agent central DB projection.
 *
 * All three tools write kind='system' outbound rows. The host processes them
 * in the delivery loop — there is no synchronous host round-trip.
 *
 * Self-orchestration: spawn_task always targets the SAME agent group as the
 * caller (sharing workspace, memory, CLAUDE.md, channels). There is no
 * cross-group dispatch primitive — group is the trust boundary, session is
 * the work-unit boundary.
 */
import { getCentralDb } from '../db/connection.js';
import { writeMessageOut } from '../db/messages-out.js';
import { getSessionId } from '../db/session-routing.js';
import { deriveSpawnTaskId } from '../dispatch/derive-task-id.js';
import type { McpToolDefinition } from './types.js';

function log(msg: string): void {
  console.error(`[spawn] ${msg}`);
}

function ok(text: string) {
  return { content: [{ type: 'text' as const, text }] };
}

function err(text: string) {
  return { content: [{ type: 'text' as const, text: `Error: ${text}` }], isError: true as const };
}

function sysId(): string {
  return `spawn-sys-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export const spawnTask: McpToolDefinition = {
  tool: {
    name: 'spawn_task',
    description:
      'Spawn a parallel task in a new session of THIS agent group. The child session shares ' +
      'workspace, memory, CLAUDE.md, and channels with you — only the conversation/thread is isolated. ' +
      'Returns the task_id immediately (locally computed). The host admits or rejects asynchronously — ' +
      'the outcome arrives as an inbound message on the next turn.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        content: {
          type: 'string',
          description: 'The task instructions/content for the spawned child session.',
        },
        idempotency_key: {
          type: 'string',
          description:
            'Unique key for idempotent spawn. Reusing the same key with the same payload is safe; ' +
            'reusing with different payload is rejected.',
        },
        deadline: {
          type: 'string',
          description: 'Optional ISO 8601 deadline for the task (e.g., "2026-12-31T23:59:59Z").',
        },
      },
      required: ['content', 'idempotency_key'],
    },
  },
  async handler(args) {
    const content = args.content as string | undefined;
    const idempotencyKey = args.idempotency_key as string | undefined;
    const deadline = (args.deadline as string | undefined) ?? null;

    if (!content || !idempotencyKey) {
      return err('content and idempotency_key are required');
    }

    // Refuse to spawn if we cannot establish our own session identity.
    // Falling back to '' would compute task_id from an empty parentSessionId, which
    // would not match the host's task_id (host derives from the real session ID).
    // The agent would silently see a spawn acknowledged with a task_id it doesn't
    // recognize. Better to fail loud at the caller boundary.
    const parentSessionId = getSessionId();
    if (!parentSessionId) {
      return err('spawn_task: cannot determine parent session id (session_routing.session_id missing); host may need a wake to populate it');
    }
    const taskId = deriveSpawnTaskId(parentSessionId, idempotencyKey);

    writeMessageOut({
      id: sysId(),
      kind: 'system',
      content: JSON.stringify({
        action: 'spawn_task',
        task_id: taskId,
        content,
        idempotency_key: idempotencyKey,
        deadline,
      }),
    });

    log(`spawn_task: ${taskId}`);
    return ok(`Task spawned. task_id: ${taskId}\nStatus will arrive as an inbound message on the next turn.`);
  },
};

export const listSpawnedTasks: McpToolDefinition = {
  tool: {
    name: 'list_spawned_tasks',
    description:
      'List tasks spawned by this orchestrator session. Reads directly from the central DB — no host round-trip.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        status: {
          type: 'string',
          description: 'Filter by status: pending, running, completed, failed, cancelled (default: all active)',
        },
        limit: {
          type: 'number',
          description: 'Max rows to return (default: 20)',
        },
      },
    },
  },
  async handler(args) {
    const status = args.status as string | undefined;
    const limit = typeof args.limit === 'number' ? args.limit : 20;
    const parentSessionId = getSessionId();

    if (!parentSessionId) {
      return ok('No spawned tasks (session ID not available).');
    }

    const db = getCentralDb();
    if (!db) {
      return ok('No spawned tasks (central DB not mounted).');
    }

    try {
      let rows: Array<Record<string, unknown>>;
      if (status) {
        rows = db
          .prepare(
            `SELECT task_id, status, task_content, deadline,
                    admitted_at, completed_at, fail_reason, result_summary
               FROM tasks
              WHERE parent_session_id = ?
                AND status = ?
              ORDER BY created_at DESC
              LIMIT ?`,
          )
          .all(parentSessionId, status, limit) as Array<Record<string, unknown>>;
      } else {
        rows = db
          .prepare(
            `SELECT task_id, status, task_content, deadline,
                    admitted_at, completed_at, fail_reason, result_summary
               FROM tasks
              WHERE parent_session_id = ?
              ORDER BY created_at DESC
              LIMIT ?`,
          )
          .all(parentSessionId, limit) as Array<Record<string, unknown>>;
      }

      if (rows.length === 0) return ok('No spawned tasks found.');

      const lines = rows.map((r) => {
        const preview = ((r.task_content as string) || '').slice(0, 60);
        const failNote = r.fail_reason ? ` fail=${r.fail_reason}` : '';
        const resultNote = r.result_summary ? ` result=${String(r.result_summary).slice(0, 40)}` : '';
        return `- ${r.task_id} [${r.status}] → ${preview}${failNote}${resultNote}`;
      });

      return ok(lines.join('\n'));
    } catch (e) {
      // tasks table may not exist on older installs
      const msg = e instanceof Error ? e.message : String(e);
      if (/no such table/.test(msg)) return ok('No spawned tasks found.');
      return err(`Failed to query spawned tasks: ${msg}`);
    }
  },
};

export const spawnCancel: McpToolDefinition = {
  tool: {
    name: 'spawn_cancel',
    description:
      'Cancel a spawned task by task_id. The host verifies that this session is the parent before applying. ' +
      'Outcome arrives as an inbound message on the next turn.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        task_id: {
          type: 'string',
          description: 'The task_id returned by spawn_task.',
        },
        reason: {
          type: 'string',
          description: 'Optional human-readable reason for cancellation.',
        },
      },
      required: ['task_id'],
    },
  },
  async handler(args) {
    const taskId = args.task_id as string | undefined;
    const reason = args.reason as string | undefined;

    if (!taskId) return err('task_id is required');

    const content: Record<string, unknown> = { action: 'spawn_cancel', task_id: taskId };
    if (reason !== undefined) content.reason = reason;

    writeMessageOut({
      id: sysId(),
      kind: 'system',
      content: JSON.stringify(content),
    });

    log(`spawn_cancel: ${taskId}${reason ? ` (${reason})` : ''}`);
    return ok(`Cancellation requested for task: ${taskId}. Status will arrive as an inbound message.`);
  },
};
