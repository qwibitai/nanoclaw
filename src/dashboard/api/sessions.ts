/**
 * GET /dashboard/api/sessions — lists sessions with §2a scope filter.
 *
 * container_status is derived from heartbeat file mtime, NOT from the DB:
 *   <60s  → 'running'
 *   <300s → 'idle'
 *   ≥300s → 'stale'
 *   missing → 'unknown'
 */
import fs from 'fs';
import path from 'path';

import { getDb } from '../../db/connection.js';
import { heartbeatPath } from '../../session-manager.js';
import { log } from '../../log.js';
import type { AuthHandler } from '../router.js';

export interface SessionSummary {
  agent_group_id: string;
  session_id: string;
  last_active: string | null;
  container_status: 'idle' | 'running' | 'stale' | 'unknown';
  messaging_group_id: string | null;
  thread_id: string | null;
}

function deriveContainerStatus(agentGroupId: string, sessionId: string): SessionSummary['container_status'] {
  const hbPath = heartbeatPath(agentGroupId, sessionId);
  let mtimeMs: number;
  try {
    mtimeMs = fs.statSync(hbPath).mtimeMs;
  } catch {
    return 'unknown';
  }
  const ageMs = Date.now() - mtimeMs;
  if (ageMs < 60_000) return 'running';
  if (ageMs < 300_000) return 'idle';
  return 'stale';
}

export const sessionsHandler: AuthHandler = async (req, _params, ctx) => {
  const url = new URL(req.url);
  const limit = Math.min(parseInt(url.searchParams.get('limit') ?? '100', 10) || 100, 500);

  const conditions: string[] = ["status = 'active'"];
  const values: unknown[] = [];

  if (!ctx.scopes.no_filter) {
    const ids = ctx.scopes.allowed_group_ids;
    if (ids.length === 0) {
      return new Response(JSON.stringify({ sessions: [] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    const placeholders = ids.map(() => '?').join(', ');
    conditions.push(`agent_group_id IN (${placeholders})`);
    values.push(...ids);
  }

  values.push(limit);

  const sql = `SELECT id, agent_group_id, messaging_group_id, thread_id, last_active
               FROM sessions
               WHERE ${conditions.join(' AND ')}
               ORDER BY last_active DESC
               LIMIT ?`;

  let rows: Array<{
    id: string;
    agent_group_id: string;
    messaging_group_id: string | null;
    thread_id: string | null;
    last_active: string | null;
  }>;

  try {
    rows = getDb()
      .prepare(sql)
      .all(...(values as Parameters<ReturnType<ReturnType<typeof getDb>['prepare']>['all']>)) as typeof rows;
  } catch (err) {
    log.warn('sessionsHandler: DB error', { err });
    return new Response(JSON.stringify({ error: 'internal_error' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const sessions: SessionSummary[] = rows.map((row) => ({
    agent_group_id: row.agent_group_id,
    session_id: row.id,
    last_active: row.last_active,
    container_status: deriveContainerStatus(row.agent_group_id, row.id),
    messaging_group_id: row.messaging_group_id,
    thread_id: row.thread_id,
  }));

  return new Response(JSON.stringify({ sessions }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
};
