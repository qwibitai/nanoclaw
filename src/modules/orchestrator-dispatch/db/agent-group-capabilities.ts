import { getDb } from '../../../db/connection.js';

export interface CapabilityConfig {
  concurrencyCap: number;
  noProgressTimeoutSec: number;
  spawnDeadlineSec: number;
  drainGraceSec: number;
  targetDenylist?: string[];
}

export function hasOrchestratorCapability(agentGroupId: string): boolean {
  const row = getDb()
    .prepare(`SELECT 1 FROM agent_group_capabilities WHERE agent_group_id = ? AND role = 'orchestrator' LIMIT 1`)
    .get(agentGroupId);
  return row !== undefined;
}

export function grantCapability(
  agentGroupId: string,
  role: 'orchestrator',
  config: CapabilityConfig,
  grantedBy: string,
): void {
  const configJson = JSON.stringify(config);
  const grantedAt = new Date().toISOString();
  getDb()
    .prepare(
      `INSERT INTO agent_group_capabilities (agent_group_id, role, config_json, granted_by, granted_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(agent_group_id, role) DO UPDATE SET
         config_json = excluded.config_json,
         granted_by  = excluded.granted_by,
         granted_at  = excluded.granted_at`,
    )
    .run(agentGroupId, role, configJson, grantedBy, grantedAt);
}

export function revokeCapability(agentGroupId: string, role: 'orchestrator'): { success: boolean; reason?: string } {
  const inFlight = getDb()
    .prepare(
      `SELECT 1 FROM tasks
        WHERE parent_agent_group_id = ? AND status IN ('pending', 'running')
        LIMIT 1`,
    )
    .get(agentGroupId);

  if (inFlight !== undefined) {
    return { success: false, reason: 'tasks_in_flight' };
  }

  getDb().prepare(`DELETE FROM agent_group_capabilities WHERE agent_group_id = ? AND role = ?`).run(agentGroupId, role);

  return { success: true };
}

export function getCapabilityConfig(agentGroupId: string, role: string): CapabilityConfig | null {
  const row = getDb()
    .prepare(`SELECT config_json FROM agent_group_capabilities WHERE agent_group_id = ? AND role = ?`)
    .get(agentGroupId, role) as { config_json: string | null } | undefined;

  if (!row) return null;
  if (!row.config_json) return null;

  return JSON.parse(row.config_json) as CapabilityConfig;
}
