/**
 * Agent CRUD operations for NanoClaw.
 * Thin wrapper around db.ts accessors with convenience helpers.
 */

import { getAllAgents, getAgent, setAgent } from './db.js';
import type { Agent, RegisteredGroup } from './types.js';

export { getAllAgents, getAgent, setAgent };

/**
 * Convert an Agent back to a RegisteredGroup for backwards compatibility.
 * Used during the transition period while both systems coexist.
 */
export function agentToRegisteredGroup(agent: Agent, channelJid: string): RegisteredGroup {
  return {
    name: agent.name,
    folder: agent.folder,
    trigger: '', // Trigger is on the ChannelRoute, not the Agent
    added_at: agent.createdAt,
    containerConfig: agent.containerConfig,
    requiresTrigger: undefined,
    heartbeat: agent.heartbeat,
    discordGuildId: undefined, // Guild ID is on the ChannelRoute
    serverFolder: agent.serverFolder,
    backend: agent.backend,
    description: agent.description,
  };
}

/** Get all cloud (non-local) agent IDs. */
export function getCloudAgentIds(): string[] {
  const agents = getAllAgents();
  return Object.values(agents)
    .filter((a) => !a.isLocal)
    .map((a) => a.id);
}

/** Get the admin agent (isAdmin=true). */
export function getAdminAgent(): Agent | undefined {
  const agents = getAllAgents();
  return Object.values(agents).find((a) => a.isAdmin);
}
