/**
 * api/stats.ts — Statistics endpoint.
 *
 * Reuses generateSummaryData() from daily-summary.ts and adds
 * resolvedCount and totalAll counts.
 */
import type { Hono } from 'hono';
import type { ApiDeps } from './index.js';
import { generateSummaryData } from '../daily-summary.js';

export function statsRoutes(app: Hono, deps: ApiDeps): void {
  app.get('/api/stats', (c) => {
    const db = deps.db();
    const summary = generateSummaryData(db);

    const resolvedCount = (
      db
        .prepare(`SELECT COUNT(*) as count FROM complaints WHERE status = 'resolved'`)
        .get() as { count: number }
    ).count;

    const totalAll = (
      db.prepare('SELECT COUNT(*) as count FROM complaints').get() as { count: number }
    ).count;

    return c.json({
      ...summary,
      resolvedCount,
      totalAll,
    });
  });
}
