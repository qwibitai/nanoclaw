/**
 * Channel routing for NanoClaw.
 * Maps channel JIDs to agents. Multiple channels can route to the same agent.
 */

import { getAllChannelRoutes, getChannelRoute, getRoutesForAgent, setChannelRoute } from './db.js';
import type { Agent, ChannelRoute } from './types.js';

export { getAllChannelRoutes, getChannelRoute, getRoutesForAgent, setChannelRoute };

/**
 * Resolve which agent should handle a message from a given channel JID.
 * Returns the agent ID, or undefined if no route exists.
 */
export function resolveAgentForChannel(
  channelJid: string,
  routes: Record<string, ChannelRoute>,
): string | undefined {
  const route = routes[channelJid];
  return route?.agentId;
}

/**
 * Get all channel JIDs that route to a given agent.
 */
export function getChannelJidsForAgent(
  agentId: string,
  routes: Record<string, ChannelRoute>,
): string[] {
  return Object.values(routes)
    .filter((r) => r.agentId === agentId)
    .map((r) => r.channelJid);
}

/**
 * Build a reverse map: agentId → [channelJids].
 */
export function buildAgentToChannelsMap(
  routes: Record<string, ChannelRoute>,
): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const route of Object.values(routes)) {
    const existing = map.get(route.agentId);
    if (existing) {
      existing.push(route.channelJid);
    } else {
      map.set(route.agentId, [route.channelJid]);
    }
  }
  return map;
}
