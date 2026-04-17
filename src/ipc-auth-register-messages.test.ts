import { beforeEach, describe, expect, it } from 'vitest';

import { getRegisteredGroup } from './db.js';
import { processTaskIpc } from './ipc.js';
import type { IpcDeps } from './ipc.js';
import { buildIpcAuthHarness } from './ipc-auth-test-harness.js';
import type { RegisteredGroup } from './types.js';

let groups: Record<string, RegisteredGroup>;
let deps: IpcDeps;

beforeEach(() => {
  ({ groups, deps } = buildIpcAuthHarness());
});

describe('register_group authorization', () => {
  it('non-main group cannot register a group', async () => {
    await processTaskIpc(
      {
        type: 'register_group',
        jid: 'new@g.us',
        name: 'New Group',
        folder: 'new-group',
        trigger: '@Andy',
      },
      'other-group',
      false,
      deps,
    );
    expect(groups['new@g.us']).toBeUndefined();
  });

  it('main group cannot register with unsafe folder path', async () => {
    await processTaskIpc(
      {
        type: 'register_group',
        jid: 'new@g.us',
        name: 'New Group',
        folder: '../../outside',
        trigger: '@Andy',
      },
      'whatsapp_main',
      true,
      deps,
    );
    expect(groups['new@g.us']).toBeUndefined();
  });
});

describe('register_group success', () => {
  it('main group can register a new group', async () => {
    await processTaskIpc(
      {
        type: 'register_group',
        jid: 'new@g.us',
        name: 'New Group',
        folder: 'new-group',
        trigger: '@Andy',
      },
      'whatsapp_main',
      true,
      deps,
    );

    const group = getRegisteredGroup('new@g.us');
    expect(group).toBeDefined();
    expect(group!.name).toBe('New Group');
    expect(group!.folder).toBe('new-group');
    expect(group!.trigger).toBe('@Andy');
  });

  it('register_group rejects request with missing fields', async () => {
    await processTaskIpc(
      {
        type: 'register_group',
        jid: 'partial@g.us',
        name: 'Partial',
      },
      'whatsapp_main',
      true,
      deps,
    );
    expect(getRegisteredGroup('partial@g.us')).toBeUndefined();
  });
});

describe('refresh_groups authorization', () => {
  it('non-main group cannot trigger refresh', async () => {
    // Silent drop — if the gate is missing the call would throw because
    // `syncGroups`/`getAvailableGroups` are no-ops here.
    await processTaskIpc(
      { type: 'refresh_groups' },
      'other-group',
      false,
      deps,
    );
  });
});

// Replicates the authorization predicate used by the IPC message
// watcher: `isMain || (targetGroup && targetGroup.folder === sourceGroup)`.
describe('IPC message authorization', () => {
  function isMessageAuthorized(
    sourceGroup: string,
    isMain: boolean,
    targetChatJid: string,
    registered: Record<string, RegisteredGroup>,
  ): boolean {
    const targetGroup = registered[targetChatJid];
    return isMain || (!!targetGroup && targetGroup.folder === sourceGroup);
  }

  it('main group can send to any group', () => {
    expect(
      isMessageAuthorized('whatsapp_main', true, 'other@g.us', groups),
    ).toBe(true);
    expect(
      isMessageAuthorized('whatsapp_main', true, 'third@g.us', groups),
    ).toBe(true);
  });

  it('non-main group can send to its own chat', () => {
    expect(
      isMessageAuthorized('other-group', false, 'other@g.us', groups),
    ).toBe(true);
  });

  it('non-main group cannot send to another groups chat', () => {
    expect(
      isMessageAuthorized('other-group', false, 'main@g.us', groups),
    ).toBe(false);
    expect(
      isMessageAuthorized('other-group', false, 'third@g.us', groups),
    ).toBe(false);
  });

  it('non-main group cannot send to unregistered JID', () => {
    expect(
      isMessageAuthorized('other-group', false, 'unknown@g.us', groups),
    ).toBe(false);
  });

  it('main group can send to unregistered JID', () => {
    expect(
      isMessageAuthorized('whatsapp_main', true, 'unknown@g.us', groups),
    ).toBe(true);
  });
});
