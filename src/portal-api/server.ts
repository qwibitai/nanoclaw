/**
 * Portal API server — Express-like HTTP server for the Agent Manager Portal.
 * Uses raw Node.js http to avoid adding Express as a dependency.
 */
import { createServer, IncomingMessage, ServerResponse, Server } from 'http';
import { URL } from 'url';

import { logger } from '../logger.js';
import { initPortalDatabase } from './db-portal.js';
import { authenticateRequest, JwtPayload } from './middleware/auth.js';
import { handleAuthRoutes } from './routes/auth.js';
import { handleAgentRoutes } from './routes/agents.js';
import { handleTeamRoutes } from './routes/teams.js';
import { handleKBRoutes } from './routes/kb.js';
import { handleDashboardRoutes } from './routes/dashboard.js';
import { handleLogRoutes } from './routes/logs.js';
import { handleChatRoutes, initChatWebSocket } from './routes/chat.js';
import { handleTicketRoutes } from './routes/tickets.js';
import { ensureDefaultAdmin } from './routes/auth.js';

export interface RequestContext {
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  method: string;
  pathname: string;
  user: JwtPayload | null;
  body: unknown;
}

export type RouteHandler = (ctx: RequestContext) => Promise<void>;

export function json(res: ServerResponse, data: unknown, status = 200): void {
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  });
  res.end(JSON.stringify(data));
}

export function error(
  res: ServerResponse,
  message: string,
  status = 400,
): void {
  json(res, { error: message }, status);
}

async function parseBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf-8');
      if (!raw) {
        resolve(null);
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch {
        resolve(raw);
      }
    });
    req.on('error', () => resolve(null));
  });
}

export function startPortalServer(port: number, host = '0.0.0.0'): Promise<Server> {
  // Initialize portal DB tables
  initPortalDatabase();
  ensureDefaultAdmin();

  return new Promise((resolve, reject) => {
    const server = createServer(async (req, res) => {
      // CORS preflight
      if (req.method === 'OPTIONS') {
        res.writeHead(204, {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type, Authorization',
          'Access-Control-Max-Age': '86400',
        });
        res.end();
        return;
      }

      try {
        const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
        const method = req.method || 'GET';
        const pathname = url.pathname;

        // Only handle /api/* routes
        if (!pathname.startsWith('/api/')) {
          // Serve static files or proxy to Next.js dev server
          res.writeHead(404);
          res.end('Not Found');
          return;
        }

        const body = ['POST', 'PUT', 'PATCH'].includes(method)
          ? await parseBody(req)
          : null;

        const user = authenticateRequest(req);

        const ctx: RequestContext = { req, res, url, method, pathname, user, body };

        // Auth routes (no auth required)
        if (pathname.startsWith('/api/auth')) {
          await handleAuthRoutes(ctx);
          return;
        }

        // All other routes require authentication
        if (!user) {
          error(res, 'Unauthorized', 401);
          return;
        }

        // Route to handlers
        if (pathname.startsWith('/api/agents')) {
          await handleAgentRoutes(ctx);
        } else if (pathname.startsWith('/api/teams')) {
          await handleTeamRoutes(ctx);
        } else if (pathname.startsWith('/api/kb')) {
          await handleKBRoutes(ctx);
        } else if (pathname.startsWith('/api/dashboard')) {
          await handleDashboardRoutes(ctx);
        } else if (pathname.startsWith('/api/logs')) {
          await handleLogRoutes(ctx);
        } else if (pathname.startsWith('/api/chat')) {
          await handleChatRoutes(ctx);
        } else if (pathname.startsWith('/api/tickets')) {
          await handleTicketRoutes(ctx);
        } else {
          error(res, 'Not Found', 404);
        }
      } catch (err) {
        logger.error({ err, url: req.url }, 'Portal API error');
        if (!res.headersSent) {
          error(res, 'Internal Server Error', 500);
        }
      }
    });

    // Initialize WebSocket for chat
    initChatWebSocket(server);

    server.listen(port, host, () => {
      logger.info({ port, host }, 'Portal API server started');
      resolve(server);
    });

    server.on('error', reject);
  });
}
