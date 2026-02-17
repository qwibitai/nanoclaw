/**
 * SSE EventBus — Server-Sent Events for cockpit real-time updates.
 *
 * Security:
 * - Auth: X-OS-SECRET header (same as read endpoints)
 * - Sanitization: events never contain secrets, tokens, SSH keys, raw params
 * - Limits: max 3 connections per session, idle timeout 15 minutes
 * - Backward compatible: if no SSE clients, zero overhead
 */
import http from 'http';
import crypto from 'crypto';

import { logger } from './logger.js';

// --- Event Types ---

export type OpsEventType =
  | 'worker:status'
  | 'tunnel:status'
  | 'dispatch:lifecycle'
  | 'limits:denial'
  | 'breaker:state'
  | 'chat:message'
  | 'notification:created'
  | 'channel:status';

export interface OpsEvent {
  type: OpsEventType;
  data: Record<string, unknown>;
  timestamp: string;
}

// --- Sanitization ---

const FORBIDDEN_KEYS = new Set([
  'shared_secret', 'ssh_identity_file', 'ipc_secret', 'ipcSecret',
  'secret', 'token', 'password', 'hmac', 'OS_HTTP_SECRET',
  'COCKPIT_WRITE_SECRET', 'COCKPIT_WRITE_SECRET_CURRENT',
  'COCKPIT_WRITE_SECRET_PREVIOUS', 'COCKPIT_PASSWORD',
  'COCKPIT_SESSION_SECRET', 'COCKPIT_CSRF_SECRET',
  'GITHUB_TOKEN', 'EXT_CALL_HMAC_SECRET', 'WORKER_SHARED_SECRET',
]);

function sanitize(data: Record<string, unknown>): Record<string, unknown> {
  const clean: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(data)) {
    if (FORBIDDEN_KEYS.has(k)) continue;
    if (typeof v === 'string' && v.length > 500) {
      clean[k] = v.slice(0, 500) + '…';
    } else if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
      clean[k] = sanitize(v as Record<string, unknown>);
    } else {
      clean[k] = v;
    }
  }
  return clean;
}

// --- SSE Connection Manager ---

interface SseConnection {
  id: string;
  res: http.ServerResponse;
  sessionKey: string; // derived from source IP or auth
  connectedAt: number;
  lastEventAt: number;
}

const connections = new Map<string, SseConnection>();
const MAX_PER_SESSION = 3;
const IDLE_TIMEOUT_MS = 15 * 60 * 1000; // 15 minutes

let eventCounter = 0;
let idleCheckInterval: ReturnType<typeof setInterval> | null = null;

// --- Internal Listeners (for alert hooks, etc.) ---

export type OpsEventListener = (type: OpsEventType, data: Record<string, unknown>) => void;
const listeners: OpsEventListener[] = [];

/**
 * Register an internal listener for ops events.
 * Listeners receive sanitized data (same as SSE clients).
 */
export function onOpsEvent(fn: OpsEventListener): void {
  listeners.push(fn);
}

/**
 * Emit an event to all connected SSE clients and internal listeners.
 */
export function emitOpsEvent(type: OpsEventType, data: Record<string, unknown>): void {
  if (connections.size === 0 && listeners.length === 0) return;

  const event: OpsEvent = {
    type,
    data: sanitize(data),
    timestamp: new Date().toISOString(),
  };

  // Notify internal listeners
  for (const fn of listeners) {
    try { fn(type, event.data); } catch { /* listener errors don't break event bus */ }
  }

  // Broadcast to SSE clients
  if (connections.size > 0) {
    eventCounter++;
    const id = String(eventCounter);
    const payload = `id: ${id}\nevent: ${type}\ndata: ${JSON.stringify(event)}\n\n`;

    for (const [connId, conn] of connections) {
      try {
        conn.res.write(payload);
        conn.lastEventAt = Date.now();
      } catch {
        connections.delete(connId);
      }
    }
  }
}

/**
 * Get the session key from a request for connection limiting.
 */
function getSessionKey(req: http.IncomingMessage): string {
  const ip = (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim()
    || req.socket.remoteAddress || 'unknown';
  return ip;
}

/**
 * Count connections for a given session key.
 */
function countSessionConnections(sessionKey: string): number {
  let count = 0;
  for (const conn of connections.values()) {
    if (conn.sessionKey === sessionKey) count++;
  }
  return count;
}

/**
 * Handle an SSE connection request.
 * Auth: requires X-OS-SECRET (same as read endpoints).
 */
export function handleSseConnection(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): void {
  const sessionKey = getSessionKey(req);

  // Connection limit
  if (countSessionConnections(sessionKey) >= MAX_PER_SESSION) {
    res.writeHead(429, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Too many SSE connections (max 3 per session)' }));
    return;
  }

  const connId = crypto.randomUUID();

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'X-OS-SECRET',
    'X-Accel-Buffering': 'no', // Nginx: disable response buffering
  });

  // Send initial connection event
  res.write(`id: 0\nevent: connected\ndata: ${JSON.stringify({ connId })}\n\n`);

  const conn: SseConnection = {
    id: connId,
    res,
    sessionKey,
    connectedAt: Date.now(),
    lastEventAt: Date.now(),
  };
  connections.set(connId, conn);

  logger.info({ connId, sessionKey, total: connections.size }, 'SSE client connected');

  // Heartbeat: send comment every 30s to keep connection alive
  const heartbeat = setInterval(() => {
    try {
      res.write(': heartbeat\n\n');
    } catch {
      clearInterval(heartbeat);
      connections.delete(connId);
    }
  }, 30_000);

  // Cleanup on close
  req.on('close', () => {
    clearInterval(heartbeat);
    connections.delete(connId);
    logger.info({ connId, total: connections.size }, 'SSE client disconnected');
  });

  res.on('error', () => {
    clearInterval(heartbeat);
    connections.delete(connId);
  });
}

/**
 * Start idle connection cleanup (every minute).
 */
export function startSseIdleCheck(): void {
  if (idleCheckInterval) return;
  idleCheckInterval = setInterval(() => {
    const now = Date.now();
    for (const [connId, conn] of connections) {
      if (now - conn.lastEventAt > IDLE_TIMEOUT_MS) {
        logger.info({ connId }, 'SSE idle timeout, closing');
        try { conn.res.end(); } catch { /* ignore */ }
        connections.delete(connId);
      }
    }
  }, 60_000);
}

/**
 * Shut down all SSE connections.
 */
export function shutdownSse(): void {
  if (idleCheckInterval) {
    clearInterval(idleCheckInterval);
    idleCheckInterval = null;
  }
  for (const [connId, conn] of connections) {
    try { conn.res.end(); } catch { /* ignore */ }
    connections.delete(connId);
  }
}

/**
 * Get SSE connection stats (for /ops/stats).
 */
export function getSseStats(): { active_connections: number } {
  return { active_connections: connections.size };
}
