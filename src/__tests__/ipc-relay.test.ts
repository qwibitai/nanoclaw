import { describe, it, expect, vi, beforeEach } from 'vitest';
import { processTaskIpc, IpcDeps } from '../ipc.js';

function makeDeps(
  groups: Record<string, { name: string; folder: string; isMain?: boolean }>,
  overrides: Partial<IpcDeps> = {},
): IpcDeps {
  return {
    sendMessage: vi.fn().mockResolvedValue(undefined),
    registeredGroups: () =>
      Object.fromEntries(
        Object.entries(groups).map(([jid, g]) => [
          jid,
          {
            name: g.name,
            folder: g.folder,
            trigger: '@Andy',
            added_at: new Date().toISOString(),
            isMain: g.isMain,
          },
        ]),
      ),
    registerGroup: vi.fn(),
    syncGroups: vi.fn().mockResolvedValue(undefined),
    getAvailableGroups: () => [],
    writeGroupsSnapshot: vi.fn(),
    onTasksChanged: vi.fn(),
    enqueueEmailTrigger: vi.fn(),
    ...overrides,
  };
}

const GROUPS = {
  'tg:-1001111111111': { name: 'Main Chat', folder: 'telegram_main', isMain: true },
  'tg:-1002222222222': { name: 'Dev Team', folder: 'telegram_dev-team' },
  'dc:3333333333': { name: 'Family Chat', folder: 'discord_family-chat' },
};

describe('relay_message IPC', () => {
  let deps: IpcDeps;

  beforeEach(() => {
    deps = makeDeps(GROUPS);
  });

  it('relays message from main group by display name', async () => {
    await processTaskIpc(
      { type: 'relay_message', targetGroup: 'Dev Team', text: 'Hello dev team!' },
      'telegram_main',
      true,
      deps,
    );

    expect(deps.sendMessage).toHaveBeenCalledWith(
      'tg:-1002222222222',
      'Hello dev team!',
    );
  });

  it('relays message from main group by folder name', async () => {
    await processTaskIpc(
      { type: 'relay_message', targetGroup: 'discord_family-chat', text: 'Hi family!' },
      'telegram_main',
      true,
      deps,
    );

    expect(deps.sendMessage).toHaveBeenCalledWith(
      'dc:3333333333',
      'Hi family!',
    );
  });

  it('matches target group case-insensitively', async () => {
    await processTaskIpc(
      { type: 'relay_message', targetGroup: 'dev team', text: 'lowercase match' },
      'telegram_main',
      true,
      deps,
    );

    expect(deps.sendMessage).toHaveBeenCalledWith(
      'tg:-1002222222222',
      'lowercase match',
    );
  });

  it('blocks relay from non-main group', async () => {
    await processTaskIpc(
      { type: 'relay_message', targetGroup: 'Family Chat', text: 'sneaky message' },
      'telegram_dev-team',
      false,
      deps,
    );

    expect(deps.sendMessage).not.toHaveBeenCalled();
  });

  it('fails gracefully for unknown target group', async () => {
    await processTaskIpc(
      { type: 'relay_message', targetGroup: 'Nonexistent Group', text: 'hello?' },
      'telegram_main',
      true,
      deps,
    );

    expect(deps.sendMessage).not.toHaveBeenCalled();
  });

  it('fails gracefully when text is missing', async () => {
    await processTaskIpc(
      { type: 'relay_message', targetGroup: 'Dev Team' },
      'telegram_main',
      true,
      deps,
    );

    expect(deps.sendMessage).not.toHaveBeenCalled();
  });

  it('fails gracefully when targetGroup is missing', async () => {
    await processTaskIpc(
      { type: 'relay_message', text: 'orphan message' },
      'telegram_main',
      true,
      deps,
    );

    expect(deps.sendMessage).not.toHaveBeenCalled();
  });
});
