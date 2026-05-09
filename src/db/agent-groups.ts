import type { AgentGroup } from '../types.js';
import { getDb } from './connection.js';

export function createAgentGroup(group: AgentGroup): void {
  getDb()
    .prepare(
      `INSERT INTO agent_groups (id, name, folder, agent_provider, created_at)
       VALUES (@id, @name, @folder, @agent_provider, @created_at)`,
    )
    .run(group);
}

export function getAgentGroup(id: string): AgentGroup | undefined {
  return getDb().prepare('SELECT * FROM agent_groups WHERE id = ?').get(id) as AgentGroup | undefined;
}

export function getAgentGroupByFolder(folder: string): AgentGroup | undefined {
  return getDb().prepare('SELECT * FROM agent_groups WHERE folder = ?').get(folder) as AgentGroup | undefined;
}

export function getAllAgentGroups(): AgentGroup[] {
  return getDb().prepare('SELECT * FROM agent_groups ORDER BY name').all() as AgentGroup[];
}

// Returns agent groups sorted by most-recent session activity first (groups
// with no sessions sort last by created_at). Used by the channel-approval
// picker so the operator's active agent is at the top of a long list.
export function getAllAgentGroupsByRecentActivity(): AgentGroup[] {
  return getDb()
    .prepare(
      `SELECT ag.*
         FROM agent_groups ag
         LEFT JOIN (
           SELECT agent_group_id, MAX(COALESCE(last_active, created_at)) AS recency
             FROM sessions
            GROUP BY agent_group_id
         ) s ON s.agent_group_id = ag.id
        ORDER BY COALESCE(s.recency, ag.created_at) DESC`,
    )
    .all() as AgentGroup[];
}

export function updateAgentGroup(id: string, updates: Partial<Pick<AgentGroup, 'name' | 'agent_provider'>>): void {
  const fields: string[] = [];
  const values: Record<string, unknown> = { id };

  for (const [key, value] of Object.entries(updates)) {
    if (value !== undefined) {
      fields.push(`${key} = @${key}`);
      values[key] = value;
    }
  }
  if (fields.length === 0) return;

  getDb()
    .prepare(`UPDATE agent_groups SET ${fields.join(', ')} WHERE id = @id`)
    .run(values);
}

export function deleteAgentGroup(id: string): void {
  getDb().prepare('DELETE FROM agent_groups WHERE id = ?').run(id);
}
