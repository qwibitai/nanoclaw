/**
 * WebSocket handler for the NanoClaw Web UI.
 *
 * Uses `ws` in noServer mode — attached to the HTTP server's upgrade event.
 * Auth via ?token= at upgrade time (reuse checkAuth from web-ui.ts).
 * Origin validation against WEB_UI_ORIGINS.
 */
import crypto from 'crypto';
import { IncomingMessage, Server } from 'http';
import { WebSocket, WebSocketServer } from 'ws';

import { isWebJid, makeWebJid, WEB_UI_SENDER_NAME } from '../config.js';
import { logger } from '../logger.js';
import { isOriginAllowed } from './cors.js';
import type { Capabilities, WsServerMessage } from './types.js';

// --- Rate limiting ---

const RATE_LIMIT_WINDOW_MS = 60_000; // 1 minute
const RATE_LIMIT_MAX = 10; // max send_message per window

interface RateState {
  count: number;
  windowStart: number;
}

// --- Ring buffer for reconnection replay ---

const RING_BUFFER_SIZE = 500;
const ringBuffer: Array<{ data: string; timestamp: number; group: string }> =
  [];
let ringHead = 0;
let ringCount = 0;

function pushToRingBuffer(data: string, group: string): void {
  if (ringCount < RING_BUFFER_SIZE) {
    ringBuffer.push({ data, timestamp: Date.now(), group });
    ringCount++;
  } else {
    ringBuffer[ringHead] = { data, timestamp: Date.now(), group };
    ringHead = (ringHead + 1) % RING_BUFFER_SIZE;
  }
}

/** Get events from the ring buffer after a given timestamp, filtered by group. */
export function getEventsSince(
  since: number,
  subscribedGroups: Set<string> | null,
): Array<{ data: string; timestamp: number }> {
  const results: Array<{ data: string; timestamp: number }> = [];
  const len = ringCount;
  for (let i = 0; i < len; i++) {
    const idx =
      ringCount < RING_BUFFER_SIZE ? i : (ringHead + i) % RING_BUFFER_SIZE;
    const entry = ringBuffer[idx];
    if (entry && entry.timestamp > since) {
      // Filter by subscribed groups if specified.
      // Empty-group entries (e.g. session_end) always pass through.
      if (
        subscribedGroups !== null &&
        entry.group !== '' &&
        !subscribedGroups.has(entry.group)
      ) {
        continue;
      }
      results.push(entry);
    }
  }
  return results;
}

/** Get the timestamp of the oldest entry in the ring buffer, or 0 if empty. */
function getOldestBufferTimestamp(): number {
  if (ringCount === 0) return 0;
  const oldestIdx = ringCount < RING_BUFFER_SIZE ? 0 : ringHead;
  return ringBuffer[oldestIdx]?.timestamp ?? 0;
}

// --- Max connections ---

const MAX_WS_CONNECTIONS = 100;

// --- Backpressure threshold ---

const BACKPRESSURE_THRESHOLD = 1_048_576; // 1MB

// --- Module-level rate tracking (survives reconnects) ---

const rateLimitByToken = new Map<string, RateState>();

/** Clean up stale rate-limit entries every 5 minutes. */
setInterval(() => {
  const now = Date.now();
  for (const [key, state] of rateLimitByToken) {
    if (now - state.windowStart > RATE_LIMIT_WINDOW_MS * 2) {
      rateLimitByToken.delete(key);
    }
  }
}, 5 * 60_000).unref();

// --- Connection tracking ---

interface WsClient {
  ws: WebSocket;
  subscribedGroups: Set<string> | null; // null = all groups (default)
  tokenHash: string; // first 16 chars of token for rate tracking
  authResolved: boolean; // false until JWT auth check completes
  userId?: string; // set when authenticated via JWT
  allowedGroups?: Set<string>; // set for non-admin JWT users; undefined = no restriction
}

const wsClients = new Set<WsClient>();

// --- WebSocket deps ---

export interface WsDeps {
  checkAuth: (
    req: IncomingMessage,
    token: string,
  ) => Promise<import('./types.js').AuthUser | boolean>;
  getCapabilities: () => Capabilities;
  startSession: (
    groupJid: string,
    text: string,
    senderName: string,
    senderId: string,
    threadId?: string,
  ) => string | false;
}

// --- Helpers ---

function sendJson(ws: WebSocket, msg: WsServerMessage): void {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg));
  }
}

function checkRateLimit(tokenHash: string): boolean {
  const now = Date.now();
  let state = rateLimitByToken.get(tokenHash);
  if (!state || now - state.windowStart > RATE_LIMIT_WINDOW_MS) {
    state = { count: 0, windowStart: now };
    rateLimitByToken.set(tokenHash, state);
  }
  state.count++;
  return state.count <= RATE_LIMIT_MAX;
}

function validateOrigin(req: IncomingMessage): boolean {
  const origin = req.headers.origin;
  // No Origin header (same-origin / non-browser) — allow
  if (!origin) return true;
  // Delegate to shared origin validation
  return isOriginAllowed(origin);
}

// --- Init ---

/**
 * Initialize WebSocket handling on the given HTTP server.
 * Returns functions for broadcasting events to WS clients.
 */
export function initWebSocket(
  server: Server,
  deps: WsDeps,
  token: string,
): {
  broadcastWs: (sessionKey: string, group: string, event: unknown) => void;
  notifyWsSessionStart: (
    sessionKey: string,
    group: string,
    groupJid: string,
    threadId?: string,
  ) => void;
  notifyWsSessionEnd: (sessionKey: string) => void;
  notifyWsSkillInstall: (
    jobId: string,
    output: string,
    status: 'running' | 'completed' | 'failed',
  ) => void;
  broadcastWebMessage: (
    groupFolder: string,
    threadId: string | undefined,
    text: string,
  ) => void;
} {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 65_536 });

  // Handle HTTP upgrade
  server.on('upgrade', (req, socket, head) => {
    // Reject if at connection limit (before auth to save work)
    if (wsClients.size >= MAX_WS_CONNECTIONS) {
      socket.write('HTTP/1.1 503 Service Unavailable\r\n\r\n');
      socket.destroy();
      return;
    }

    // Origin validation (sync, before async auth)
    if (!validateOrigin(req)) {
      socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
      socket.destroy();
      return;
    }

    // Auth check (async)
    deps
      .checkAuth(req, token)
      .then((authResult) => {
        if (!authResult) {
          socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
          socket.destroy();
          return;
        }

        wss.handleUpgrade(req, socket, head, (ws) => {
          wss.emit('connection', ws, req);
        });
      })
      .catch(() => {
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
        socket.destroy();
      });
  });

  // Handle new connections
  wss.on('connection', (ws: WebSocket, req: IncomingMessage) => {
    // Extract token hash for rate limiting (survives reconnects)
    const reqUrl = new URL(
      req.url || '/',
      `http://${req.headers.host || 'localhost'}`,
    );
    const tokenParam = reqUrl.searchParams.get('token') || '';
    const tokenHash = tokenParam.slice(0, 16) || 'anonymous';

    const client: WsClient = {
      ws,
      subscribedGroups: null, // default: all groups
      tokenHash,
      authResolved: false,
    };
    wsClients.add(client);

    // Resolve JWT auth from cookie for group isolation.
    // Message handling is deferred until this resolves (authResolved flag).
    deps
      .checkAuth(req, token)
      .then((authResult) => {
        if (authResult && authResult !== true) {
          client.userId = authResult.id;
          if (authResult.role !== 'admin') {
            client.allowedGroups = new Set(authResult.groups);
          }
        }
      })
      .catch(() => {
        // Auth resolution failure is non-fatal for already-connected WS
      })
      .finally(() => {
        client.authResolved = true;
      });

    // Send connected message with capabilities
    sendJson(ws, {
      type: 'connected',
      capabilities: deps.getCapabilities(),
    });

    // Handle incoming messages
    ws.on('message', (raw: Buffer | string) => {
      let msg: unknown;
      try {
        msg = JSON.parse(typeof raw === 'string' ? raw : raw.toString('utf-8'));
      } catch {
        sendJson(ws, {
          type: 'error',
          code: 'invalid_json',
          message: 'Could not parse message as JSON',
        });
        return;
      }

      // Validate parsed message shape
      if (
        !msg ||
        typeof msg !== 'object' ||
        typeof (msg as Record<string, unknown>).type !== 'string'
      ) {
        sendJson(ws, {
          type: 'error',
          code: 'invalid_message',
          message: 'Message must be an object with a string "type" field',
        });
        return;
      }

      const parsed = msg as Record<string, unknown>;

      if (parsed.type === 'send_message') {
        // Block messages until JWT auth resolution completes (prevents
        // allowedGroups bypass during the async auth window)
        if (!client.authResolved) {
          sendJson(ws, {
            type: 'error',
            code: 'auth_pending',
            message: 'Authentication still resolving, try again shortly',
          });
          return;
        }

        // Rate limit check (keyed by token hash, not per-connection)
        if (!checkRateLimit(client.tokenHash)) {
          sendJson(ws, {
            type: 'error',
            code: 'rate_limited',
            message: 'Rate limit exceeded: max 10 messages per minute',
          });
          return;
        }

        const text = parsed.text;
        if (typeof text !== 'string') {
          sendJson(ws, {
            type: 'error',
            code: 'invalid_params',
            message: 'Missing required field: text (string)',
          });
          return;
        }

        // Support groupFolder (web channel) or groupJid (legacy/native channel)
        let groupJid: string;
        let groupFolder: string | undefined;
        if (typeof parsed.groupFolder === 'string' && parsed.groupFolder) {
          groupFolder = parsed.groupFolder;
          groupJid = makeWebJid(groupFolder);
        } else if (
          typeof parsed.groupJid === 'string' &&
          parsed.groupJid
        ) {
          groupJid = parsed.groupJid;
        } else {
          sendJson(ws, {
            type: 'error',
            code: 'invalid_params',
            message:
              'Missing required field: groupFolder (string) or groupJid (string)',
          });
          return;
        }

        // Enforce group-level authorization for non-admin JWT users
        if (client.allowedGroups) {
          // Resolve folder: from groupFolder param, or look up via capabilities
          const folder =
            groupFolder ||
            deps
              .getCapabilities()
              .groups?.find((g) => g.jid === groupJid)?.folder;
          if (!folder || !client.allowedGroups.has(folder)) {
            sendJson(ws, {
              type: 'error',
              code: 'unauthorized_group',
              message: 'Not authorized for this group',
            });
            return;
          }
        }

        const senderName =
          (typeof parsed.senderName === 'string' && parsed.senderName) ||
          WEB_UI_SENDER_NAME;
        const senderId =
          (typeof parsed.senderId === 'string' && parsed.senderId) ||
          `web-ui-${crypto.randomUUID().slice(0, 8)}`;

        const threadId =
          typeof parsed.threadId === 'string' ? parsed.threadId : undefined;

        // startSession now returns the real message ID or false
        const msgId = deps.startSession(
          groupJid,
          text,
          senderName,
          senderId,
          threadId,
        );
        if (msgId) {
          sendJson(ws, { type: 'message_stored', id: msgId });
        } else {
          sendJson(ws, {
            type: 'error',
            code: 'group_not_found',
            message: `Group not found: ${groupJid}`,
          });
        }
      } else if (parsed.type === 'subscribe') {
        const groups = parsed.groups;
        if (groups && Array.isArray(groups)) {
          const requested = groups.filter(
            (g): g is string => typeof g === 'string',
          );
          // Enforce group-level isolation for non-admin JWT users
          if (client.allowedGroups !== undefined) {
            const unauthorized = requested.filter(
              (g) => !client.allowedGroups!.has(g),
            );
            if (unauthorized.length > 0) {
              sendJson(ws, {
                type: 'error',
                code: 'unauthorized_group',
                message: `Not authorized to subscribe to groups: ${unauthorized.join(', ')}`,
              });
              return;
            }
          }
          client.subscribedGroups = new Set(requested);
        } else {
          client.subscribedGroups = null; // all groups
        }

        // Replay missed events on subscribe with since
        const since = parsed.since;
        if (typeof since === 'number' && since > 0) {
          const oldest = getOldestBufferTimestamp();
          if (oldest > 0 && since < oldest) {
            // Requested timestamp is older than our buffer — full resync needed
            sendJson(ws, { type: 'resync' });
          } else {
            const missed = getEventsSince(since, client.subscribedGroups);
            for (const entry of missed) {
              if (ws.readyState === WebSocket.OPEN) {
                ws.send(entry.data);
              }
            }
          }
        }
      } else {
        sendJson(ws, {
          type: 'error',
          code: 'unknown_type',
          message: `Unknown message type: ${String(parsed.type)}`,
        });
      }
    });

    ws.on('close', () => {
      wsClients.delete(client);
    });

    ws.on('error', () => {
      wsClients.delete(client);
    });
  });

  // --- Broadcast functions ---

  /**
   * Send data to all matching WS clients, with optional group filtering and backpressure.
   * When skipBackpressure is true, messages are always sent (for lifecycle events).
   * Respects per-client allowedGroups for JWT non-admin users.
   */
  function broadcastToWsClients(
    data: string,
    opts?: { group?: string; skipBackpressure?: boolean },
  ): void {
    const group = opts?.group;
    const skipBackpressure = opts?.skipBackpressure ?? false;
    for (const client of wsClients) {
      // Subscribed-groups filter (client-side subscribe filter)
      if (
        group !== undefined &&
        client.subscribedGroups !== null &&
        !client.subscribedGroups.has(group)
      ) {
        continue;
      }
      // allowedGroups filter (server-side JWT isolation)
      if (
        group !== undefined &&
        client.allowedGroups !== undefined &&
        !client.allowedGroups.has(group)
      ) {
        continue;
      }
      if (
        !skipBackpressure &&
        client.ws.bufferedAmount > BACKPRESSURE_THRESHOLD
      ) {
        continue;
      }
      if (client.ws.readyState === WebSocket.OPEN) {
        client.ws.send(data);
      }
    }
  }

  function broadcastWs(
    sessionKey: string,
    group: string,
    event: unknown,
  ): void {
    const data = JSON.stringify({
      type: 'progress',
      sessionKey,
      group,
      event,
    } satisfies WsServerMessage);
    pushToRingBuffer(data, group);
    broadcastToWsClients(data, { group });
  }

  function notifyWsSessionStart(
    sessionKey: string,
    group: string,
    groupJid: string,
    threadId?: string,
  ): void {
    const data = JSON.stringify({
      type: 'session_start',
      sessionKey,
      group,
      groupJid,
      threadId,
    } satisfies WsServerMessage);
    pushToRingBuffer(data, group);
    broadcastToWsClients(data, { group, skipBackpressure: true });
  }

  function notifyWsSessionEnd(sessionKey: string): void {
    const data = JSON.stringify({
      type: 'session_end',
      sessionKey,
    } satisfies WsServerMessage);
    pushToRingBuffer(data, '');
    broadcastToWsClients(data, { skipBackpressure: true });
  }

  function notifyWsSkillInstall(
    jobId: string,
    output: string,
    status: 'running' | 'completed' | 'failed',
  ): void {
    const data = JSON.stringify({
      type: 'skill_install_progress',
      jobId,
      output,
      status,
    } satisfies WsServerMessage);
    broadcastToWsClients(data, { skipBackpressure: true });
  }

  function broadcastWebMessage(
    groupFolder: string,
    threadId: string | undefined,
    text: string,
  ): void {
    const data = JSON.stringify({
      type: 'web_message',
      groupFolder,
      threadId,
      text,
      timestamp: new Date().toISOString(),
    } satisfies WsServerMessage);
    pushToRingBuffer(data, groupFolder);
    broadcastToWsClients(data, { group: groupFolder });
  }

  return {
    broadcastWs,
    notifyWsSessionStart,
    notifyWsSessionEnd,
    notifyWsSkillInstall,
    broadcastWebMessage,
  };
}
