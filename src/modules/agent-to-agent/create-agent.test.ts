import fs from 'fs';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../config.js', async () => {
  const actual = await vi.importActual<typeof import('../../config.js')>('../../config.js');
  return {
    ...actual,
    DATA_DIR: '/tmp/nanoclaw-test-create-agent/data',
    GROUPS_DIR: '/tmp/nanoclaw-test-create-agent/groups',
  };
});

vi.mock('../../container-runner.js', () => ({
  wakeContainer: vi.fn().mockResolvedValue(undefined),
  isContainerRunning: vi.fn().mockReturnValue(false),
  getActiveContainerCount: vi.fn().mockReturnValue(0),
  killContainer: vi.fn(),
}));

import { handleCreateAgent } from './create-agent.js';
import { getDestinationByName } from './db/agent-destinations.js';
import {
  closeDb,
  createAgentGroup,
  createSession,
  getAgentGroupByFolder,
  getDb,
  initTestDb,
  runMigrations,
} from '../../db/index.js';
import { addMember } from '../permissions/db/agent-group-members.js';
import { grantRole } from '../permissions/db/user-roles.js';
import { createUser } from '../permissions/db/users.js';
import { initSessionFolder } from '../../session-manager.js';
import type { Session } from '../../types.js';

const TEST_DIR = '/tmp/nanoclaw-test-create-agent';

function now(): string {
  return new Date().toISOString();
}

function seedSource(agentGroupId: string): Session {
  createAgentGroup({
    id: agentGroupId,
    name: agentGroupId,
    folder: agentGroupId,
    agent_provider: null,
    created_at: now(),
  });
  const session: Session = {
    id: `sess-${agentGroupId}`,
    agent_group_id: agentGroupId,
    messaging_group_id: null,
    thread_id: null,
    agent_provider: null,
    status: 'active',
    container_status: 'stopped',
    last_active: null,
    created_at: now(),
  };
  createSession(session);
  initSessionFolder(agentGroupId, session.id);
  return session;
}

function agentGroupCount(): number {
  return (getDb().prepare('SELECT COUNT(*) AS count FROM agent_groups').get() as { count: number }).count;
}

describe('handleCreateAgent authorization', () => {
  beforeEach(() => {
    if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true, force: true });
    fs.mkdirSync(TEST_DIR, { recursive: true });
    const db = initTestDb();
    runMigrations(db);
  });

  afterEach(() => {
    closeDb();
    if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it('denies create_agent from a member-only source agent without mutating groups or destinations', async () => {
    const session = seedSource('ag-untrusted');
    createUser({ id: 'telegram:member', kind: 'telegram', display_name: 'Member', created_at: now() });
    addMember({ user_id: 'telegram:member', agent_group_id: 'ag-untrusted', added_by: null, added_at: now() });

    await handleCreateAgent({ action: 'create_agent', requestId: 'poc', name: 'Evil Child' }, session);

    expect(agentGroupCount()).toBe(1);
    expect(getAgentGroupByFolder('evil-child')).toBeUndefined();
    expect(getDestinationByName('ag-untrusted', 'evil-child')).toBeUndefined();
  });

  it('denies create_agent from a child group even when a global owner exists elsewhere', async () => {
    const session = seedSource('ag-child');
    createUser({ id: 'telegram:owner', kind: 'telegram', display_name: 'Owner', created_at: now() });
    grantRole({ user_id: 'telegram:owner', role: 'owner', agent_group_id: null, granted_by: null, granted_at: now() });

    await handleCreateAgent({ action: 'create_agent', requestId: 'poc', name: 'Grandchild' }, session);

    expect(agentGroupCount()).toBe(1);
    expect(getAgentGroupByFolder('grandchild')).toBeUndefined();
    expect(getDestinationByName('ag-child', 'grandchild')).toBeUndefined();
  });

  it('allows create_agent from a source group explicitly tied to a global owner', async () => {
    const session = seedSource('ag-owner');
    createUser({ id: 'telegram:owner', kind: 'telegram', display_name: 'Owner', created_at: now() });
    grantRole({ user_id: 'telegram:owner', role: 'owner', agent_group_id: null, granted_by: null, granted_at: now() });
    addMember({ user_id: 'telegram:owner', agent_group_id: 'ag-owner', added_by: null, added_at: now() });

    await handleCreateAgent({ action: 'create_agent', requestId: 'ok', name: 'Trusted Child' }, session);

    const child = getAgentGroupByFolder('trusted-child');
    expect(child).toBeDefined();
    expect(getDestinationByName('ag-owner', 'trusted-child')?.target_id).toBe(child!.id);
    expect(getDestinationByName(child!.id, 'parent')?.target_id).toBe('ag-owner');
  });

  it('allows create_agent from a source group with a scoped admin', async () => {
    const session = seedSource('ag-admin');
    createUser({ id: 'telegram:admin', kind: 'telegram', display_name: 'Admin', created_at: now() });
    grantRole({
      user_id: 'telegram:admin',
      role: 'admin',
      agent_group_id: 'ag-admin',
      granted_by: null,
      granted_at: now(),
    });

    await handleCreateAgent({ action: 'create_agent', requestId: 'ok', name: 'Scoped Admin Child' }, session);

    const child = getAgentGroupByFolder('scoped-admin-child');
    expect(child).toBeDefined();
    expect(getDestinationByName('ag-admin', 'scoped-admin-child')?.target_id).toBe(child!.id);
  });
});
