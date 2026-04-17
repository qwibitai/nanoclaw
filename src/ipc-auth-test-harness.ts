import { _initTestDatabase, setRegisteredGroup } from './db.js';
import type { IpcDeps } from './ipc.js';
import type { RegisteredGroup } from './types.js';

export const MAIN_GROUP: RegisteredGroup = {
  name: 'Main',
  folder: 'whatsapp_main',
  trigger: 'always',
  added_at: '2024-01-01T00:00:00.000Z',
  isMain: true,
};

export const OTHER_GROUP: RegisteredGroup = {
  name: 'Other',
  folder: 'other-group',
  trigger: '@Andy',
  added_at: '2024-01-01T00:00:00.000Z',
};

export const THIRD_GROUP: RegisteredGroup = {
  name: 'Third',
  folder: 'third-group',
  trigger: '@Andy',
  added_at: '2024-01-01T00:00:00.000Z',
};

export interface IpcAuthHarness {
  groups: Record<string, RegisteredGroup>;
  deps: IpcDeps;
}

/**
 * Build the fixture set used by every ipc-auth test: three registered
 * groups (main / other / third), a persistent DB row per group, and an
 * {@link IpcDeps} whose callbacks keep the in-memory map in sync.
 */
export function buildIpcAuthHarness(): IpcAuthHarness {
  _initTestDatabase();

  const groups: Record<string, RegisteredGroup> = {
    'main@g.us': MAIN_GROUP,
    'other@g.us': OTHER_GROUP,
    'third@g.us': THIRD_GROUP,
  };

  setRegisteredGroup('main@g.us', MAIN_GROUP);
  setRegisteredGroup('other@g.us', OTHER_GROUP);
  setRegisteredGroup('third@g.us', THIRD_GROUP);

  const deps: IpcDeps = {
    sendMessage: async () => {},
    registeredGroups: () => groups,
    registerGroup: (jid, group) => {
      groups[jid] = group;
      setRegisteredGroup(jid, group);
    },
    syncGroups: async () => {},
    getAvailableGroups: () => [],
    writeGroupsSnapshot: () => {},
    onTasksChanged: () => {},
  };

  return { groups, deps };
}
