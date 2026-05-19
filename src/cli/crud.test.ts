import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// `groups.ts`'s postCreate calls `initGroupFilesystem`, which touches the
// real filesystem (groups/<folder>, data/v2-sessions/<id>/.claude-shared).
// We're not testing the filesystem layout here — we're testing that the
// hook fires with the inserted row — so mock the FS-touching helper and
// keep only the DB side effect (`ensureContainerConfig`) as the observable.
const ensureContainerConfigSpy = vi.fn();
vi.mock('../group-init.js', async () => {
  const { ensureContainerConfig } = await import('../db/container-configs.js');
  return {
    initGroupFilesystem: vi.fn((group: { id: string }) => {
      ensureContainerConfigSpy(group.id);
      ensureContainerConfig(group.id);
    }),
  };
});

vi.mock('../log.js', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { initTestDb, closeDb, runMigrations, createAgentGroup, createMessagingGroup } from '../db/index.js';
import { getContainerConfig } from '../db/container-configs.js';
import { getDestinations } from '../modules/agent-to-agent/db/agent-destinations.js';
import { lookup } from './registry.js';

// Importing these for side effects: each calls `registerResource` at
// module top-level, which wires up the `groups-create` / `wirings-create`
// handlers we exercise below.
import '../cli/resources/groups.js';
import '../cli/resources/wirings.js';

const hostCtx = { caller: 'host' as const };

beforeEach(() => {
  const db = initTestDb();
  runMigrations(db);
  ensureContainerConfigSpy.mockClear();
});

afterEach(() => {
  closeDb();
});

describe('genericCreate postCreate hook', () => {
  it('groups-create writes the companion container_configs row', async () => {
    const cmd = lookup('groups-create');
    expect(cmd, 'groups-create command must be registered').toBeDefined();

    const result = (await cmd!.handler({ name: 'Test', folder: 'test' }, hostCtx)) as { id: string };

    // Hook fired with the just-inserted row (incl. generated `id`).
    expect(ensureContainerConfigSpy).toHaveBeenCalledWith(result.id);

    // Visible side effect: container_configs row exists for the new group.
    // Without postCreate, this was empty and the first spawn threw
    // "Container config not found" — issue #2415.
    const config = getContainerConfig(result.id);
    expect(config).toBeDefined();
    expect(config!.agent_group_id).toBe(result.id);
  });

  it('wirings-create writes the companion agent_destinations row', async () => {
    // Seed the FKs that the wiring references.
    createAgentGroup({
      id: 'ag-1',
      name: 'Agent One',
      folder: 'agent-one',
      agent_provider: null,
      created_at: new Date().toISOString(),
    });
    createMessagingGroup({
      id: 'mg-1',
      channel_type: 'discord',
      platform_id: 'channel-123',
      name: 'general',
      is_group: 1,
      unknown_sender_policy: 'strict',
      created_at: new Date().toISOString(),
    });

    const cmd = lookup('wirings-create');
    expect(cmd, 'wirings-create command must be registered').toBeDefined();

    await cmd!.handler({ messaging_group_id: 'mg-1', agent_group_id: 'ag-1' }, hostCtx);

    // Visible side effect: a destination row was created so the agent can
    // address this chat as a delivery target. Without postCreate, this was
    // empty and the agent's replies were silently dropped by the delivery
    // ACL — issue #2389.
    const destinations = getDestinations('ag-1');
    expect(destinations).toHaveLength(1);
    expect(destinations[0].target_type).toBe('channel');
    expect(destinations[0].target_id).toBe('mg-1');
  });
});
