/**
 * scheduleTask — public API for inserting recurring tasks into a session's
 * inbound.db.
 *
 * Security model (post-2026-05-02 cross-tenant leak):
 *   - `destination` is REQUIRED. A task with no chat destination would fall
 *     back to "newest active session" of the agent group, which can land in
 *     any messaging group wired to that agent — i.e., a typo in agentGroupId
 *     or a misrouted task can silently leak into a different chat surface.
 *   - The destination's messaging_group MUST be wired to the agent_group via
 *     `messaging_group_agents`. If it isn't, scheduleTask refuses — this
 *     catches the case where a task is wired to the wrong agent group (the
 *     credential boundary).
 *   - The session is resolved by (agent_group_id, messaging_group_id), never
 *     by agent_group_id alone.
 *
 * Idempotent via series_id: re-running with the same seriesId UPDATEs the
 * existing row's cron + processAfter + content rather than inserting a
 * duplicate.
 */
import fs from 'fs';
import path from 'path';

import Database from 'better-sqlite3';

import { DATA_DIR } from '../config.js';
import { createSession, findSessionByAgentGroupAndMessagingGroup } from './sessions.js';
import { getDb } from './connection.js';
import { ensureSchema } from './session-db.js';
import { nextEvenSeq } from './session-db.js';

export interface TaskDef {
  id: string;
  agentGroupId: string;
  cron: string;
  processAfter: string;
  seriesId: string;
  prompt: string;
  tz?: string;
  /**
   * REQUIRED. Where the task's chat output lands AND the messaging group
   * whose session the task is inserted into. The (agent_group_id,
   * messaging_group_id) pair must already be wired via
   * `messaging_group_agents` — scheduleTask refuses unwired pairs to prevent
   * a misconfigured task from silently leaking into a chat the operator
   * didn't authorize for that agent.
   *
   * Pass `threadId=null` to post in the parent channel.
   */
  destination: {
    platformId: string;
    channelType: string;
    threadId: string | null;
  };
  /**
   * Suppress streaming status updates ("> 💭 ...") for the task's turn.
   * Final chat messages still deliver normally — the agent decides whether
   * to write one. Use for background maintenance tasks where the only
   * interesting output is "I did N things" or nothing at all.
   */
  quietStatus?: boolean;
  /**
   * Per-task model + effort override. The container's poll-loop applyFlagBatch
   * reads this and pins model/effort for the wake-turn without changing the
   * agent group's sticky config. Used by daily wiki-synthesise to run on Opus
   * with reasoning_effort=high while keeping normal chat on the group's
   * default (typically Sonnet).
   *
   * Schema mirrors the chat-side FlagIntent contract — turnModel/turnEffort
   * apply for this fire only; sticky variants would persist across fires.
   */
  flagIntent?: {
    turnModel?: string;
    turnEffort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
    stickyModel?: string;
    stickyEffort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
    clearStickyModel?: boolean;
    clearStickyEffort?: boolean;
  };
}

function generateSessionId(): string {
  return `sess-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function initStubSessionFolder(dataDir: string, agentGroupId: string, sessionId: string): void {
  const dir = path.join(dataDir, 'v2-sessions', agentGroupId, sessionId);
  fs.mkdirSync(dir, { recursive: true });
  const inboundPath = path.join(dir, 'inbound.db');
  ensureSchema(inboundPath, 'inbound');
  const outboundPath = path.join(dir, 'outbound.db');
  ensureSchema(outboundPath, 'outbound');
}

/**
 * Resolve (or create) the channel-root session for an (agent_group_id,
 * messaging_group_id) pair. Channel-root means `thread_id IS NULL`; this is
 * the canonical home for scheduled-task rows (`src/db/sessions.ts:74-83`).
 *
 * Concurrency: the lookup-then-insert is racy without protection — two
 * simultaneous callers can both miss the existing row and both try to
 * INSERT. The `sessions_channel_root_unique` partial index (migration 024)
 * makes the second INSERT throw `SQLITE_CONSTRAINT_UNIQUE`, which we catch
 * and resolve by re-lookup.
 */
export async function resolveActiveSession(
  agentGroupId: string,
  messagingGroupId: string,
  dataDir: string = DATA_DIR,
): Promise<{ id: string }> {
  const existing = findSessionByAgentGroupAndMessagingGroup(agentGroupId, messagingGroupId);
  if (existing) return { id: existing.id };

  const sessionId = generateSessionId();
  try {
    createSession({
      id: sessionId,
      agent_group_id: agentGroupId,
      messaging_group_id: messagingGroupId,
      thread_id: null,
      agent_provider: null,
      status: 'active',
      container_status: 'stopped',
      last_active: null,
      created_at: new Date().toISOString(),
    });
  } catch (err) {
    if ((err as { code?: string }).code !== 'SQLITE_CONSTRAINT_UNIQUE') throw err;
    const winner = findSessionByAgentGroupAndMessagingGroup(agentGroupId, messagingGroupId);
    if (winner) return { id: winner.id };
    throw err;
  }
  initStubSessionFolder(dataDir, agentGroupId, sessionId);
  return { id: sessionId };
}

/**
 * Resolve the messaging group from the task's destination and validate that
 * the agent group is wired to it via `messaging_group_agents`. Throws if:
 *   - no messaging group exists with that (platform_id, channel_type)
 *   - the agent group is not wired to that messaging group (catches
 *     misrouted tasks at the credential boundary)
 *
 * `destination` is required by `TaskDef`'s type — TypeScript prevents
 * callers from omitting it; no runtime guard needed.
 */
function resolveAndValidateDestination(def: TaskDef): { messagingGroupId: string } {
  const { platformId, channelType } = def.destination;
  const db = getDb();
  const mg = db
    .prepare('SELECT id FROM messaging_groups WHERE platform_id = ? AND channel_type = ?')
    .get(platformId, channelType) as { id: string } | undefined;
  if (!mg) {
    throw new Error(
      `scheduleTask: no messaging group found for ${channelType}:${platformId} (task ${def.id}). The destination must reference an existing messaging group.`,
    );
  }
  const wired = db
    .prepare('SELECT 1 AS ok FROM messaging_group_agents WHERE agent_group_id = ? AND messaging_group_id = ?')
    .get(def.agentGroupId, mg.id) as { ok: number } | undefined;
  if (!wired) {
    throw new Error(
      `scheduleTask: agent group ${def.agentGroupId} is not wired to messaging group ${mg.id} (${channelType}:${platformId}). Refusing to schedule task ${def.id} — this would route output to a chat the agent isn't authorized for. Wire the messaging group via messaging_group_agents first, or correct the agentGroupId.`,
    );
  }
  return { messagingGroupId: mg.id };
}

export async function scheduleTask(def: TaskDef, _dataDir?: string): Promise<void> {
  const dataDir = _dataDir ?? DATA_DIR;
  const { messagingGroupId } = resolveAndValidateDestination(def);
  const session = await resolveActiveSession(def.agentGroupId, messagingGroupId, dataDir);
  const inboundDbPath = path.join(dataDir, 'v2-sessions', def.agentGroupId, session.id, 'inbound.db');

  const db = new Database(inboundDbPath);
  db.pragma('journal_mode = DELETE');
  db.pragma('busy_timeout = 5000');
  try {
    const content = JSON.stringify({
      prompt: def.prompt,
      ...(def.quietStatus ? { quietStatus: true } : {}),
      ...(def.flagIntent ? { flagIntent: def.flagIntent } : {}),
    });
    // Idempotency: active series (pending/paused) → UPDATE; terminal rows (completed/failed/cancelled)
    // are treated as absent so a fresh row is inserted, enabling re-scheduling after cancellation.
    const activeRow = db
      .prepare("SELECT id FROM messages_in WHERE series_id = ? AND status IN ('pending', 'paused')")
      .get(def.seriesId) as { id: string } | undefined;

    const platformId = def.destination.platformId;
    const channelType = def.destination.channelType;
    const threadId = def.destination.threadId;

    if (activeRow) {
      db.prepare(
        `UPDATE messages_in
            SET process_after = ?,
                recurrence    = ?,
                content       = ?,
                platform_id   = ?,
                channel_type  = ?,
                thread_id     = ?,
                tries         = 0
          WHERE id = ?`,
      ).run(def.processAfter, def.cron, content, platformId, channelType, threadId, activeRow.id);
    } else {
      const seq = nextEvenSeq(db);
      db.prepare(
        `INSERT INTO messages_in
           (id, seq, kind, timestamp, status, tries, process_after, recurrence, series_id, content, platform_id, channel_type, thread_id)
         VALUES (?, ?, 'task', datetime('now'), 'pending', 0, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(def.id, seq, def.processAfter, def.cron, def.seriesId, content, platformId, channelType, threadId);
    }
  } finally {
    db.close();
  }
}
