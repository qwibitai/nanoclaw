import { describe, it, expect, afterEach } from 'vitest';
import {
  grantCapability,
  revokeCapability,
  hasOrchestratorCapability,
  getCapabilityConfig,
  type CapabilityConfig,
} from './agent-group-capabilities.js';
import { initTestDb, closeDb, runMigrations, createAgentGroup } from '../../../db/index.js';
import { getDb } from '../../../db/connection.js';

function createUser(id: string): void {
  getDb()
    .prepare(`INSERT INTO users (id, kind, created_at) VALUES (?, 'system', ?)`)
    .run(id, new Date().toISOString());
}

function now(): string {
  return new Date().toISOString();
}

afterEach(() => {
  closeDb();
});

function setupDb(): void {
  const db = initTestDb();
  db.pragma('foreign_keys = ON');
  runMigrations(db);
}

const defaultConfig: CapabilityConfig = {
  concurrencyCap: 5,
  noProgressTimeoutSec: 1800,
  spawnDeadlineSec: 300,
  drainGraceSec: 120,
};

describe('agent-group-capabilities CRUD', () => {
  it('test_grant_then_has_capability', () => {
    setupDb();
    createUser('user-system');
    createAgentGroup({ id: 'ag-x', name: 'X', folder: 'x', agent_provider: null, created_at: now() });

    grantCapability('ag-x', 'orchestrator', defaultConfig, 'user-system');
    expect(hasOrchestratorCapability('ag-x')).toBe(true);
  });

  it('test_has_capability_false_when_absent', () => {
    setupDb();
    createAgentGroup({ id: 'ag-y', name: 'Y', folder: 'y', agent_provider: null, created_at: now() });

    expect(hasOrchestratorCapability('ag-y')).toBe(false);
  });

  it('test_revoke_blocks_when_tasks_in_flight', () => {
    setupDb();
    createUser('user-system');
    createAgentGroup({ id: 'ag-x', name: 'X', folder: 'x', agent_provider: null, created_at: now() });
    createAgentGroup({ id: 'ag-target', name: 'Target', folder: 'target', agent_provider: null, created_at: now() });
    grantCapability('ag-x', 'orchestrator', defaultConfig, 'user-system');

    const db = getDb();
    db.exec(`INSERT INTO sessions (id, agent_group_id, created_at) VALUES ('sess-x', 'ag-x', '${now()}')`);
    db.exec(`
      INSERT INTO tasks (
        task_id, idempotency_key, parent_session_id, parent_agent_group_id,
        target_agent_group_id, task_content, request_hash, admitted_at, status, created_at
      ) VALUES ('t1', 'k1', 'sess-x', 'ag-x', 'ag-target', 'content', 'hash', '${now()}', 'running', '${now()}')
    `);

    const result = revokeCapability('ag-x', 'orchestrator');
    expect(result).toEqual({ success: false, reason: 'tasks_in_flight' });
    expect(hasOrchestratorCapability('ag-x')).toBe(true);
  });

  it('test_revoke_succeeds_when_no_tasks_in_flight', () => {
    setupDb();
    createUser('user-system');
    createAgentGroup({ id: 'ag-x', name: 'X', folder: 'x', agent_provider: null, created_at: now() });
    grantCapability('ag-x', 'orchestrator', defaultConfig, 'user-system');

    const result = revokeCapability('ag-x', 'orchestrator');
    expect(result).toEqual({ success: true });
    expect(hasOrchestratorCapability('ag-x')).toBe(false);
  });

  it('test_get_config_returns_parsed', () => {
    setupDb();
    createUser('user-system');
    createAgentGroup({ id: 'ag-x', name: 'X', folder: 'x', agent_provider: null, created_at: now() });

    const cfg: CapabilityConfig = {
      concurrencyCap: 7,
      noProgressTimeoutSec: 900,
      spawnDeadlineSec: 120,
      drainGraceSec: 60,
    };
    grantCapability('ag-x', 'orchestrator', cfg, 'user-system');

    const returned = getCapabilityConfig('ag-x', 'orchestrator');
    expect(returned).not.toBeNull();
    expect(returned!.concurrencyCap).toBe(7);
    expect(returned!.noProgressTimeoutSec).toBe(900);
  });

  it('test_grant_is_idempotent', () => {
    setupDb();
    createUser('user-system');
    createAgentGroup({ id: 'ag-x', name: 'X', folder: 'x', agent_provider: null, created_at: now() });

    grantCapability('ag-x', 'orchestrator', defaultConfig, 'user-system');
    const cfg2: CapabilityConfig = {
      concurrencyCap: 10,
      noProgressTimeoutSec: 600,
      spawnDeadlineSec: 120,
      drainGraceSec: 60,
    };
    expect(() => grantCapability('ag-x', 'orchestrator', cfg2, 'user-system')).not.toThrow();

    const returned = getCapabilityConfig('ag-x', 'orchestrator');
    expect(returned!.concurrencyCap).toBe(10);
  });
});
