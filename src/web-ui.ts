/**
 * Web UI — API gateway for NanoClaw.
 *
 * Single HTTP server: serves HTML, streams progress events via SSE,
 * handles REST API endpoints, WebSocket connections, and optional
 * static file serving for the bundled SPA.
 *
 * When WEB_UI_TOKEN is set, binds to 0.0.0.0 (public) and requires token auth.
 * When unset, binds to 127.0.0.1 (local only, no auth).
 */
import crypto from 'crypto';
import { createServer, IncomingMessage, Server, ServerResponse } from 'http';
import fs from 'fs';
import path from 'path';
import { URL } from 'url';

import { getCapabilities, CapabilityDeps } from './api/capabilities.js';
import { handleCors } from './api/cors.js';
import { handleRoute, RouteDeps } from './api/routes.js';
import { initWebSocket, WsDeps } from './api/ws.js';
import type { ActiveSession, AuthUser, Capabilities } from './api/types.js';
import { getOrCreateJwtSecret, parseCookieToken, verifyJwt } from './auth.js';
import { getUserById, getUserGroups, hasAnyUsers } from './db.js';
import { logger } from './logger.js';
import type { ProgressEvent } from './container-runner.js';

// --- SSE client tracking ---

const MAX_SSE_CONNECTIONS = 100;
const clients = new Set<ServerResponse>();
const activeSessions = new Map<string, ActiveSession>();

// --- Static file serving (bundled mode) ---

/** MIME types for static file serving. */
const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html',
  '.js': 'application/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.map': 'application/json',
};

/** Detect nanoclaw-ui dist directory at startup (once). */
let uiDistPath: string | null = null;
try {
  // Try require.resolve-style lookup
  const candidates = [
    path.resolve(process.cwd(), 'nanoclaw-ui', 'dist'),
    path.resolve(process.cwd(), 'node_modules', 'nanoclaw-ui', 'dist'),
  ];
  for (const candidate of candidates) {
    if (
      fs.existsSync(candidate) &&
      fs.existsSync(path.join(candidate, 'index.html'))
    ) {
      uiDistPath = candidate;
      break;
    }
  }
} catch {
  // Package not found — uiDistPath stays null
}

/** Check if a filename contains a hash (e.g., main.a1b2c3.js). */
function isHashedAsset(filename: string): boolean {
  const parts = filename.split('.');
  // Hashed assets have at least 3 parts: name.hash.ext
  return parts.length >= 3 && parts[parts.length - 2].length >= 6;
}

// --- Auth ---

interface WebUIDeps {
  sendMessage: (
    groupJid: string,
    threadId: string | undefined,
    text: string,
  ) => boolean;
  getRegisteredGroups: () => Array<{
    jid: string;
    name: string;
    folder: string;
  }>;
  startSession: (groupJid: string, text: string) => boolean;
  startSessionWs: (
    groupJid: string,
    text: string,
    senderName: string,
    senderId: string,
    threadId?: string,
  ) => string | false;
  resumeGateApproval?: (gateId: string) => Promise<void>;
}

export interface WebUIHandle {
  server: Server;
  broadcast: (
    sessionKey: string,
    group: string,
    threadId: string | undefined,
    event: ProgressEvent,
  ) => void;
  notifySessionStart: (
    sessionKey: string,
    group: string,
    groupJid: string,
    threadId?: string,
  ) => void;
  notifySessionEnd: (sessionKey: string) => void;
  broadcastWebMessage: (
    groupFolder: string,
    threadId: string | undefined,
    text: string,
  ) => void;
}

/**
 * Check auth. Returns:
 *  - AuthUser if a valid JWT cookie is present (cockpit login)
 *  - true if legacy WEB_UI_TOKEN is valid (only when no users exist in DB)
 *  - false if no valid auth found
 *
 * When users exist in DB, legacy token auth is disabled — JWT only.
 */
export async function checkAuth(
  req: IncomingMessage,
  token: string,
): Promise<AuthUser | boolean> {
  // 1. Try JWT cookie first
  const cookieHeader = req.headers.cookie;
  const cookieToken = parseCookieToken(cookieHeader);
  if (cookieToken) {
    try {
      const secret = getOrCreateJwtSecret();
      const payload = verifyJwt(cookieToken, secret);
      if (payload) {
        const user = getUserById(payload.userId);
        if (user) {
          const groups = getUserGroups(user.id);
          return {
            id: user.id,
            username: user.username,
            role: user.role,
            groups,
          } satisfies AuthUser;
        }
      }
    } catch {
      // JWT error — fall through to legacy check
    }
  }

  // 2. Legacy token check — disabled once users exist
  if (hasAnyUsers()) {
    // Users are configured — require JWT, reject legacy tokens
    return false;
  }

  if (!token) return true; // No token configured = no auth required (localhost-only mode)
  const url = new URL(
    req.url || '/',
    `http://${req.headers.host || 'localhost'}`,
  );
  const queryToken = url.searchParams.get('token') || '';
  if (timingSafeCompare(queryToken, token)) return true;
  const authHeader = req.headers.authorization || '';
  if (timingSafeCompare(authHeader, `Bearer ${token}`)) return true;

  return false;
}

/** Returns true if the auth result represents an admin (JWT user with admin role or legacy true). */
export function requireAdmin(auth: AuthUser | true): boolean {
  if (auth === true) return true;
  return auth.role === 'admin';
}

/** Returns true if the auth result grants access to the given group folder.
 *  Admins and legacy-token users bypass group checks. */
export function requireGroupAccess(
  auth: AuthUser | true,
  groupFolder: string,
): boolean {
  if (auth === true) return true;
  if (auth.role === 'admin') return true;
  return auth.groups.includes(groupFolder);
}

/** Constant-time string comparison. Uses the expected value's length to avoid leaking length info. */
function timingSafeCompare(a: string, b: string): boolean {
  const bufB = Buffer.from(b);
  const bufA = a.length === b.length ? Buffer.from(a) : bufB;
  const match = crypto.timingSafeEqual(bufA, bufB);
  return match && a.length === b.length;
}

function rejectAuth(res: ServerResponse): void {
  res.writeHead(401, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Unauthorized' }));
}

// --- SSE broadcast ---

const SSE_BACKPRESSURE_THRESHOLD = 1_048_576; // 1MB

/** Send data to all SSE clients, disconnecting any that exceed the backpressure threshold. */
function broadcastToSseClients(
  sseClients: Set<ServerResponse>,
  data: string,
): void {
  for (const res of sseClients) {
    if (res.writableLength > SSE_BACKPRESSURE_THRESHOLD) {
      sseClients.delete(res);
      res.end();
      continue;
    }
    res.write(`data: ${data}\n\n`);
  }
}

function broadcastSse(
  sessionKey: string,
  group: string,
  threadId: string | undefined,
  event: ProgressEvent,
): void {
  if (clients.size === 0) return;
  const data = JSON.stringify({
    type: 'progress',
    group,
    threadId,
    sessionKey,
    event,
  });
  broadcastToSseClients(clients, data);
}

function notifySessionStartSse(
  sessionKey: string,
  group: string,
  groupJid: string,
  threadId?: string,
): void {
  activeSessions.set(sessionKey, {
    group,
    groupJid,
    threadId,
    startedAt: new Date().toISOString(),
  });
  if (clients.size === 0) return;
  const data = JSON.stringify({
    type: 'session_start',
    sessionKey,
    group,
    groupJid,
    threadId,
  });
  broadcastToSseClients(clients, data);
}

function notifySessionEndSse(sessionKey: string): void {
  activeSessions.delete(sessionKey);
  if (clients.size === 0) return;
  const data = JSON.stringify({ type: 'session_end', sessionKey });
  broadcastToSseClients(clients, data);
}

function addSseClient(res: ServerResponse, req: IncomingMessage): void {
  if (clients.size >= MAX_SSE_CONNECTIONS) {
    res.writeHead(503, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Too many SSE connections' }));
    return;
  }
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  res.write(
    `data: ${JSON.stringify({ type: 'sessions', sessions: Object.fromEntries(activeSessions) })}\n\n`,
  );
  clients.add(res);
  req.on('close', () => clients.delete(res));
}

// --- Static file serving ---

function serveStaticFile(pathname: string, res: ServerResponse): boolean {
  if (!uiDistPath) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        error:
          'nanoclaw-ui package not installed. Install it to enable the web UI.',
      }),
    );
    return true;
  }

  // Strip /ui prefix
  let filePath = pathname.replace(/^\/ui\/?/, '');
  if (!filePath) filePath = 'index.html';

  // Resolve and verify within dist directory (prevent path traversal)
  const resolved = path.resolve(uiDistPath, filePath);
  if (!resolved.startsWith(uiDistPath)) {
    res.writeHead(400, { 'Content-Type': 'text/plain' });
    res.end('Bad request');
    return true;
  }

  // Try to serve the file
  if (fs.existsSync(resolved) && fs.statSync(resolved).isFile()) {
    const ext = path.extname(resolved);
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';
    const filename = path.basename(resolved);

    const headers: Record<string, string> = {
      'Content-Type': contentType,
    };

    // Cache headers: immutable for hashed assets, no-cache for index.html
    if (filename === 'index.html') {
      headers['Cache-Control'] = 'no-cache';
    } else if (isHashedAsset(filename)) {
      headers['Cache-Control'] = 'public, max-age=31536000, immutable';
    } else {
      headers['Cache-Control'] = 'public, max-age=3600';
    }

    res.writeHead(200, headers);
    fs.createReadStream(resolved).pipe(res);
    return true;
  }

  // SPA fallback: serve index.html for unmatched /ui/* paths
  const indexPath = path.join(uiDistPath, 'index.html');
  if (fs.existsSync(indexPath)) {
    res.writeHead(200, {
      'Content-Type': 'text/html',
      'Cache-Control': 'no-cache',
    });
    fs.createReadStream(indexPath).pipe(res);
    return true;
  }

  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('Not found');
  return true;
}

// --- Server startup ---

export function startWebUI(
  port: number,
  deps: WebUIDeps,
  token: string,
): Promise<WebUIHandle> {
  // Build capabilities deps
  const capDeps: CapabilityDeps = {
    getRegisteredGroups: deps.getRegisteredGroups,
  };

  const getCapabilitiesFn = (): Capabilities => getCapabilities(capDeps);

  // WebSocket notification functions (set after initWebSocket)
  let broadcastWs: (
    sessionKey: string,
    group: string,
    event: unknown,
  ) => void = () => {};
  let notifyWsSessionStart: (
    sessionKey: string,
    group: string,
    groupJid: string,
    threadId?: string,
  ) => void = () => {};
  let notifyWsSessionEnd: (sessionKey: string) => void = () => {};
  let notifyWsSkillInstall: (
    jobId: string,
    output: string,
    status: 'running' | 'completed' | 'failed',
  ) => void = () => {};

  // Route deps
  const routeDeps: RouteDeps = {
    sendMessage: deps.sendMessage,
    getRegisteredGroups: deps.getRegisteredGroups,
    startSession: deps.startSession,
    getCapabilities: getCapabilitiesFn,
    activeSessions: () => activeSessions,
    addSseClient,
    onSkillInstallProgress: (jobId, output) =>
      notifyWsSkillInstall(jobId, output, 'running'),
    onSkillInstallComplete: (jobId, success) =>
      notifyWsSkillInstall(jobId, '', success ? 'completed' : 'failed'),
    resumeGateApproval: deps.resumeGateApproval,
  };

  const server = createServer((req, res) => {
    // Security headers on every response
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');

    const url = new URL(
      req.url || '/',
      `http://${req.headers.host || 'localhost'}`,
    );
    const pathname = url.pathname;

    // CORS runs first on all requests
    if (handleCors(req, res)) return; // Was a preflight OPTIONS — already handled

    // Redirect / to /ui/
    if (pathname === '/' && req.method === 'GET') {
      res.writeHead(301, { Location: '/ui/' });
      res.end();
      return;
    }

    // Static file serving for bundled SPA (unauthenticated)
    if (pathname === '/ui' || pathname.startsWith('/ui/')) {
      // Redirect /ui to /ui/
      if (pathname === '/ui') {
        res.writeHead(301, { Location: '/ui/' });
        res.end();
        return;
      }
      serveStaticFile(pathname, res);
      return;
    }

    // Auth-exempt endpoints (must be reachable before any user exists)
    const authExempt =
      pathname === '/api/auth/setup' ||
      pathname === '/api/auth/setup-status' ||
      pathname === '/api/auth/login';

    // Auth check on all API endpoints (async — JWT requires async check)
    checkAuth(req, token)
      .then((authResult) => {
        if (!authResult && !authExempt) {
          rejectAuth(res);
          return;
        }
        // For auth-exempt routes with no auth, pass true so route
        // handlers don't reject. The route itself enforces its own rules.
        const effectiveAuth = authResult || true;
        return handleRoute(
          pathname,
          req.method || 'GET',
          url,
          req,
          res,
          routeDeps,
          effectiveAuth,
        );
      })
      .then((handled) => {
        if (handled === false) {
          res.writeHead(404, { 'Content-Type': 'text/plain' });
          res.end('Not found');
        }
      })
      .catch((err) => {
        logger.error({ err }, 'Route handler error');
        if (!res.headersSent) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Internal server error' }));
        }
      });
  });

  // Bind publicly when token is set (authenticated), localhost-only otherwise
  const bindAddress = token ? '0.0.0.0' : '127.0.0.1';

  return new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(port, bindAddress, () => {
      // Initialize WebSocket after server is listening
      const wsDeps: WsDeps = {
        checkAuth,
        getCapabilities: getCapabilitiesFn,
        startSession: (groupJid, text, senderName, senderId, threadId) =>
          deps.startSessionWs(groupJid, text, senderName, senderId, threadId),
      };
      const wsHandlers = initWebSocket(server, wsDeps, token);
      broadcastWs = wsHandlers.broadcastWs;
      notifyWsSessionStart = wsHandlers.notifyWsSessionStart;
      notifyWsSessionEnd = wsHandlers.notifyWsSessionEnd;
      notifyWsSkillInstall = wsHandlers.notifyWsSkillInstall;

      logger.info(
        {
          port,
          bindAddress,
          authEnabled: !!token,
          bundledUi: !!uiDistPath,
        },
        'Web UI started',
      );

      // Unified broadcast/notify that forward to both SSE and WS clients
      const broadcast = (
        sessionKey: string,
        group: string,
        threadId: string | undefined,
        event: ProgressEvent,
      ): void => {
        broadcastSse(sessionKey, group, threadId, event);
        broadcastWs(sessionKey, group, event);
      };

      const notifySessionStart = (
        sessionKey: string,
        group: string,
        groupJid: string,
        threadId?: string,
      ): void => {
        notifySessionStartSse(sessionKey, group, groupJid, threadId);
        notifyWsSessionStart(sessionKey, group, groupJid, threadId);
      };

      const notifySessionEnd = (sessionKey: string): void => {
        notifySessionEndSse(sessionKey);
        notifyWsSessionEnd(sessionKey);
      };

      resolve({
        server,
        broadcast,
        notifySessionStart,
        notifySessionEnd,
        broadcastWebMessage: wsHandlers.broadcastWebMessage,
      });
    });
  });
}
