/**
 * Ticket routes — proxy to Vivantio API for ticket data.
 * When Vivantio is not configured, returns mock data.
 */
import { getActivityLog, getAllAgents } from '../db-portal.js';
import { json, error, RequestContext } from '../server.js';

export async function handleTicketRoutes(ctx: RequestContext): Promise<void> {
  const { method, pathname, res } = ctx;

  // GET /api/tickets
  if (method === 'GET' && pathname === '/api/tickets') {
    // Return ticket activity from portal activity log (agent perspective)
    const activities = getActivityLog({ limit: 200 });
    const ticketActivities = activities.filter(
      (a) => a.ticket_id || a.action_type.includes('ticket') || a.action_type.includes('triage'),
    );

    // Group by ticket
    const ticketMap = new Map<string, {
      ticket_id: number;
      ticket_display_id: string;
      agent_id: string;
      client_id: number | null;
      actions: typeof ticketActivities;
      last_action: string;
    }>();

    for (const activity of ticketActivities) {
      const key = String(activity.ticket_id || activity.ticket_display_id || activity.id);
      if (!ticketMap.has(key)) {
        ticketMap.set(key, {
          ticket_id: activity.ticket_id || 0,
          ticket_display_id: activity.ticket_display_id || key,
          agent_id: activity.agent_id,
          client_id: activity.client_id,
          actions: [],
          last_action: activity.created_at,
        });
      }
      ticketMap.get(key)!.actions.push(activity);
    }

    json(res, Array.from(ticketMap.values()));
    return;
  }

  // GET /api/tickets/:id
  const ticketMatch = pathname.match(/^\/api\/tickets\/([^/]+)$/);
  if (method === 'GET' && ticketMatch) {
    const ticketId = ticketMatch[1];
    const activities = getActivityLog({ limit: 500 });
    const ticketActivities = activities.filter(
      (a) =>
        String(a.ticket_id) === ticketId ||
        a.ticket_display_id === ticketId,
    );

    if (ticketActivities.length === 0) {
      error(res, 'Ticket not found', 404);
      return;
    }

    json(res, {
      ticket_id: ticketId,
      activities: ticketActivities,
    });
    return;
  }

  error(res, 'Not Found', 404);
}
