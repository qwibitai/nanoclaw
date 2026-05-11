/**
 * GET /dashboard/api/tasks — list tasks with §2a scope filter.
 * GET /dashboard/api/tasks/:id — task detail with transcript merge.
 *
 * Transcript merges inbound + outbound DBs, sorted by Date.parse(timestamp)
 * (cycle-3 M1-c3 — host writes ISO with T+ms+Z, container writes
 * datetime('now') without T; lex sort mis-orders across the two formats).
 */
import fs from 'fs';
import path from 'path';
import Database from 'better-sqlite3';

import { getDb } from '../../db/connection.js';
import { log } from '../../log.js';
import type { AuthHandler } from '../router.js';

interface TaskSummary {
  task_id: string;
  status: string;
  parent_session_id: string;
  admitted_at: string;
  last_progress_message: string | null;
  fail_reason: string | null;
  surface_mode: string;
  parent_agent_group_id: string;
  task_content: string;
}

interface TranscriptEntry {
  id: string;
  seq: number;
  kind: string;
  timestamp: string;
  content: unknown;
  direction: 'inbound' | 'outbound';
  source: 'dashboard' | 'chat' | 'agent' | 'system';
}

const SESSIONS_ROOT = path.resolve(process.cwd(), 'data/v2-sessions');
const TRANSCRIPT_LIMIT = 200;

function buildScopeFilter(ctx: Parameters<AuthHandler>[2]): { where: string; groupIds: string[] } {
  if (ctx.scopes.no_filter) return { where: '', groupIds: [] };
  const ids = ctx.scopes.allowed_group_ids;
  if (ids.length === 0) return { where: 'AND 1=0', groupIds: [] };
  const placeholders = ids.map(() => '?').join(', ');
  return { where: `AND parent_agent_group_id IN (${placeholders})`, groupIds: ids };
}

function _classifySource(direction: 'inbound' | 'outbound', content: unknown): TranscriptEntry['source'] {
  if (direction === 'inbound') {
    if (content && typeof content === 'object') {
      const c = content as Record<string, unknown>;
      if (c['_via'] === 'dashboard') return 'dashboard';
      if (c['platformId']) return 'chat';
    }
    return 'chat';
  }
  // outbound
  if (content && typeof content === 'object') {
    const c = content as Record<string, unknown>;
    if (c['kind'] === 'status' || c['kind'] === 'progress') return 'system';
  }
  return 'agent';
}

function _parseContent(raw: string | null): { parsed: unknown; ok: boolean } {
  if (!raw) return { parsed: null, ok: true };
  try {
    return { parsed: JSON.parse(raw), ok: true };
  } catch {
    return { parsed: raw, ok: false };
  }
}

function _loadTranscript(agentGroupId: string, sessionId: string): TranscriptEntry[] {
  const entries: (TranscriptEntry & { sortKey: number; dirOrder: number })[] = [];

  const inPath = path.join(SESSIONS_ROOT, agentGroupId, sessionId, 'inbound.db');
  if (fs.existsSync(inPath)) {
    try {
      const db = new Database(inPath, { readonly: true });
      db.pragma('journal_mode = DELETE');
      db.pragma('busy_timeout = 1000');
      try {
        const rows = db
          .prepare('SELECT id, seq, kind, timestamp, content FROM messages_in ORDER BY seq DESC LIMIT ?')
          .all(TRANSCRIPT_LIMIT) as Array<{ id: string; seq: number; kind: string; timestamp: string; content: string | null }>;
        for (const row of rows) {
          const { parsed, ok } = _parseContent(row.content);
          if (!ok) log.warn('tasks: unparseable inbound content', { id: row.id });
          entries.push({
            id: row.id,
            seq: row.seq,
            kind: row.kind,
            timestamp: row.timestamp,
            content: parsed,
            direction: 'inbound',
            source: ok ? _classifySource('inbound', parsed) : 'agent',
            sortKey: Date.parse(row.timestamp),
            dirOrder: 0,
          });
        }
      } finally {
        db.close();
      }
    } catch (err) {
      log.warn('tasks: failed to read inbound.db', { agentGroupId, sessionId, err });
    }
  }

  const outPath = path.join(SESSIONS_ROOT, agentGroupId, sessionId, 'outbound.db');
  if (fs.existsSync(outPath)) {
    try {
      const db = new Database(outPath, { readonly: true });
      db.pragma('journal_mode = DELETE');
      db.pragma('busy_timeout = 1000');
      try {
        const rows = db
          .prepare('SELECT id, seq, kind, timestamp, content FROM messages_out ORDER BY seq DESC LIMIT ?')
          .all(TRANSCRIPT_LIMIT) as Array<{ id: string; seq: number; kind: string; timestamp: string; content: string | null }>;
        for (const row of rows) {
          const { parsed, ok } = _parseContent(row.content);
          if (!ok) log.warn('tasks: unparseable outbound content', { id: row.id });
          entries.push({
            id: row.id,
            seq: row.seq,
            kind: row.kind,
            timestamp: row.timestamp,
            content: parsed,
            direction: 'outbound',
            source: ok ? _classifySource('outbound', parsed) : 'agent',
            sortKey: Date.parse(row.timestamp),
            dirOrder: 1,
          });
        }
      } finally {
        db.close();
      }
    } catch (err) {
      log.warn('tasks: failed to read outbound.db', { agentGroupId, sessionId, err });
    }
  }

  // Sort: Date.parse DESC, then inbound before outbound (dirOrder 0 < 1), then seq DESC
  entries.sort((a, b) => {
    if (b.sortKey !== a.sortKey) return b.sortKey - a.sortKey;
    if (a.dirOrder !== b.dirOrder) return a.dirOrder - b.dirOrder;
    return b.seq - a.seq;
  });

  return entries.slice(0, TRANSCRIPT_LIMIT).map(({ sortKey: _s, dirOrder: _d, ...e }) => e);
}

export const tasksListHandler: AuthHandler = async (req, _params, ctx) => {
  const url = new URL(req.url);
  const statusFilter = url.searchParams.get('status');
  const limit = Math.min(parseInt(url.searchParams.get('limit') ?? '50', 10) || 50, 200);
  const before = url.searchParams.get('before');

  const { where: scopeWhere, groupIds } = buildScopeFilter(ctx);

  const conditions: string[] = ['1=1'];
  const values: unknown[] = [];

  if (scopeWhere) {
    conditions.push(`parent_agent_group_id IN (${groupIds.map(() => '?').join(', ')})`);
    values.push(...groupIds);
  }
  if (statusFilter) {
    conditions.push('status = ?');
    values.push(statusFilter);
  }
  if (before) {
    conditions.push('admitted_at < ?');
    values.push(before);
  }

  // task_content is required by the KanbanBoard card render (post-build QA fix MF-5);
  // omitting it caused TypeError on truncate(undefined.length) in the SPA.
  const sql = `SELECT task_id, status, parent_session_id, parent_agent_group_id, admitted_at,
                      last_progress_message, fail_reason, surface_mode, task_content
               FROM tasks
               WHERE ${conditions.join(' AND ')}
               ORDER BY admitted_at DESC
               LIMIT ?`;
  values.push(limit + 1);

  let rows: TaskSummary[];
  try {
    rows = getDb().prepare(sql).all(...(values as Parameters<ReturnType<ReturnType<typeof getDb>['prepare']>['all']>)) as TaskSummary[];
  } catch (err) {
    log.warn('tasksListHandler: DB error', { err });
    return new Response(JSON.stringify({ error: 'internal_error' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const hasMore = rows.length > limit;
  const tasks = hasMore ? rows.slice(0, limit) : rows;
  const cursor = hasMore ? tasks[tasks.length - 1]?.admitted_at ?? null : null;

  return new Response(JSON.stringify({ tasks, cursor }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
};

export const tasksDetailHandler: AuthHandler = async (_req, params, ctx) => {
  const taskId = params['id'] ?? '';

  let task: (TaskSummary & { child_session_id: string | null }) | null;
  try {
    task = getDb()
      .prepare('SELECT * FROM tasks WHERE task_id = ?')
      .get(taskId) as (TaskSummary & { child_session_id: string | null }) | null;
  } catch (err) {
    log.warn('tasksDetailHandler: DB error', { err });
    return new Response(JSON.stringify({ error: 'internal_error' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  if (!task) {
    return new Response(JSON.stringify({ error: 'task_not_found' }), {
      status: 404,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // §2a scope filter — disclose-as-not-found (not 403)
  if (!ctx.scopes.no_filter) {
    if (!ctx.scopes.allowed_group_ids.includes(task.parent_agent_group_id)) {
      return new Response(JSON.stringify({ error: 'task_not_found' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      });
    }
  }

  const transcript: TranscriptEntry[] = [];
  if (task.child_session_id) {
    const merged = _loadTranscript(task.parent_agent_group_id, task.child_session_id);
    transcript.push(...merged);
  }

  return new Response(JSON.stringify({ task, transcript }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
};

// Routes are registered by Group A's startDashboard() via requireAuth().
