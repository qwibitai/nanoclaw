/**
 * api/usage.ts — Usage tracking endpoint.
 *
 * Reuses getUsageStats() from usage-monitor.ts.
 */
import type { Hono } from 'hono';
import type { ApiDeps } from './index.js';
import { getUsageStats } from '../usage-monitor.js';

export function usageRoutes(app: Hono, deps: ApiDeps): void {
  app.get('/api/usage', (c) => {
    const db = deps.db();
    const date = c.req.query('date') || new Date().toISOString().slice(0, 10);
    const stats = getUsageStats(db, date);
    return c.json({ date, ...stats });
  });
}
