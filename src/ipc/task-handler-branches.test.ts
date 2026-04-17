/**
 * Targeted tests for the ipc task-handler branches that the existing
 * ipc-auth.test.ts suite didn't hit — update_task recompute paths,
 * switch_model reset / effort / thinking_budget branches, and the
 * refresh_groups authorization path.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  _initTestDatabase,
  createTask,
  getTaskById,
  setRegisteredGroup,
} from '../db.js';
import type { AvailableGroup } from '../container-runner.js';
import type { RegisteredGroup } from '../types.js';

import { processTaskIpc } from './task-handler.js';
import type { IpcDeps } from './types.js';

const MAIN: RegisteredGroup = {
  name: 'Main',
  folder: 'main-group',
  trigger: '',
  added_at: '2026-01-01T00:00:00.000Z',
  isMain: true,
};
const CHILD: RegisteredGroup = {
  name: 'Child',
  folder: 'child-group',
  trigger: '@Andy',
  added_at: '2026-01-01T00:00:00.000Z',
};

let groups: Record<string, RegisteredGroup>;
let sent: Array<[string, string]>;
let deps: IpcDeps;
let availableGroups: AvailableGroup[];
let snapshotCalls: Array<[string, boolean, number, number]>;

beforeEach(() => {
  _initTestDatabase();
  groups = {
    'main@g.us': { ...MAIN },
    'child@g.us': { ...CHILD },
  };
  setRegisteredGroup('main@g.us', groups['main@g.us']);
  setRegisteredGroup('child@g.us', groups['child@g.us']);
  sent = [];
  availableGroups = [];
  snapshotCalls = [];
  deps = {
    sendMessage: async (jid, text) => {
      sent.push([jid, text]);
    },
    registeredGroups: () => groups,
    registerGroup: (jid, group) => {
      groups[jid] = group;
    },
    syncGroups: vi.fn(async () => {}),
    getAvailableGroups: () => availableGroups,
    writeGroupsSnapshot: (folder, isMain, groups, registered) => {
      snapshotCalls.push([folder, isMain, groups.length, registered.size]);
    },
    onTasksChanged: vi.fn(),
  };
});

describe('processTaskIpc — update_task branches', () => {
  it('rejects an invalid cron update without touching the task', async () => {
    createTask({
      id: 't1',
      group_folder: 'main-group',
      chat_jid: 'main@g.us',
      prompt: 'orig',
      schedule_type: 'cron',
      schedule_value: '0 9 * * *',
      context_mode: 'isolated',
      next_run: '2026-12-31T00:00:00.000Z',
      status: 'active',
      created_at: '2026-01-01T00:00:00.000Z',
    });
    await processTaskIpc(
      {
        type: 'update_task',
        taskId: 't1',
        schedule_type: 'cron',
        schedule_value: 'not-a-cron',
      },
      'main-group',
      true,
      deps,
    );
    expect(getTaskById('t1')?.schedule_value).toBe('0 9 * * *');
  });

  it('recomputes next_run for a valid interval update', async () => {
    createTask({
      id: 't1',
      group_folder: 'main-group',
      chat_jid: 'main@g.us',
      prompt: 'orig',
      schedule_type: 'interval',
      schedule_value: '60000',
      context_mode: 'isolated',
      next_run: '2026-12-31T00:00:00.000Z',
      status: 'active',
      created_at: '2026-01-01T00:00:00.000Z',
    });
    const before = Date.now();
    await processTaskIpc(
      {
        type: 'update_task',
        taskId: 't1',
        schedule_type: 'interval',
        schedule_value: '30000',
      },
      'main-group',
      true,
      deps,
    );
    const updated = getTaskById('t1');
    expect(updated?.schedule_value).toBe('30000');
    expect(new Date(updated!.next_run!).getTime()).toBeGreaterThanOrEqual(
      before + 29_000,
    );
  });

  it('setting model to "default" clears it', async () => {
    createTask({
      id: 't1',
      group_folder: 'main-group',
      chat_jid: 'main@g.us',
      prompt: 'orig',
      schedule_type: 'once',
      schedule_value: '2026-12-31T00:00:00',
      context_mode: 'isolated',
      model: 'opus',
      next_run: '2026-12-31T00:00:00.000Z',
      status: 'active',
      created_at: '2026-01-01T00:00:00.000Z',
    });
    await processTaskIpc(
      { type: 'update_task', taskId: 't1', model: 'default' },
      'main-group',
      true,
      deps,
    );
    expect(getTaskById('t1')?.model).toBeNull();
  });
});

describe('processTaskIpc — switch_model branches', () => {
  it('clearing the override when model is "reset" sends a notice', async () => {
    groups['child@g.us'].agentModelOverride = 'opus';
    groups['child@g.us'].agentModelOverrideSetAt = Date.now();
    await processTaskIpc(
      { type: 'switch_model', model: 'reset', chatJid: 'child@g.us' },
      'child-group',
      false,
      deps,
    );
    expect(groups['child@g.us'].agentModelOverride).toBeUndefined();
    expect(groups['child@g.us'].pendingModelNotice).toMatch(/cleared/);
    expect(sent.length).toBeGreaterThan(0);
  });

  it('sets override + pendingModelNotice when the resolved model differs', async () => {
    await processTaskIpc(
      { type: 'switch_model', model: 'opus', chatJid: 'child@g.us' },
      'child-group',
      false,
      deps,
    );
    expect(groups['child@g.us'].agentModelOverride).toBeTruthy();
    expect(groups['child@g.us'].pendingModelNotice).toMatch(/switched/);
  });

  it("rejects switch_model from a group that doesn't own the target", async () => {
    await processTaskIpc(
      { type: 'switch_model', model: 'opus', chatJid: 'main@g.us' },
      'child-group',
      false,
      deps,
    );
    expect(groups['main@g.us'].agentModelOverride).toBeUndefined();
    expect(sent).toEqual([]);
  });

  it('persists effort override via switch_model', async () => {
    await processTaskIpc(
      {
        type: 'switch_model',
        model: 'opus',
        effort: 'high',
        chatJid: 'child@g.us',
      },
      'child-group',
      false,
      deps,
    );
    expect(groups['child@g.us'].effort).toBe('high');
  });

  it('resetting effort clears the field', async () => {
    groups['child@g.us'].effort = 'medium';
    await processTaskIpc(
      {
        type: 'switch_model',
        model: 'opus',
        effort: 'reset',
        chatJid: 'child@g.us',
      },
      'child-group',
      false,
      deps,
    );
    expect(groups['child@g.us'].effort).toBeUndefined();
  });

  it('persists thinking_budget override via switch_model', async () => {
    await processTaskIpc(
      {
        type: 'switch_model',
        model: 'opus',
        thinking_budget: 'adaptive',
        chatJid: 'child@g.us',
      },
      'child-group',
      false,
      deps,
    );
    expect(groups['child@g.us'].thinking_budget).toBe('adaptive');
  });
});

describe('processTaskIpc — refresh_groups', () => {
  it('main group triggers syncGroups + writeGroupsSnapshot', async () => {
    availableGroups = [
      {
        jid: 'a@g.us',
        name: 'A',
        lastActivity: '2026-01-01T00:00:00.000Z',
        isRegistered: false,
      },
    ];
    await processTaskIpc({ type: 'refresh_groups' }, 'main-group', true, deps);
    expect(deps.syncGroups).toHaveBeenCalledWith(true);
    expect(snapshotCalls).toHaveLength(1);
  });

  it('non-main is rejected without calling syncGroups', async () => {
    await processTaskIpc(
      { type: 'refresh_groups' },
      'child-group',
      false,
      deps,
    );
    expect(deps.syncGroups).not.toHaveBeenCalled();
  });
});

describe('processTaskIpc — unknown type', () => {
  it('warns but does not throw', async () => {
    await expect(
      processTaskIpc({ type: 'bogus_type' }, 'main-group', true, deps),
    ).resolves.toBeUndefined();
  });
});
