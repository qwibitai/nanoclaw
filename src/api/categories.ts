/**
 * api/categories.ts — Categories endpoint.
 *
 * Reuses getCategories() from complaint-mcp-server.ts.
 */
import type { Hono } from 'hono';
import type { ApiDeps } from './index.js';
import { getCategories } from '../complaint-mcp-server.js';

export function categoriesRoutes(app: Hono, deps: ApiDeps): void {
  app.get('/api/categories', (c) => {
    const db = deps.db();
    const categories = getCategories(db);
    return c.json({ categories });
  });
}
