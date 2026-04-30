/**
 * Baget-specific lookups + mutations on agent_groups. Lives in its own file
 * (not folded into agent-groups.ts) so the upstream rebase surface stays
 * small — non-Baget installs never touch these helpers.
 *
 * The functions here are the only callsites that read/write the
 * `user_id` / `company_id` / `archived_at` columns added in migration 014.
 */
import type { AgentGroup } from '../types.js';
import { getDb } from './connection.js';

/**
 * Look up the Baget agent_group for a given (userId, companyId). Returns
 * undefined when the founder hasn't been provisioned yet — the admin
 * server uses this to decide between INSERT and refresh-prompt-only.
 *
 * Includes archived rows on purpose: a re-pair by the same founder after
 * a previous DELETE should resurrect the soft-deleted row (clear
 * archived_at, mint a fresh token) rather than create a stranded second
 * row with the same (userId, companyId) — which the partial UNIQUE
 * index would reject anyway.
 */
export function getBagetAgentGroup(userId: string, companyId: string): AgentGroup | undefined {
  return getDb().prepare('SELECT * FROM agent_groups WHERE user_id = ? AND company_id = ?').get(userId, companyId) as
    | AgentGroup
    | undefined;
}

/**
 * Create a Baget-provisioned agent_group. Throws on a duplicate
 * (userId, companyId) — the caller (admin server) catches it and falls
 * back to the refresh path.
 */
export function createBagetAgentGroup(group: {
  id: string;
  name: string;
  folder: string;
  user_id: string;
  company_id: string;
  agent_provider?: string | null;
  baget_team_members: string;
  created_at: string;
}): void {
  getDb()
    .prepare(
      `INSERT INTO agent_groups
         (id, name, folder, agent_provider, user_id, company_id, baget_team_members, created_at)
       VALUES (@id, @name, @folder, @agent_provider, @user_id, @company_id, @baget_team_members, @created_at)`,
    )
    .run({
      id: group.id,
      name: group.name,
      folder: group.folder,
      agent_provider: group.agent_provider ?? null,
      user_id: group.user_id,
      company_id: group.company_id,
      baget_team_members: group.baget_team_members,
      created_at: group.created_at,
    });
}

/**
 * Update the per-founder team-name JSON on an existing row. Called by
 * the admin server's refresh-prompt route when the founder renames a
 * team member.
 */
export function updateBagetTeamMembers(id: string, teamMembersJson: string): void {
  getDb().prepare('UPDATE agent_groups SET baget_team_members = ? WHERE id = ?').run(teamMembersJson, id);
}

/** Fetch by id — central DB returns the row even when archived. */
export function getBagetAgentGroupById(id: string): import('../types.js').AgentGroup | undefined {
  return getDb().prepare('SELECT * FROM agent_groups WHERE id = ?').get(id) as
    | import('../types.js').AgentGroup
    | undefined;
}

/**
 * Soft-delete: stamp `archived_at`. Does NOT cascade to messaging_groups
 * or sessions — message history is preserved deliberately. The admin
 * DELETE endpoint follows up with `unbindBagetMessagingGroups` to drop
 * the chat→agent wiring so future inbound messages on the bound chat
 * fall through the router's no-agent path.
 */
export function archiveBagetAgentGroup(id: string, archivedAt: string): void {
  getDb().prepare('UPDATE agent_groups SET archived_at = ? WHERE id = ?').run(archivedAt, id);
}

/** Clear `archived_at` — used by re-provision-after-archive. */
export function unarchiveBagetAgentGroup(id: string): void {
  getDb().prepare('UPDATE agent_groups SET archived_at = NULL WHERE id = ?').run(id);
}

/**
 * Drop every `messaging_group_agents` row that wires a chat to this
 * agent_group. Used by `DELETE /baget/agent-groups/:groupId` to make
 * sure post-archive DMs from the founder's chat fall through the
 * router's no-agent path instead of waking a soft-deleted runner.
 *
 * Returns the number of rows dropped — 0 is fine (founder may never
 * have completed pairing).
 */
export function unbindMessagingGroupsForAgent(agentGroupId: string): number {
  const r = getDb().prepare('DELETE FROM messaging_group_agents WHERE agent_group_id = ?').run(agentGroupId);
  return r.changes;
}
