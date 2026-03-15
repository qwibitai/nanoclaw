/**
 * Activity log routes.
 */
import { getActivityLog, getRecentActivity } from '../db-portal.js';
import { json, RequestContext } from '../server.js';

export async function handleLogRoutes(ctx: RequestContext): Promise<void> {
  const { method, pathname, res } = ctx;

  // GET /api/logs
  if (method === 'GET' && pathname === '/api/logs') {
    const agentId = ctx.url.searchParams.get('agent_id') || undefined;
    const limit = parseInt(ctx.url.searchParams.get('limit') || '100', 10);
    const offset = parseInt(ctx.url.searchParams.get('offset') || '0', 10);

    const activities = getActivityLog({ agent_id: agentId, limit, offset });
    json(res, activities);
    return;
  }

  json(res, { error: 'Not Found' }, 404);
}
