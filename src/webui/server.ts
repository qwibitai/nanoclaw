import Fastify from 'fastify';
import fastifyWebsocket from '@fastify/websocket';
import fastifyStatic from '@fastify/static';
import fastifyCors from '@fastify/cors';
import path from 'path';

import { WEBUI_HOST, WEBUI_PORT } from '../config.js';
import { logger } from '../logger.js';
import type { GroupQueue } from '../group-queue.js';
import type { Channel, RegisteredGroup } from '../types.js';

import { registerOverviewRoutes } from './api/overview.js';
import { registerChannelRoutes } from './api/channels.js';
import { registerGroupRoutes } from './api/groups.js';
import { registerMessageRoutes } from './api/messages.js';
import { registerTaskRoutes } from './api/tasks.js';
import { registerSessionRoutes } from './api/sessions.js';
import { registerChatRoutes, handleChatWebSocket } from './api/chat.js';
import { registerSkillRoutes } from './api/skills.js';
import { registerConfigRoutes } from './api/config.js';
import { registerLogRoutes } from './api/logs.js';
import { registerDebugRoutes } from './api/debug.js';
import { addClient } from './ws.js';

export interface ServerDeps {
  queue: GroupQueue;
  channels: () => Channel[];
  registeredGroups: () => Record<string, RegisteredGroup>;
}

export async function startWebServer(deps: ServerDeps): Promise<void> {
  const app = Fastify({ logger: false });

  // Plugins
  await app.register(fastifyCors, { origin: true });
  await app.register(fastifyWebsocket);

  // Serve built UI (production)
  const uiDistPath = path.resolve(process.cwd(), 'ui', 'dist');
  try {
    await app.register(fastifyStatic, {
      root: uiDistPath,
      prefix: '/',
      wildcard: false,
    });
  } catch {
    // ui/dist may not exist during development
  }

  // Health check
  app.get('/api/health', async () => ({ status: 'ok', uptime: process.uptime() }));

  // Register all API routes
  registerOverviewRoutes(app, deps);
  registerChannelRoutes(app, deps);
  registerGroupRoutes(app, deps);
  registerMessageRoutes(app);
  registerTaskRoutes(app);
  registerSessionRoutes(app, deps);
  registerChatRoutes(app, deps);
  registerSkillRoutes(app);
  registerConfigRoutes(app);
  registerLogRoutes(app);
  registerDebugRoutes(app, deps);

  // WebSocket endpoint
  app.register(async (wsApp) => {
    wsApp.get('/ws', { websocket: true }, (socket) => {
      addClient(socket);
      handleChatWebSocket(socket, deps);
    });
  });

  // SPA fallback: serve index.html for non-API, non-file routes
  app.setNotFoundHandler(async (req, reply) => {
    if (req.url.startsWith('/api/') || req.url.startsWith('/ws')) {
      return reply.status(404).send({ error: 'Not found' });
    }
    try {
      return reply.sendFile('index.html');
    } catch {
      return reply.status(404).send({ error: 'UI not built. Run: cd ui && npm run build' });
    }
  });

  try {
    await app.listen({ port: WEBUI_PORT, host: WEBUI_HOST });
    logger.info({ port: WEBUI_PORT, host: WEBUI_HOST }, 'WebUI server started');
  } catch (err) {
    logger.error({ err }, 'Failed to start WebUI server');
  }
}
