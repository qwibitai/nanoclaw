/**
 * SSE feed for the dashboard.
 *
 * Single global keepalive timer (M22). Per-user cap 20, aggregate cap 200.
 * chokidar v5 watches data/v2-sessions/ directory; emitDashboardEvent is
 * also called directly by dispatch.ts (cycle-3 M2-c3 — central DB is WAL
 * so chokidar misses writes between checkpoints).
 */
import path from 'path';
import http from 'http';
import { createHash } from 'crypto';
import Database from 'better-sqlite3';

import type { AuthedRequestContext, AuthHandler } from '../router.js';
import { log } from '../../log.js';

export type DashboardEventKind = 'inbound_message' | 'task_event';

export interface InboundMessagePayload {
  task_id: string;
  child_session_id: string;
  parent_agent_group_id: string;
  message_id: string;
}

export interface TaskEventPayload {
  task_id: string;
  kind: 'admit' | 'status_change' | 'progress' | 'complete' | 'failed' | 'cancel';
  agent_group_id: string;
  [key: string]: unknown;
}

export function emitDashboardEvent(kind: 'inbound_message', payload: InboundMessagePayload): void;
export function emitDashboardEvent(kind: 'task_event', payload: TaskEventPayload): void;
export function emitDashboardEvent(kind: DashboardEventKind, payload: InboundMessagePayload | TaskEventPayload): void {
  const frame = `event: ${kind}\ndata: ${JSON.stringify(payload)}\n\n`;
  for (const conns of connectionsByUser.values()) {
    for (const conn of conns) {
      const parentGroupId =
        kind === 'inbound_message'
          ? (payload as InboundMessagePayload).parent_agent_group_id
          : (payload as TaskEventPayload).agent_group_id;
      if (!_scopeAllows(conn.scopes, parentGroupId)) continue;
      try {
        conn.res.write(frame);
      } catch {
        // ignore write errors — close handler cleans up
      }
    }
  }
}

function _scopeAllows(scopes: AuthedRequestContext['scopes'], parentGroupId: string): boolean {
  if (scopes.no_filter) return true;
  return scopes.allowed_group_ids.includes(parentGroupId);
}

interface SseConnection {
  id: string;
  userId: string;
  res: http.ServerResponse;
  scopes: AuthedRequestContext['scopes'];
}

const connectionsByUser = new Map<string, Set<SseConnection>>();
let aggregateCount = 0;

const PER_USER_CAP = 20;
const AGGREGATE_CAP = 200;
const KEEPALIVE_INTERVAL_MS = 25_000;
const SESSIONS_ROOT = path.resolve(process.cwd(), 'data/v2-sessions');

function addConnection(conn: SseConnection): void {
  let userSet = connectionsByUser.get(conn.userId);
  if (!userSet) {
    userSet = new Set();
    connectionsByUser.set(conn.userId, userSet);
  }
  userSet.add(conn);
  aggregateCount++;
}

function removeConnection(conn: SseConnection): void {
  const userSet = connectionsByUser.get(conn.userId);
  if (userSet) {
    userSet.delete(conn);
    if (userSet.size === 0) connectionsByUser.delete(conn.userId);
  }
  aggregateCount--;
  if (aggregateCount < 0) aggregateCount = 0;
}

// Single global keepalive timer (M22 — one timer, not per-connection)
let keepaliveTimer: NodeJS.Timeout | null = null;
let watcher: import('chokidar').FSWatcher | null = null;

export function startSSEFeed(): void {
  if (keepaliveTimer !== null) return;

  keepaliveTimer = setInterval(() => {
    const frame = ':keepalive\n\n';
    for (const conns of connectionsByUser.values()) {
      for (const conn of conns) {
        try {
          conn.res.write(frame);
        } catch {
          // ignore
        }
      }
    }
  }, KEEPALIVE_INTERVAL_MS);
  keepaliveTimer.unref();

  void import('chokidar')
    .then(({ watch }) => {
      // ignored function accepts both inbound.db and outbound.db (M4-c2)
      // returning false = DO watch the file; returning true = ignore
      watcher = watch(SESSIONS_ROOT, {
        ignoreInitial: true,
        awaitWriteFinish: { stabilityThreshold: 100, pollInterval: 50 },
        // ignored: return true = skip the path; return false = watch it.
        // Accept inbound.db and outbound.db (M4-c2). Accept directories so
        // chokidar can traverse them. Ignore everything else.
        ignored: (filePath: string) => {
          const base = path.basename(filePath);
          // Always watch the sessions root dir itself
          if (filePath === SESSIONS_ROOT) return false;
          // Accept the two DB files we care about
          if (base === 'inbound.db' || base === 'outbound.db') return false;
          // Accept intermediate directory segments (no extension = directory-like)
          if (!base.includes('.')) return false;
          return true;
        },
      });

      // Post-build QA fix SF-9: chokidar emits `error` events; without a handler
      // they propagate as unhandled `EventEmitter` errors and crash the process on
      // newer Node.js versions. Common trigger: SESSIONS_ROOT doesn't exist on first
      // run before any sessions have been created. Log and continue — the SSE feed
      // remains functional via programmatic emitDashboardEvent calls.
      watcher.on('error', (err) => {
        log.warn('chokidar SSE watcher error', { err });
      });

      watcher.on('change', (filePath: string) => {
        const rel = path.relative(SESSIONS_ROOT, filePath);
        const parts = rel.split(path.sep);
        if (parts.length < 3) return;
        const [agentGroupId, sessionId, filename] = parts;
        if (!agentGroupId || !sessionId) return;
        if (filename !== 'inbound.db' && filename !== 'outbound.db') return;

        _emitInboundChangeEvent(agentGroupId, sessionId, filePath);
      });
    })
    .catch(() => {
      // chokidar unavailable — SSE feed works without filesystem watch
    });
}

function _emitInboundChangeEvent(agentGroupId: string, sessionId: string, filePath: string): void {
  let messageId = `fs:${agentGroupId}:${sessionId}:${Date.now()}`;
  try {
    const db = new Database(filePath, { readonly: true });
    db.pragma('journal_mode = DELETE');
    db.pragma('busy_timeout = 500');
    try {
      const row = db.prepare('SELECT id FROM messages_in ORDER BY seq DESC LIMIT 1').get() as
        | { id: string }
        | undefined;
      if (row) messageId = row.id;
    } finally {
      db.close();
    }
  } catch {
    // ignore — use timestamp-based id
  }

  emitDashboardEvent('inbound_message', {
    task_id: '',
    child_session_id: sessionId,
    parent_agent_group_id: agentGroupId,
    message_id: messageId,
  });
}

export function stopSSEFeed(): void {
  if (keepaliveTimer !== null) {
    clearInterval(keepaliveTimer);
    keepaliveTimer = null;
  }
  if (watcher !== null) {
    watcher.close().catch(() => {});
    watcher = null;
  }
  for (const conns of connectionsByUser.values()) {
    for (const conn of conns) {
      try {
        conn.res.end();
      } catch {
        // ignore
      }
    }
  }
  connectionsByUser.clear();
  aggregateCount = 0;
}

export const eventsHandler: AuthHandler = async (_req, _params, ctx) => {
  const userId = ctx.user.id;

  const userConns = connectionsByUser.get(userId);
  if (userConns && userConns.size >= PER_USER_CAP) {
    return new Response(JSON.stringify({ error: 'too_many_connections' }), {
      status: 429,
      headers: { 'Content-Type': 'application/json', 'Retry-After': '1' },
    });
  }

  if (aggregateCount >= AGGREGATE_CAP) {
    return new Response(JSON.stringify({ error: 'too_many_connections' }), {
      status: 429,
      headers: { 'Content-Type': 'application/json', 'Retry-After': '1' },
    });
  }

  const nodeReq: http.IncomingMessage = ctx.rawNodeReq;
  // rawNodeRes is set by dispatch in router.ts
  const nodeRes: http.ServerResponse = (ctx as unknown as { rawNodeRes: http.ServerResponse }).rawNodeRes;

  nodeRes.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });

  const connId = createHash('sha256').update(`${userId}:${Date.now()}:${Math.random()}`).digest('hex').slice(0, 16);

  const conn: SseConnection = {
    id: connId,
    userId,
    res: nodeRes,
    scopes: ctx.scopes,
  };

  addConnection(conn);

  nodeReq.on('close', () => {
    removeConnection(conn);
    try {
      nodeRes.end();
    } catch {
      // ignore
    }
  });

  return null;
};
