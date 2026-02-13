/**
 * api/index.ts — Hono app factory for the admin dashboard REST API.
 *
 * Creates a Hono app with API key auth middleware, error handling,
 * and route registration from sub-modules.
 */
import { Hono } from 'hono';
import type Database from 'better-sqlite3';

import { complaintsRoutes } from './complaints.js';
import { statsRoutes } from './stats.js';
import { usageRoutes } from './usage.js';
import { categoriesRoutes } from './categories.js';

export interface ApiDeps {
  db: () => Database.Database;
}

export function createApiApp(deps: ApiDeps): Hono {
  const app = new Hono();

  if (!process.env.DASHBOARD_API_KEY) {
    console.warn('WARNING: DASHBOARD_API_KEY not set — all API requests will be rejected');
  }

  // API key auth middleware for all /api/* routes
  app.use('/api/*', async (c, next) => {
    const apiKey = c.req.header('X-API-Key');
    if (!apiKey) {
      return c.json({ error: 'API key required' }, 401);
    }
    const expected = process.env.DASHBOARD_API_KEY;
    if (!expected || apiKey !== expected) {
      return c.json({ error: 'Invalid API key' }, 403);
    }
    await next();
  });

  // Error handling middleware
  app.onError((err, c) => {
    const message = err instanceof Error ? err.message : 'Internal server error';
    return c.json({ error: message }, 500);
  });

  // Register routes
  complaintsRoutes(app, deps);
  statsRoutes(app, deps);
  usageRoutes(app, deps);
  categoriesRoutes(app, deps);

  // 404 handler for unmatched /api/* routes
  app.all('/api/*', (c) => {
    return c.json({ error: 'Not found' }, 404);
  });

  return app;
}
