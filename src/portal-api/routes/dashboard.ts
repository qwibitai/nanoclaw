/**
 * Dashboard routes — stats and activity feed.
 */
import { getDashboardStats, getRecentActivity } from '../db-portal.js';
import { json, RequestContext } from '../server.js';

export async function handleDashboardRoutes(ctx: RequestContext): Promise<void> {
  const { method, pathname, res } = ctx;

  // GET /api/dashboard/stats
  if (method === 'GET' && pathname === '/api/dashboard/stats') {
    const stats = getDashboardStats();
    json(res, stats);
    return;
  }

  // GET /api/dashboard/activity
  if (method === 'GET' && pathname === '/api/dashboard/activity') {
    const limit = parseInt(ctx.url.searchParams.get('limit') || '50', 10);
    const activities = getRecentActivity(limit);
    json(res, activities);
    return;
  }

  json(res, { error: 'Not Found' }, 404);
}
