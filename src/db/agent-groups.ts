import type { AgentGroup } from '../types.js';
import { getDb } from './connection.js';

export function createAgentGroup(group: AgentGroup): void {
  getDb()
    .prepare(
      `INSERT INTO agent_groups (id, name, folder, agent_provider, model, created_at, metadata)
       VALUES (@id, @name, @folder, @agent_provider, @model, @created_at, @metadata)`,
    )
    .run({ ...group, metadata: group.metadata ?? null });
}

/**
 * Read the agent_groups.metadata JSON blob as an object. Missing or malformed
 * blobs return an empty object — callers should treat metadata as best-effort.
 */
export function getAgentGroupMetadata(id: string): Record<string, unknown> {
  const row = getDb().prepare('SELECT metadata FROM agent_groups WHERE id = ?').get(id) as
    | { metadata: string | null }
    | undefined;
  if (!row?.metadata) return {};
  try {
    const parsed = JSON.parse(row.metadata) as Record<string, unknown>;
    return typeof parsed === 'object' && parsed !== null ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * Merge a single key into the agent_groups.metadata JSON blob. Read-modify-write,
 * not safe under concurrent writers — but in practice only the host's delivery
 * thread mutates this, and then only on rare events (pairing, self-mod approval).
 */
export function setAgentGroupMetadataKey(id: string, key: string, value: unknown): void {
  const current = getAgentGroupMetadata(id);
  current[key] = value;
  getDb().prepare('UPDATE agent_groups SET metadata = ? WHERE id = ?').run(JSON.stringify(current), id);
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

export function updateAgentGroup(
  id: string,
  updates: Partial<Pick<AgentGroup, 'name' | 'agent_provider' | 'model'>>,
): void {
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
