/**
 * Default reply routing for this session — written by the host on every
 * container wake (see src/session-manager.ts `writeSessionRouting`).
 *
 * Read by the MCP tools as the default destination for outbound messages
 * when the agent doesn't specify an explicit `to`. This is what makes
 * "agent replies in the thread it's currently in" work: the router strips
 * or preserves thread_id based on the adapter's thread support, and we
 * just read the fixed routing the host committed for this session.
 */
import { getInboundDb } from './connection.js';

export interface SessionRouting {
  channel_type: string | null;
  platform_id: string | null;
  thread_id: string | null;
}

export function getSessionRouting(): SessionRouting {
  const db = getInboundDb();
  try {
    const row = db
      .prepare('SELECT channel_type, platform_id, thread_id FROM session_routing WHERE id = 1')
      .get() as SessionRouting | undefined;
    if (row) return row;
  } catch {
    // Table may not exist on an older session DB — fall through to defaults
  }
  return { channel_type: null, platform_id: null, thread_id: null };
}

/**
 * Returns the spawn task_id for this session if it is a child of an
 * orchestrator's spawn, or null if it is a plain (non-spawned) session.
 *
 * Reads `spawn_task_id` from inbound.db's `session_routing` table.
 * The host writes this column via applySpawnTask when launching a child
 * session for a spawned task.
 *
 * Returns null when:
 * - No session_routing row exists (before first host wake)
 * - The column value is NULL (non-spawned session)
 * - The column doesn't exist (legacy session DB pre-migration)
 */
export function getSessionSpawnTaskId(): string | null {
  const db = getInboundDb();
  try {
    const row = db
      .prepare('SELECT spawn_task_id FROM session_routing WHERE id = 1')
      .get() as { spawn_task_id: string | null } | undefined;
    return row?.spawn_task_id ?? null;
  } catch {
    // Column may not exist on a legacy session DB — return null gracefully
    return null;
  }
}

/**
 * Returns this session's own ID, or null if the host hasn't written it yet
 * or the session_routing table doesn't have a session_id column (legacy).
 *
 * The host writes `session_id` into session_routing when writing the
 * spawn_task_id (applySpawnTask). Non-spawned sessions and legacy sessions
 * return null; callers degrade gracefully (e.g., list_spawned_tasks returns
 * an empty list when session_id is null).
 */
export function getSessionId(): string | null {
  const db = getInboundDb();
  try {
    const row = db
      .prepare('SELECT session_id FROM session_routing WHERE id = 1')
      .get() as { session_id: string | null } | undefined;
    return row?.session_id ?? null;
  } catch {
    // Column may not exist on a legacy session DB — return null gracefully
    return null;
  }
}
