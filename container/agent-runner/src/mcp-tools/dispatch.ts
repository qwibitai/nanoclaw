/**
 * Orchestrator-only MCP tools: dispatch_task, list_dispatched_tasks, dispatch_cancel.
 *
 * Mounted ONLY when:
 * 1. getSessionDispatchTaskId() === null (this is not a child/dispatched session)
 * 2. This agent's group has agent_group_capabilities.role = 'orchestrator'
 *    in the per-agent central DB projection.
 *
 * All three tools write kind='system' outbound rows. The host processes them
 * in the delivery loop — there is no synchronous host round-trip.
 */
import { getCentralDb, getOutboundDb } from '../db/connection.js';
import { writeMessageOut } from '../db/messages-out.js';
import { getSessionId } from '../db/session-routing.js';
import { deriveDispatchTaskId } from '../dispatch/derive-task-id.js';
import type { McpToolDefinition } from './types.js';

function log(msg: string): void {
  console.error(`[dispatch] ${msg}`);
}

function ok(text: string) {
  return { content: [{ type: 'text' as const, text }] };
}

function err(text: string) {
  return { content: [{ type: 'text' as const, text: `Error: ${text}` }], isError: true as const };
}

function sysId(): string {
  return `dispatch-sys-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export const dispatchTask: McpToolDefinition = {
  tool: {
    name: 'dispatch_task',
    description:
      'Dispatch a task to another agent group. Returns the task_id immediately (locally computed). ' +
      'The host admits or rejects the dispatch asynchronously — the outcome arrives as an inbound message on the next turn.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        target_group: {
          type: 'string',
          description: 'The agent group name or ID to dispatch the task to.',
        },
        content: {
          type: 'string',
          description: 'The task instructions/content for the child agent.',
        },
        idempotency_key: {
          type: 'string',
          description:
            'Unique key for idempotent dispatch. Reusing the same key with the same payload is safe; ' +
            'reusing with different payload is rejected.',
        },
        deadline: {
          type: 'string',
          description: 'Optional ISO 8601 deadline for the task (e.g., "2026-12-31T23:59:59Z").',
        },
      },
      required: ['target_group', 'content', 'idempotency_key'],
    },
  },
  async handler(args) {
    const targetGroup = args.target_group as string | undefined;
    const content = args.content as string | undefined;
    const idempotencyKey = args.idempotency_key as string | undefined;
    const deadline = (args.deadline as string | undefined) ?? null;

    if (!targetGroup || !content || !idempotencyKey) {
      return err('target_group, content, and idempotency_key are required');
    }

    // Refuse to dispatch if we cannot establish our own session identity.
    // Falling back to '' would compute task_id from an empty parentSessionId, which
    // would not match the host's task_id (host derives from the real session ID).
    // The agent would silently see a dispatch acknowledged with a task_id it doesn't
    // recognize. Better to fail loud at the caller boundary.
    const parentSessionId = getSessionId();
    if (!parentSessionId) {
      return err('dispatch_task: cannot determine parent session id (session_routing.session_id missing); host may need a wake to populate it');
    }
    const taskId = deriveDispatchTaskId(parentSessionId, idempotencyKey);

    writeMessageOut({
      id: sysId(),
      kind: 'system',
      content: JSON.stringify({
        action: 'dispatch_task',
        task_id: taskId,
        target_group: targetGroup,
        content,
        idempotency_key: idempotencyKey,
        deadline,
      }),
    });

    log(`dispatch_task: ${taskId} → ${targetGroup}`);
    return ok(`Task dispatched. task_id: ${taskId}\nStatus will arrive as an inbound message on the next turn.`);
  },
};

export const listDispatchedTasks: McpToolDefinition = {
  tool: {
    name: 'list_dispatched_tasks',
    description:
      'List tasks dispatched by this orchestrator session. Reads directly from the central DB — no host round-trip.',
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
      return ok('No dispatched tasks (session ID not available).');
    }

    const db = getCentralDb();
    if (!db) {
      return ok('No dispatched tasks (central DB not mounted).');
    }

    try {
      let rows: Array<Record<string, unknown>>;
      if (status) {
        rows = db
          .prepare(
            `SELECT task_id, target_agent_group_id, status, task_content, deadline,
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
            `SELECT task_id, target_agent_group_id, status, task_content, deadline,
                    admitted_at, completed_at, fail_reason, result_summary
               FROM tasks
              WHERE parent_session_id = ?
              ORDER BY created_at DESC
              LIMIT ?`,
          )
          .all(parentSessionId, limit) as Array<Record<string, unknown>>;
      }

      if (rows.length === 0) return ok('No dispatched tasks found.');

      const lines = rows.map((r) => {
        const preview = ((r.task_content as string) || '').slice(0, 60);
        const failNote = r.fail_reason ? ` fail=${r.fail_reason}` : '';
        const resultNote = r.result_summary ? ` result=${String(r.result_summary).slice(0, 40)}` : '';
        return `- ${r.task_id} [${r.status}] target=${r.target_agent_group_id} → ${preview}${failNote}${resultNote}`;
      });

      return ok(lines.join('\n'));
    } catch (e) {
      // tasks table may not exist on older installs
      const msg = e instanceof Error ? e.message : String(e);
      if (/no such table/.test(msg)) return ok('No dispatched tasks found.');
      return err(`Failed to query dispatched tasks: ${msg}`);
    }
  },
};

export const dispatchCancel: McpToolDefinition = {
  tool: {
    name: 'dispatch_cancel',
    description:
      'Cancel a dispatched task by task_id. The host verifies that this session is the parent before applying. ' +
      'Outcome arrives as an inbound message on the next turn.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        task_id: {
          type: 'string',
          description: 'The task_id returned by dispatch_task.',
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

    const content: Record<string, unknown> = { action: 'dispatch_cancel', task_id: taskId };
    if (reason !== undefined) content.reason = reason;

    writeMessageOut({
      id: sysId(),
      kind: 'system',
      content: JSON.stringify(content),
    });

    log(`dispatch_cancel: ${taskId}${reason ? ` (${reason})` : ''}`);
    return ok(`Cancellation requested for task: ${taskId}. Status will arrive as an inbound message.`);
  },
};
